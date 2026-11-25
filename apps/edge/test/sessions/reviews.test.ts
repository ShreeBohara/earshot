// The tray's reviews in SessionDO (Phase 5 spec §4.2, WP3): `review` and `snooze` are checked with
// the writers' rules against the session's own proposals, filled in with the pinned user, the
// ticket's sign-in, and the sync time, appended as `proposal.reviewed` v2 and `proposal.snoozed`,
// and idempotent by msgId and by review id. Without a usable audit key, reviews fail closed. A
// later witness flag on an approval reopens it.

import { scenario } from "@earshot/agent/testing";
import {
  type ClientMessageOf,
  type ProposalCreatedV2,
  ProposalReviewedV3,
  ProposalSnoozedV1,
  UNDO_WINDOW_MS,
  type UtteranceFinalV2,
  uuidv7,
} from "@earshot/core";
import { defaultProjections, replay } from "@earshot/events";
import { describe, expect, it } from "vitest";
import { evalScenario } from "../../src/e2e-scenario";
import { parseRange } from "../../src/flush-message";
import { SEAL_TIMING } from "../../src/session/limits";
import {
  ANTHROPIC,
  breakAuditKey,
  canaryKey,
  dumpStorage,
  endMessage,
  freezeClock,
  meta,
  open,
  reviewInput,
  reviewMessage,
  snoozeMessage,
  startMessage,
  type TestSocket,
  turnEndMessage,
  useCassette,
  utteranceMessage,
  withSql,
} from "./helpers";

const SIGN_IN = { method: "passkey" as const, at: new Date("2026-11-20T08:12:40.000Z") };

/** Runs one of the demo's scenario turns; resolves with the proposals it created. */
async function demoTurn(socket: TestSocket, name: string): Promise<ProposalCreatedV2[]> {
  const { turn } = scenario("anthropic", name);
  const before = socket.eventsOf("proposal.created").length;
  for (const utterance of turn.utterances) {
    await socket.request(utteranceMessage(turn.turnId, utterance));
  }
  await socket.request(turnEndMessage(turn.turnId, canaryKey(), ANTHROPIC), 15_000);
  return socket
    .eventsOf("proposal.created")
    .slice(before)
    .map((event) => event.payload as unknown as ProposalCreatedV2);
}

/** A started session with the demo's proposals: a linked deal update, and a task that asks. */
async function withProposals(options: { signIn?: typeof SIGN_IN } = {}) {
  const opened = await open(undefined, -1, options);
  await opened.socket.request(startMessage());
  const proposals = [
    ...(await demoTurn(opened.socket, "demo-turn-3")),
    ...(await demoTurn(opened.socket, "demo-turn-4")),
  ];
  const linked = proposals.find((p) => p.target.decision === "linked");
  const asked = proposals.find((p) => p.target.decision === "ask");
  if (!linked || !asked) throw new Error("the demo turns no longer give a linked and an ask");
  return { ...opened, linked, asked };
}

const reviewsIn = (socket: TestSocket) =>
  socket.eventsOf("proposal.reviewed").map((event) => ProposalReviewedV3.parse(event.payload));

