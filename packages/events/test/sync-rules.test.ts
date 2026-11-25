import {
  ProposalSyncConflictedV1,
  ProposalSyncedV1,
  ProposalSyncFailedV1,
  ProposalSyncStartedV1,
} from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  checkSyncEvent,
  defaultProjections,
  replay,
  type SyncEventInput,
  type SyncRefusal,
} from "../src";
import {
  type EventBody,
  ended,
  proposalV2,
  reopen,
  reviewV2,
  sealed,
  sessionLog,
  started,
  syncConflicted,
  synced,
  syncFailed,
  syncReopen,
  syncStarted,
  utterance,
  uuid,
} from "./helpers";

/**
 * A sealed session's proposals, as the outbox sees them when it appends (job `uuid(0xa000 + n)`
 * syncs review `uuid(7000 + n)` of proposal `uuid(3000 + n)`):
 * 1. approved, never synced;
 * 2. edited, never synced;
 * 3. rejected;
 * 4. approved, then undone (review uuid(7104), the latest);
 * 5. approved, and job 5 is syncing it;
 * 6. approved and synced;
 * 7. approved, and job 7's attempt failed, retryable;
 * 8. approved, and job 8's attempt failed for good;
 * 9. approved, and job 9's attempt conflicted, and the sync reopened it;
 * 10. approved, then superseded by 11.
 */
const bodies: EventBody[] = [
  started(),
  utterance(1),
  ...Array.from({ length: 10 }, (_, i) => proposalV2(i + 1)),
  reviewV2(1),
  reviewV2(2, "edited"),
  reviewV2(3, "rejected"),
  reviewV2(4),
  reopen(4, uuid(7004)),
  reviewV2(5),
  reviewV2(6),
  reviewV2(7),
  reviewV2(8),
  reviewV2(9),
  reviewV2(10),
  proposalV2(11, {}, { supersedes: uuid(3010) }),
  ended(),
  sealed(),
  syncStarted(5),
  syncStarted(6),
  synced(6),
  syncStarted(7),
  syncFailed(7),
  syncStarted(8),
  syncFailed(8, { kind: "validation", code: "VALIDATION_ERROR", field: "title", retryable: false }),
  syncStarted(9),
  syncConflicted(9),
  syncReopen(9, uuid(7009)),
];
const { proposals, session } = replay(sessionLog(bodies), defaultProjections);
/** A session that ended and isn't sealed yet. */
const unsealed = replay(sessionLog([started(), ended()]), defaultProjections).session;

/** A builder's sync event, checked against its schema: the rules start past it. */
function input(body: EventBody): SyncEventInput {
  switch (body.type) {
    case "proposal.sync_started":
      return { type: body.type, payload: ProposalSyncStartedV1.parse(body.payload) };
    case "proposal.synced":
      return { type: body.type, payload: ProposalSyncedV1.parse(body.payload) };
    case "proposal.sync_failed":
      return { type: body.type, payload: ProposalSyncFailedV1.parse(body.payload) };
    case "proposal.sync_conflicted":
      return { type: body.type, payload: ProposalSyncConflictedV1.parse(body.payload) };
    default:
      throw new Error(`${body.type} isn't a sync event`);
  }
}

const hubspot = { provider: "hubspot", connectionId: uuid(0xc0) };

describe("the fixture", () => {
  it("folds to the states the tables below rely on", () => {
    expect(session?.sealedAt).not.toBeNull();
    expect(unsealed?.sealedAt).toBeNull();
    const at = (n: number) => proposals.find((proposal) => proposal.proposalId === uuid(3000 + n));
    expect(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [n, at(n)?.status, at(n)?.sync?.state]),
    ).toEqual([
      [1, "approved", undefined],
      [2, "edited", undefined],
      [3, "rejected", undefined],
      [4, "proposed", undefined],
      [5, "approved", "syncing"],
      [6, "synced", "synced"],
      [7, "failed", "failed"],
      [8, "failed", "failed"],
      [9, "proposed", "conflicted"],
      [10, "superseded", undefined],
    ]);
  });
});

describe("checkSyncEvent accepts", () => {
  it.each<[string, EventBody]>([
    ["a start for the latest approval", syncStarted(1)],
    ["a start for the latest edit", syncStarted(2)],
    [
      "a start on a connected CRM, with a mapping",
      syncStarted(1, {
        ...hubspot,
        mapping: { version: 2, sha256: "a".repeat(64) },
      }),
    ],
    ["a Retry's start after a retryable failure", syncStarted(7, { attempt: 2 })],
    [
      "a Retry's start that skips an attempt the sweep failed before its claim",
      syncStarted(7, { attempt: 4 }),
    ],
    [
      "a new job's start, once the reviewer approved again after a conflict",
      syncStarted(9, { jobId: uuid(0xa109), reviewId: uuid(7409) }),
    ],
    ["a success for the attempt syncing", synced(5)],
    [
      "a failure for it, with a field a refused value names",
      syncFailed(5, {
        kind: "validation",
        code: "VALIDATION_ERROR",
        field: "title",
        retryable: false,
        landed: [{ object: "note", id: "n1", url: "https://app.hubspot.com/contacts/1/note/n1" }],
      }),
    ],
    ["a conflict for it: the record is gone", syncConflicted(5, { cause: "gone", fields: {} })],
    [
      "a conflict for it: the person exists",
      syncConflicted(5, {
        cause: "duplicate",
        fields: {},
        existing: { object: "contact", id: "51", url: "http://localhost:3000/object/person/51" },
      }),
    ],
  ])("%s", (_, body) => {
    const reapproved = reviewV2(9, "approved", { reviewId: uuid(7409) });
    const state =
      body.payload.reviewId === uuid(7409)
        ? replay(sessionLog([...bodies, reapproved]), defaultProjections).proposals
        : proposals;
    const check = checkSyncEvent(state, session, input(body));
    expect(check).toMatchObject({ ok: true });
    expect(check.ok && check.proposal.review?.reviewId).toBe(body.payload.reviewId);
  });
});

