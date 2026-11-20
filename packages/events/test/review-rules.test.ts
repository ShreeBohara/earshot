import { ProposalReviewedV2, ProposalSnoozedV1 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  checkReview,
  checkReviews,
  checkSnooze,
  type ProposalView,
  proposalsProjection,
  type ReviewRefusal,
  type ReviewRuleContext,
  replay,
} from "../src";
import {
  anyFlagTier,
  type EventBody,
  proposalV2,
  REVIEWER,
  reopen,
  reviewV2,
  sessionLog,
  snoozed,
  started,
  utterance,
  uuid,
} from "./helpers";

const unflagged = { riskFlags: [] };

/**
 * The session's proposals, as the writers see them:
 * 1. linked to uuid(6001), with uuid(6002) among its candidates, unmarked;
 * 2. an ask between uuid(6001), uuid(6002), and a new record, marked;
 * 3. a new record, with uuid(6003) a candidate, marked;
 * 4. no record, unmarked;
 * 5. approved (review uuid(7005));
 * 6. superseded by 7, which is linked and unmarked;
 * 8. approved, then reopened (review uuid(7108), the latest);
 * 9. rejected (review uuid(7009));
 * 10. a new record, unmarked.
 */
const proposals: readonly ProposalView[] = replay(
  sessionLog([
    started(),
    utterance(1),
    proposalV2(1, {}, unflagged),
    proposalV2(
      2,
      {
        decision: "ask",
        entityId: null,
        basis: null,
        p: 0.48,
        candidates: [
          { entityId: uuid(6001), p: 0.48 },
          { entityId: uuid(6002), p: 0.4 },
          { entityId: null, p: 0.12 },
        ],
      },
      { riskFlags: [{ kind: "ambiguous_target", field: "target" }] },
    ),
    proposalV2(
      3,
      {
        decision: "new",
        entityId: null,
        basis: null,
        p: 0.7,
        candidates: [
          { entityId: null, p: 0.7 },
          { entityId: uuid(6003), p: 0.2 },
        ],
      },
      { riskFlags: [{ kind: "new_entity", field: "target" }] },
    ),
    proposalV2(
      4,
      { decision: "none", entityId: null, basis: null, p: null, mention: null, candidates: [] },
      unflagged,
    ),
    proposalV2(5, {}, unflagged),
    reviewV2(5),
    proposalV2(6, {}, unflagged),
    proposalV2(7, {}, { ...unflagged, supersedes: uuid(3006) }),
    proposalV2(8, {}, unflagged),
    reviewV2(8),
    reopen(8, uuid(7008)),
    proposalV2(9, {}, unflagged),
    reviewV2(9, "rejected"),
    proposalV2(
      10,
      {
        decision: "new",
        entityId: null,
        basis: null,
        p: 0.8,
        candidates: [{ entityId: null, p: 0.8 }],
      },
      unflagged,
    ),
  ]),
  { proposals: proposalsProjection },
).proposals;

const client: ReviewRuleContext = { tierOf: anyFlagTier, from: "client" };
const session: ReviewRuleContext = { tierOf: anyFlagTier, from: "session" };

/** The payload of a builder's review, checked against the schema: the rules start past it. */
const payload = (body: EventBody) => ProposalReviewedV2.parse(body.payload);

const unattended = {
  input: "none",
  surface: "session",
  timing: { decisionMs: 0, handlingMs: 0 },
  by: { userId: REVIEWER.userId, auth: null },
};
const policyApproval = (n: number, extra: Record<string, unknown> = {}) =>
  reviewV2(n, "approved", {
    mode: "policy",
    policy: { id: uuid(0x9001), version: 1, rule: "notes" },
    ...unattended,
    ...extra,
  });
const systemReopen = (n: number, undoes: string, extra: Record<string, unknown> = {}) =>
  reopen(n, undoes, { mode: "system", reason: "flagged", ...unattended, ...extra });
const batch = { mode: "batch", batchId: uuid(0xba7c) };

describe("checkReview accepts", () => {
  it.each<[string, EventBody, ReviewRuleContext]>([
    ["an approval of a linked record, as proposed", reviewV2(1), client],
    [
      "an approval choosing another of the record's candidates",
      reviewV2(1, "approved", { target: { entityId: uuid(6002) } }),
      client,
    ],
    [
      "an approval choosing the record offered at review time",
      reviewV2(1, "approved", {
        target: { entityId: uuid(6009) },
        seen: {
          tier: "loud",
          fields: {},
          target: { entityId: uuid(6001), offered: [] },
          relinked: uuid(6009),
          clip: "none",
        },
      }),
      client,
    ],
    ["an edit", reviewV2(1, "edited"), client],
    ["a rejection of an ask, with no record chosen", reviewV2(2, "rejected"), client],
    [
      "an ask settled with one of its candidates",
      reviewV2(2, "approved", { target: { entityId: uuid(6002) } }),
      client,
    ],
    [
      "an ask settled as a new record",
      reviewV2(2, "approved", { target: { entityId: null } }),
      client,
    ],
    ["a new record approved as proposed", reviewV2(3), client],
    [
      "a new record matched to a candidate instead",
      reviewV2(3, "edited", { target: { entityId: uuid(6003) } }),
      client,
    ],
    ["an undo of the latest review", reopen(5, uuid(7005)), client],
    ["a decision after a reopen", reviewV2(8, "approved", { reviewId: uuid(7208) }), client],
    ["a batch approval of an unmarked proposal", reviewV2(1, "approved", batch), client],
    ["a batch undo", reopen(5, uuid(7005), batch), client],
    ["a policy's approval, from SessionDO", policyApproval(1), session],
    ["a reopen for a later flag, from SessionDO", systemReopen(5, uuid(7005)), session],
  ])("%s", (_, body, ctx) => {
    expect(checkReview(proposals, payload(body), ctx)).toEqual({ ok: true });
  });
});