describe("review", () => {
  it("appends proposal.reviewed v3 with the user, the ticket's sign-in, and the sync time", async () => {
    const { socket, stub, ids, linked } = await withProposals({ signIn: SIGN_IN });
    const now = Date.now();
    await freezeClock(stub, now);
    const input = reviewInput(linked.proposalId);
    const ack = await socket.request(reviewMessage(input));

    const [event] = socket.eventsOf("proposal.reviewed");
    // v3 since Phase 6 WP1: every writer writes the latest version.
    expect(event?.schemaVersion).toBe(3);
    expect(ack.seq).toBe(event?.seq);
    expect(ProposalReviewedV3.parse(event?.payload)).toEqual({
      ...input,
      syncEligibleAt: new Date(now + UNDO_WINDOW_MS).toISOString(),
      by: {
        userId: ids.uid,
        auth: { method: "passkey", signedInAt: "2026-11-20T08:12:40.000Z" },
      },
    });
    socket.close();
  });

  it("records auth: null for a ticket without the sign-in claims, and no sync time for a rejection", async () => {
    const { socket, ids, asked } = await withProposals();
    await socket.request(reviewMessage(reviewInput(asked.proposalId, { decision: "rejected" })));
    expect(reviewsIn(socket)).toMatchObject([
      { decision: "rejected", syncEligibleAt: null, by: { userId: ids.uid, auth: null } },
    ]);
    socket.close();
  });

  it("is idempotent by msgId and by review id, and refuses an id reused for another proposal", async () => {
    const { socket, stub, linked, asked } = await withProposals();
    const message = reviewMessage(reviewInput(linked.proposalId));
    const first = await socket.request(message);

    // The same message again: the same answer, nothing new.
    const before = socket.received.length;
    socket.send(message);
    await socket.waitFor(
      (m) => socket.received.indexOf(m) >= before && m.t === "ack" && m.msgId === message.msgId,
    );
    // The same review under a new msgId: the first one's seq.
    const again = await socket.request(reviewMessage(...message.reviews));
    expect(again.seq).toBe(first.seq);
    expect(socket.eventsOf("proposal.reviewed")).toHaveLength(1);

    // Its id for another proposal: refused.
    const reused = reviewMessage(
      reviewInput(asked.proposalId, {
        reviewId: message.reviews[0]?.reviewId ?? "",
        decision: "rejected",
      }),
    );
    socket.send(reused);
    expect(await socket.error(reused.msgId)).toMatchObject({
      code: "bad_message",
      retryable: false,
    });
    expect(
      parseRange(await stub.readRange(0, 99)).filter((e) => e.type === "proposal.reviewed"),
    ).toHaveLength(1);
    socket.close();
  });

  it("refuses what the writers' rules refuse, appending nothing", async () => {
    const { socket, stub, linked, asked } = await withProposals();
    const refused = async (message: ClientMessageOf<"review">) => {
      socket.send(message);
      expect(await socket.error(message.msgId)).toMatchObject({
        code: "bad_message",
        retryable: false,
      });
    };
    // An ask approved without one of its records.
    await refused(reviewMessage(reviewInput(asked.proposalId)));
    // A record the proposal never offered.
    await refused(reviewMessage(reviewInput(asked.proposalId, { target: { entityId: "co_999" } })));
    // A batch item with a marker (the ask's own flag).
    await refused(
      reviewMessage(
        reviewInput(asked.proposalId, {
          mode: "batch",
          batchId: uuidv7(),
          target: { entityId: asked.target.candidates[0]?.entityId ?? null },
        }),
      ),
    );
    // A reopen of a review that isn't the proposal's latest.
    await refused(
      reviewMessage(
        reviewInput(linked.proposalId, {
          decision: "reopened",
          undoes: uuidv7(),
          reason: "undo",
        }),
      ),
    );
    // One bad review refuses the whole message.
    await refused(reviewMessage(reviewInput(linked.proposalId), reviewInput(asked.proposalId)));
    expect(
      parseRange(await stub.readRange(0, 99)).some((e) => e.type === "proposal.reviewed"),
    ).toBe(false);

    // And the same proposals pass once the rules are kept: an approval choosing a candidate,
    // then an undo naming it.
    const chosen = reviewInput(asked.proposalId, {
      target: { entityId: asked.target.candidates[0]?.entityId ?? null },
    });
    await socket.request(reviewMessage(chosen));
    await socket.request(
      reviewMessage(
        reviewInput(asked.proposalId, {
          decision: "reopened",
          undoes: chosen.reviewId,
          reason: "undo",
        }),
      ),
    );
    const log = parseRange(await stub.readRange(0, 99)).map((event) => ({
      ...event,
      sessionId: socket.events()[0]?.sessionId ?? "",
    }));
    const { proposals } = replay(log, defaultProjections);
    expect(proposals.find((p) => p.proposalId === asked.proposalId)?.status).toBe("proposed");
    socket.close();
  });

  it("takes reviews after end, each restarting the seal's grace, until the seal", async () => {
    const { socket, stub, linked, asked } = await withProposals();
    const t0 = Date.now();
    await freezeClock(stub, t0);
    await socket.request(endMessage());
    expect(Number((await meta(stub)).seal_due_ms)).toBe(t0 + SEAL_TIMING.graceMs);
    await freezeClock(stub, t0 + 45_000);
    await socket.request(reviewMessage(reviewInput(linked.proposalId)));
    expect(reviewsIn(socket)).toHaveLength(1);
    expect(Number((await meta(stub)).seal_due_ms)).toBe(t0 + 45_000 + SEAL_TIMING.graceMs);

    // Sealed, the next review is refused for good: the tray sends it to the web route.
    expect(await stub.sealNow()).toBe("sealing");
    const late = reviewMessage(reviewInput(asked.proposalId, { decision: "rejected" }));
    socket.send(late);
    expect(await socket.error(late.msgId)).toMatchObject({ code: "sealed", retryable: false });
    socket.close();
  });

  it("refuses a review before start, retryably", async () => {
    const { socket } = await open();
    const message = reviewMessage(reviewInput(uuidv7()));
    socket.send(message);
    expect(await socket.error(message.msgId)).toMatchObject({
      code: "not_started",
      retryable: true,
    });
    socket.close();
  });

  it("fails closed without a usable audit key: review refused with internal, snooze still taken", async () => {
    const { socket, stub, linked } = await withProposals();
    await breakAuditKey(stub, true);
    const message = reviewMessage(reviewInput(linked.proposalId));
    socket.send(message);
    expect(await socket.error(message.msgId)).toMatchObject({
      code: "internal",
      retryable: false,
    });
    expect(socket.eventsOf("proposal.reviewed")).toEqual([]);
    await socket.request(snoozeMessage(linked.proposalId));
    expect(socket.eventsOf("proposal.snoozed")).toHaveLength(1);
    await breakAuditKey(stub, false);
    socket.close();
  });

  it("never stores a key-shaped string sent in a review", async () => {
    const { socket, stub, linked } = await withProposals();
    const key = canaryKey();
    const message = reviewMessage(
      reviewInput(linked.proposalId, {
        decision: "edited",
        editDiff: { title: { before: "x", after: key } },
      }),
    );
    socket.send(message);
    expect(await socket.error(message.msgId)).toMatchObject({ code: "bad_message" });
    expect(await dumpStorage(stub)).not.toContain(key);
    socket.close();
  });
});