describe("checkSyncEvent refuses", () => {
  it.each<[string, EventBody, SyncRefusal]>([
    [
      "a start for a review that isn't the latest (the reviewer undid it)",
      syncStarted(4),
      "not_latest",
    ],
    [
      "a start for a review no proposal has",
      syncStarted(1, { reviewId: uuid(7999) }),
      "not_latest",
    ],
    ["a start for a rejection", syncStarted(3), "not_approved"],
    ["a start for a proposal a correction replaced", syncStarted(10), "superseded"],
    ["a second start while one is syncing", syncStarted(5, { jobId: uuid(0xa105) }), "syncing"],
    ["the same start again, while it's syncing", syncStarted(5), "syncing"],
    ["a start after the job synced", syncStarted(6, { attempt: 2 }), "not_retryable"],
    ["a Retry's start after a failure for good", syncStarted(8, { attempt: 2 }), "not_retryable"],
    ["a Retry's start that repeats the failed attempt", syncStarted(7), "not_retryable"],
    [
      "a start after the job conflicted",
      syncStarted(9, { attempt: 2, reviewId: uuid(7309) }),
      "not_approved",
    ],
    [
      "a start of the review under another job",
      syncStarted(7, { jobId: uuid(0xa107), attempt: 2 }),
      "malformed",
    ],
    ["a Retry's start on another CRM", syncStarted(7, { ...hubspot, attempt: 2 }), "malformed"],
    [
      "a start on the demo CRM with a connection",
      syncStarted(1, { connectionId: uuid(0xc0) }),
      "malformed",
    ],
    [
      "a start on a connected CRM without one",
      syncStarted(1, { provider: "hubspot" }),
      "malformed",
    ],
    ["a result for an attempt that never started", synced(1), "unknown_attempt"],
    [
      "a result for another attempt than the one syncing",
      synced(5, { attempt: 2 }),
      "unknown_attempt",
    ],
    ["a second result for one attempt", synced(6), "settled"],
    ["a failure after the attempt failed", syncFailed(7), "settled"],
    [
      "a result naming another review than its start",
      synced(5, { reviewId: uuid(7006) }),
      "malformed",
    ],
    ["a result naming another CRM than its start", synced(5, { provider: "twenty" }), "malformed"],
    [
      "a success naming one write twice",
      synced(5, {
        records: [
          { write: 0, op: "created", ref: { object: "note", id: "1", url: null } },
          { write: 0, op: "found", ref: { object: "note", id: "2", url: null } },
        ],
      }),
      "malformed",
    ],
    [
      "a record whose link isn't http or https",
      synced(5, {
        records: [
          { write: 0, op: "created", ref: { object: "note", id: "1", url: "javascript:alert(1)" } },
        ],
      }),
      "malformed",
    ],
    ["a failure naming a field its kind doesn't", syncFailed(5, { field: "title" }), "malformed"],
    [
      "a failure quoting the CRM's message",
      syncFailed(5, {
        kind: "duplicate",
        code: "Contact already exists. Existing ID: 1201",
      }),
      "malformed",
    ],
    ["a moved conflict with no field", syncConflicted(5, { fields: {} }), "malformed"],
    ["a gone conflict listing fields", syncConflicted(5, { cause: "gone" }), "malformed"],
    [
      "an existing record on a conflict that isn't a duplicate",
      syncConflicted(5, {
        existing: { object: "contact", id: "51", url: null },
      }),
      "malformed",
    ],
  ])("%s", (_, body, reason) => {
    expect(checkSyncEvent(proposals, session, input(body))).toMatchObject({ ok: false, reason });
  });

  it("refuses every sync event in a session that isn't sealed, or that it doesn't know", () => {
    for (const body of [syncStarted(1), synced(5), syncFailed(5), syncConflicted(5)]) {
      expect(checkSyncEvent(proposals, unsealed, input(body))).toMatchObject({
        ok: false,
        reason: "unsealed",
      });
      expect(checkSyncEvent(proposals, null, input(body))).toMatchObject({
        ok: false,
        reason: "unsealed",
      });
    }
  });
});

describe("checkSyncEvent and the fold agree", () => {
  it("each event it accepts folds, and the fold refuses a start or result it refuses", () => {
    // What it accepts, the fold takes: a log grown one accepted event at a time replays.
    const grown = [
      ...bodies,
      syncStarted(1),
      synced(1),
      syncStarted(7, { attempt: 2 }),
      syncConflicted(7, { attempt: 2 }),
    ];
    expect(() => replay(sessionLog(grown), defaultProjections)).not.toThrow();
    // The worst it refuses, the fold refuses again.
    for (const bad of [synced(1), synced(6), syncStarted(4), syncStarted(3)]) {
      expect(() => replay(sessionLog([...bodies, bad]), defaultProjections)).toThrow();
    }
  });
});