describe("checkReview refuses", () => {
  it.each<[string, EventBody, ReviewRuleContext, ReviewRefusal]>([
    ["an ask approved without a record", reviewV2(2), client, "target_required"],
    [
      "an ask approved with a record it didn't offer",
      reviewV2(2, "approved", { target: { entityId: uuid(6009) } }),
      client,
      "target_not_offered",
    ],
    [
      "a link changed to a record it didn't offer",
      reviewV2(1, "approved", { target: { entityId: uuid(6003) } }),
      client,
      "target_not_offered",
    ],
    [
      "a new record linked to a record it didn't offer",
      reviewV2(3, "approved", { target: { entityId: uuid(6001) } }),
      client,
      "target_not_offered",
    ],
    ["an approval of a proposal with no record", reviewV2(4), client, "no_target"],
    ["an edit of a proposal with no record", reviewV2(4, "edited"), client, "no_target"],
    ["a reopen of the wrong review", reopen(5, uuid(7999)), client, "not_latest"],
    ["a reopen of a proposal never reviewed", reopen(1, uuid(7001)), client, "not_latest"],
    ["a reopen of a reopen", reopen(8, uuid(7108)), client, "nothing_to_reopen"],
    [
      "a reopen for a flag of a rejection",
      systemReopen(9, uuid(7009)),
      session,
      "nothing_to_reopen",
    ],
    ["an approval of an approved proposal", reviewV2(5), client, "not_proposed"],
    ["a rejection of a rejected proposal", reviewV2(9, "rejected"), client, "not_proposed"],
    ["a batch item with a marker", reviewV2(3, "approved", batch), client, "marked"],
    ["a policy review from a client", policyApproval(1), client, "machine_only"],
    ["a system review from a client", systemReopen(5, uuid(7005)), client, "machine_only"],
    ["a policy's approval of a marked proposal", policyApproval(3), session, "policy_excluded"],
    [
      "a policy's approval of a record that isn't linked",
      policyApproval(10),
      session,
      "policy_excluded",
    ],
    ["a policy's approval of a correction", policyApproval(7), session, "policy_excluded"],
    ["a review of a superseded proposal", reviewV2(6), client, "superseded"],
    ["a review of a proposal the session doesn't have", reviewV2(99), client, "unknown_proposal"],
    ["a person's review from SessionDO", reviewV2(1), session, "malformed"],
  ])("%s", (_, body, ctx, reason) => {
    expect(checkReview(proposals, payload(body), ctx)).toMatchObject({ ok: false, reason });
  });
});