describe("snooze", () => {
  it("appends proposal.snoozed with the reviewer, idempotent by snooze id, and wakes", async () => {
    const { socket, ids, linked } = await withProposals({ signIn: SIGN_IN });
    const message = snoozeMessage(linked.proposalId);
    const first = await socket.request(message);
    const again = await socket.request({ ...message, msgId: uuidv7() });
    expect(again.seq).toBe(first.seq);
    await socket.request(snoozeMessage(linked.proposalId, null));
    const snoozes = socket
      .eventsOf("proposal.snoozed")
      .map((event) => ProposalSnoozedV1.parse(event.payload));
    expect(snoozes).toEqual([
      {
        snoozeId: message.snoozeId,
        proposalId: linked.proposalId,
        until: "2026-11-21T09:00:00.000Z",
        by: {
          userId: ids.uid,
          auth: { method: "passkey", signedInAt: "2026-11-20T08:12:40.000Z" },
        },
      },
      expect.objectContaining({ until: null }),
    ]);

    // A snooze of a decided proposal defers nothing: refused.
    await socket.request(reviewMessage(reviewInput(linked.proposalId)));
    const late = snoozeMessage(linked.proposalId);
    socket.send(late);
    expect(await socket.error(late.msgId)).toMatchObject({ code: "bad_message" });
    socket.close();
  });
});

// ─── Decision 15: a later flag reopens an approval ───────────────────────────────────────────────

const D003 = evalScenario("d003");
if (!D003) throw new Error("no eval script d003");
const SAID = D003.turns[0]?.text ?? "";
const MISHEARD = SAID.replace("Atmos Industrial", "Atmo Systems");

function timed<W extends "biased" | "unbiased">(text: string, witness: W) {
  const words = text.split(" ").map((w, i) => ({
    w,
    startMs: 2_000 + i * 350,
    endMs: 2_000 + i * 350 + 300,
    confidence: 0.9,
  }));
  const utterance: UtteranceFinalV2 & { witness: W } = {
    utteranceId: uuidv7(),
    text,
    confidence: 0.9,
    words,
    startMs: 2_000,
    endMs: words.at(-1)?.endMs ?? 2_000,
    witness,
  };
  return utterance;
}

describe("a flag after an approval", () => {
  it("reopens it: proposal.flagged, then a system reopen naming the approval, then turn.witnessed", {
    timeout: 30_000,
  }, async () => {
    const { socket, stub, ids } = await open();
    await useCassette(stub, "d003");
    await socket.request(
      startMessage({
        startedAt: D003.startedAt,
        timeZone: D003.timeZone,
        entities: D003.entities.map((entity) => ({ ...entity, aliases: [...entity.aliases] })),
        ...(D003.focusEntityId ? { focusEntityId: D003.focusEntityId } : {}),
      }),
    );
    const turnId = uuidv7();
    await socket.request(utteranceMessage(turnId, timed(SAID, "biased")));
    await socket.request(turnEndMessage(turnId, canaryKey()), 15_000);
    const created = socket.eventsOf("proposal.created")[0]?.payload as unknown as ProposalCreatedV2;
    const approval = reviewInput(created.proposalId);
    await socket.request(reviewMessage(approval));

    const witness: ClientMessageOf<"witness"> = {
      t: "witness",
      msgId: uuidv7(),
      turnId,
      provider: "groq",
      model: "whisper-large-v3-turbo",
      outcome: "transcribed",
      utterance: timed(MISHEARD, "unbiased"),
      latencyMs: 812,
    };
    await socket.request(witness);
    const events = socket.events();
    const witnessed = events.findIndex(
      (event) => event.type === "utterance.final" && event.payload.witness === "unbiased",
    );
    expect(events.slice(witnessed).map((event) => event.type)).toEqual([
      "utterance.final",
      "proposal.flagged",
      "proposal.reviewed",
      "turn.witnessed",
    ]);
    const reopen = ProposalReviewedV3.parse(events[witnessed + 2]?.payload);
    expect(reopen).toMatchObject({
      proposalId: created.proposalId,
      decision: "reopened",
      mode: "system",
      reason: "flagged",
      undoes: approval.reviewId,
      target: null,
      input: "none",
      surface: "session",
      syncEligibleAt: null,
      timing: { decisionMs: 0, handlingMs: 0 },
      by: { userId: ids.uid, auth: null },
      // What the proposal is after the flag: a question, marked.
      seen: { tier: "loud", target: { entityId: null }, relinked: null, clip: "none" },
    });
    const log = parseRange(await stub.readRange(0, 99)).map((event) => ({
      ...event,
      sessionId: events[0]?.sessionId ?? "",
    }));
    const { proposals } = replay(log, defaultProjections);
    expect(proposals[0]).toMatchObject({ status: "proposed", review: { mode: "system" } });
    // The reopen's id is recorded, so the same id can't be used again for another review.
    const recorded = await withSql(stub, (sql) =>
      sql.exec("SELECT kind FROM writes WHERE id = ?", reopen.reviewId).toArray(),
    );
    expect(recorded).toEqual([{ kind: "review" }]);
    socket.close();
  });
});