describe("checkReview's shape rules, which the schema can't express", () => {
  const editDiff = { title: { before: "Send the deck", after: "Send the revised deck" } };
  it.each<[string, EventBody, ReviewRuleContext?]>([
    ["a batch review without a batch id", reviewV2(1, "approved", { mode: "batch" })],
    ["a batch id on a single review", reviewV2(1, "approved", { batchId: uuid(0xba7c) })],
    [
      "a policy on a person's review",
      reviewV2(1, "approved", { policy: { id: uuid(0x9001), version: 1, rule: "notes" } }),
    ],
    ["a reopen that undoes nothing", reopen(5, uuid(7005), { undoes: null })],
    ["an approval that undoes a review", reviewV2(1, "approved", { undoes: uuid(7005) })],
    ["a reopen with no reason", reopen(5, uuid(7005), { reason: null })],
    ["an approval with a reopen's reason", reviewV2(1, "approved", { reason: "undo" })],
    ["an edit with no diff", reviewV2(1, "edited", { editDiff: undefined })],
    ["an empty diff", reviewV2(1, "edited", { editDiff: {} })],
    ["an approval with a diff", reviewV2(1, "approved", { editDiff })],
    ["an approval with no sync time", reviewV2(1, "approved", { syncEligibleAt: null })],
    [
      "a rejection with a sync time",
      reviewV2(1, "rejected", { syncEligibleAt: "2026-11-10T19:16:30.000Z" }),
    ],
    [
      "a reopen with a sync time",
      reopen(5, uuid(7005), { syncEligibleAt: "2026-11-10T19:16:30.000Z" }),
    ],
    [
      "a rejection choosing a record",
      reviewV2(1, "rejected", { target: { entityId: uuid(6001) } }),
    ],
    ["a review that saw nothing", reviewV2(1, "approved", { seen: null })],
    ["a review with no input", reviewV2(1, "approved", { input: null })],
    ["a review from no surface", reviewV2(1, "approved", { surface: null })],
    ["a review by nobody", reviewV2(1, "approved", { by: null })],
    ["a reopen for a flag in a person's review", reopen(5, uuid(7005), { reason: "flagged" })],
    ["a batch edit", reviewV2(1, "edited", batch)],
    ["a person's review with no input", reviewV2(1, "approved", { input: "none" })],
    ["a person's review on SessionDO's surface", reviewV2(1, "approved", { surface: "session" })],
    [
      "a policy's rejection",
      policyApproval(1, { decision: "rejected", syncEligibleAt: null }),
      session,
    ],
    ["a system approval", reviewV2(1, "approved", { mode: "system", ...unattended }), session],
    ["a system reopen for an undo", systemReopen(5, uuid(7005), { reason: "undo" }), session],
    ["a policy's approval with a sign-in", policyApproval(1, { by: REVIEWER }), session],
    ["a policy's approval by keyboard", policyApproval(1, { input: "keyboard" }), session],
    ["a policy's approval in the inbox", policyApproval(1, { surface: "inbox" }), session],
    [
      "a policy's approval that took time",
      policyApproval(1, { timing: { decisionMs: 0, handlingMs: 5 } }),
      session,
    ],
  ])("refuses %s", (_, body, ctx = client) => {
    expect(checkReview(proposals, payload(body), ctx)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("checkReviews", () => {
  it("accepts one batch across proposals, each checked against the state before the request", () => {
    const reviews = [
      payload(reviewV2(1, "approved", batch)),
      payload(reviewV2(10, "approved", batch)),
    ];
    expect(checkReviews(proposals, reviews, client)).toEqual({ ok: true });
  });

  it("refuses a repeated review id, a repeated proposal, or two batches in one request", () => {
    const twiceById = [
      payload(reviewV2(1)),
      payload(reviewV2(10, "approved", { reviewId: uuid(7001) })),
    ];
    expect(checkReviews(proposals, twiceById, client)).toMatchObject({
      ok: false,
      index: 1,
      reason: "malformed",
      detail: "a review id appears twice",
    });
    const twiceByProposal = [
      payload(reviewV2(1)),
      payload(reviewV2(1, "rejected", { reviewId: uuid(7201) })),
    ];
    expect(checkReviews(proposals, twiceByProposal, client)).toMatchObject({
      index: 1,
      detail: "a proposal appears twice",
    });
    const twoBatches = [
      payload(reviewV2(1, "approved", batch)),
      payload(reviewV2(10, "approved", { ...batch, batchId: uuid(0xba7d) })),
    ];
    expect(checkReviews(proposals, twoBatches, client)).toMatchObject({
      index: 1,
      detail: "one request, one batch id",
    });
  });

  it("names the first review it refuses", () => {
    const reviews = [
      payload(reviewV2(1, "approved", batch)),
      payload(reviewV2(3, "approved", batch)),
    ];
    expect(checkReviews(proposals, reviews, client)).toMatchObject({
      ok: false,
      index: 1,
      reason: "marked",
    });
  });
});

describe("checkSnooze", () => {
  const snooze = (body: EventBody) => ProposalSnoozedV1.parse(body.payload);

  it("snoozes and wakes a proposed proposal", () => {
    expect(checkSnooze(proposals, snooze(snoozed(1)))).toEqual({ ok: true });
    expect(checkSnooze(proposals, snooze(snoozed(8, null)))).toEqual({ ok: true });
  });

  it.each<[string, EventBody, ReviewRefusal]>([
    ["a proposal the session doesn't have", snoozed(99), "unknown_proposal"],
    ["a superseded proposal", snoozed(6), "superseded"],
    ["a decided proposal", snoozed(5), "not_proposed"],
    ["a wake of a decided proposal", snoozed(9, null), "not_proposed"],
  ])("refuses %s", (_, body, reason) => {
    expect(checkSnooze(proposals, snooze(body))).toMatchObject({ ok: false, reason });
  });
});

describe("the tier function", () => {
  it("is passed in: these tests' stand-in counts any flag as a marker", () => {
    const [linked, ask] = proposals;
    if (!linked || !ask) throw new Error("missing proposals");
    expect(anyFlagTier(linked)).toEqual({ tier: "none" });
    expect(anyFlagTier(ask)).toEqual({ tier: "loud" });
  });

  it("takes WP4's shape, { tier, reasons, nameNote }, and decides what a batch may take", () => {
    const tierOf = (proposal: ProposalView) => ({
      tier: proposal.proposalId === uuid(3003) ? ("none" as const) : ("quiet" as const),
      reasons: [],
      nameNote: null,
    });
    const ctx: ReviewRuleContext = { tierOf, from: "client" };
    expect(checkReview(proposals, payload(reviewV2(3, "approved", batch)), ctx)).toEqual({
      ok: true,
    });
    expect(checkReview(proposals, payload(reviewV2(1, "approved", batch)), ctx)).toMatchObject({
      reason: "marked",
    });
  });
});
