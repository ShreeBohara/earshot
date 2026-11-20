// "Accept all from this call" (Phase 5 spec WP6 step 1; ADR-0035): the set a batch takes is the
// writers' own (`checkReview` with the `tierOf` the route and SessionDO pass), on a fixture with
// every tier; the batch's reviews and its undo keep the writers' rules; a batch longer than one
// request splits and lands part by part; and focus, Reviewed's rows, and the messages follow.
import {
  type ProposalReviewedV2,
  type ReviewInput,
  ReviewInput as ReviewInputSchema,
  type ReviewTiming,
} from "@earshot/core";
import {
  checkReview,
  checkReviews,
  type ProposalView,
  proposalsProjection,
  replay,
} from "@earshot/events";
import {
  type EventBody,
  proposalV2,
  REVIEWER,
  reopen,
  reviewV2,
  SESSION_ID,
  snoozed,
  started,
  tsFor,
  utterance,
  uuid,
} from "@earshot/events/testing";
import { tierOf } from "@earshot/understanding/tiers";
import { describe, expect, it, vi } from "vitest";
import {
  batchItems,
  batchPlan,
  batchReviews,
  batchUndoReviews,
  reviewedRows,
  stayReason,
} from "@/lib/inbox/batch";
import { cardModel } from "@/lib/inbox/card";
import {
  batchButtonLabel,
  batchFailureMessage,
  batchMessage,
  batchNoneReason,
  batchRestoredMessage,
  batchSummary,
  stayWords,
} from "@/lib/inbox/copy";
import { focusAfterBatch } from "@/lib/inbox/focus";
import { inboxSections, type SessionItem } from "@/lib/inbox/groups";
import { reviewedState } from "@/lib/inbox/review";
import {
  type Change,
  type ChangeItem,
  OptimisticReviews,
  type ReviewRequest,
  type ReviewSink,
  type SinkResult,
  splitRequest,
  stateOf,
  withLocal,
} from "@/lib/inbox/sinks";
import type { InboxProposal, InboxSession } from "@/lib/inbox/types";

// ─── A debrief with a card in every tier ────────────────────────────────────────────────────────

const NOW = Date.parse("2026-11-20T16:00:00.000Z");
const exact = { basis: "exact", p: 0.98, candidates: [{ entityId: uuid(6001), p: 0.98 }] };
const none = {
  decision: "none",
  entityId: null,
  basis: null,
  p: null,
  mention: null,
  candidates: [],
};

/** Each card by its number (proposal `uuid(3000 + n)`), what it is, and its tier. */
const CARDS = {
  1: proposalV2(1, exact, { riskFlags: [] }),
  // Only a self-correction the model took: unmarked.
  2: proposalV2(2, exact, { riskFlags: [{ kind: "self_correction", field: "title" }] }),
  // Loud: the linker asked.
  3: proposalV2(
    3,
    {
      decision: "ask",
      entityId: null,
      basis: null,
      p: 0.48,
      candidates: [
        { entityId: uuid(6001), p: 0.48 },
        { entityId: uuid(6002), p: 0.41 },
      ],
    },
    { riskFlags: [{ kind: "ambiguous_target", field: "target" }] },
  ),
  // Loud: the witnesses disagree on a field.
  4: proposalV2(4, exact, { riskFlags: [{ kind: "witness_conflict", field: "title" }] }),
  // Loud: the record's name isn't in what was said, so there's no record either.
  5: proposalV2(5, none, { riskFlags: [{ kind: "unsupported", field: "target" }] }),
  // Quiet, a card note: the open account assumed.
  6: proposalV2(
    6,
    { basis: "focus", p: null, mention: null, candidates: [] },
    { riskFlags: [{ kind: "implied_target", field: "target" }] },
  ),
  // Quiet, by the name: linked by sound (the builder's default).
  7: proposalV2(7),
  // Unmarked, but there's no record to accept it for.
  8: proposalV2(8, none, { riskFlags: [] }),
  // Unmarked, with a change of the page's still on its way.
  9: proposalV2(9, exact, { riskFlags: [] }),
  // Unmarked, snoozed past now: in Snoozed, not up for review.
  10: proposalV2(10, exact, { riskFlags: [] }),
  // Unmarked, accepted already: in Reviewed.
  11: proposalV2(11, exact, { riskFlags: [] }),
  // Quiet, a field note: words in a negation.
  12: proposalV2(12, exact, { riskFlags: [{ kind: "negation", field: "title" }] }),
  // Loud: a new record, with one in the CRM that sounds like it.
  13: proposalV2(
    13,
    {
      decision: "new",
      entityId: null,
      basis: null,
      p: 0.7,
      candidates: [
        { entityId: null, p: 0.7 },
        { entityId: uuid(6002), p: 0.2 },
      ],
    },
    { riskFlags: [{ kind: "new_entity", field: "target" }] },
  ),
  // Quiet, a card note: a new record with nothing like it in the CRM.
  14: proposalV2(
    14,
    { decision: "new", entityId: null, basis: null, p: 1, candidates: [{ entityId: null, p: 1 }] },
    { riskFlags: [{ kind: "new_entity", field: "target" }] },
  ),
} as const;

const pid = (n: number) => uuid(3000 + n);

function baseLog(): EventBody[] {
  return [
    started(),
    utterance(1, "Akme wants the deck, and they never asked for a call."),
    ...Object.values(CARDS),
    snoozed(10, "2026-11-21T09:00:00.000Z"),
    reviewV2(11, "approved"),
  ];
}

/** A review the page made, as an event body for the log. */
const reviewed = (review: ReviewInput): EventBody => ({
  type: "proposal.reviewed",
  schemaVersion: 2,
  payload: completed(review) as unknown as Record<string, unknown>,
});

/** The proposals as the projection folds the log: what both writers check against. */
function fold(bodies: readonly EventBody[]): readonly ProposalView[] {
  const log = bodies.map((body, seq) => ({
    id: uuid(1000 + seq),
    sessionId: SESSION_ID,
    seq,
    type: body.type,
    schemaVersion: body.schemaVersion,
    ts: tsFor(seq),
    payload: body.payload,
  }));
  return replay(log, { proposals: proposalsProjection }).proposals;
}

function sessionOf(views: readonly ProposalView[]): InboxSession {
  return {
    sessionId: SESSION_ID,
    startedAt: "2026-11-20T14:00:00.000Z",
    endedAt: "2026-11-20T14:05:00.000Z",
    sealedAt: "2026-11-20T14:06:00.000Z",
    focusEntityId: null,
    proposals: views,
  };
}

/** The debrief's open cards, as its group shows them. */
function openCards(views: readonly ProposalView[]): InboxProposal[] {
  const [group] = inboxSections([sessionOf(views)], {}, NOW).review;
  return group?.accounts.flatMap((account) => account.proposals) ?? [];
}

/** A `ReviewInput` as a writer completes it before it checks and appends. */
function completed(review: ReviewInput): ProposalReviewedV2 {
  const decides = review.decision === "approved" || review.decision === "edited";
  return {
    ...review,
    syncEligibleAt: decides ? "2026-11-20T16:00:30.000Z" : null,
    by: REVIEWER,
  } as ProposalReviewedV2;
}

const client = { tierOf, from: "client" } as const;
const TIMING: ReviewTiming = { decisionMs: 4_200, handlingMs: 4_200 };

describe('the set "accept all" takes', () => {
  it("takes only unmarked cards with a record, and says why each other card stays", () => {
    const views = fold(baseLog());
    const plan = batchPlan(SESSION_ID, openCards(views), (id) => id === pid(9));
    expect(plan.accept.map((p) => p.proposalId)).toEqual([pid(1), pid(2)]);
    expect(Object.fromEntries(plan.stay.map((s) => [s.proposal.proposalId, s.reason]))).toEqual({
      [pid(3)]: "loud",
      [pid(4)]: "loud",
      [pid(5)]: "loud",
      [pid(6)]: "quiet",
      [pid(7)]: "name_note",
      [pid(8)]: "no_record",
      [pid(9)]: "saving",
      [pid(12)]: "quiet",
      [pid(13)]: "loud",
      [pid(14)]: "quiet",
    });
    // Snoozed and decided cards aren't up for review, so neither list names them.
    const named = [...plan.accept, ...plan.stay.map((s) => s.proposal)].map((p) => p.proposalId);
    expect(named).not.toContain(pid(10));
    expect(named).not.toContain(pid(11));
  });

  it("is exactly the set the writers' rule takes in batch mode, with the same tierOf", () => {
    const views = fold(baseLog());
    const open = openCards(views);
    const plan = batchPlan(SESSION_ID, open);
    const { reviews } = batchReviews(open, {
      entities: {},
      timing: TIMING,
      input: "pointer",
      surface: "inbox",
    });
    for (const [index, proposal] of open.entries()) {
      const review = reviews[index] as ReviewInput;
      const writers = checkReview(views, completed(review), client).ok;
      const page = plan.accept.some((p) => p.proposalId === proposal.proposalId);
      expect({ proposal: proposal.proposalId, page }).toEqual({
        proposal: proposal.proposalId,
        page: writers,
      });
    }
    // The writers refuse each marked card for its marker, the question for want of a record, and
    // the record-less card because it has none.
    const reason = (n: number) => {
      const index = open.findIndex((p) => p.proposalId === pid(n));
      const check = checkReview(views, completed(reviews[index] as ReviewInput), client);
      return check.ok ? "ok" : check.reason;
    };
    expect([3, 4, 5, 6, 7, 8, 12, 13, 14].map(reason)).toEqual([
      "target_required",
      "marked",
      "no_target",
      "marked",
      "marked",
      "no_target",
      "marked",
      "marked",
      "marked",
    ]);
  });

  it("leaves out a card with a change of the page's on its way, which the writers alone would take", () => {
    const views = fold(baseLog());
    expect(
      stayReason(openCards(views).find((p) => p.proposalId === pid(9)) as InboxProposal, true),
    ).toBe("saving");
    expect(
      stayReason(openCards(views).find((p) => p.proposalId === pid(9)) as InboxProposal, false),
    ).toBe(null);
  });

  it("writes one approval per card, one batchId, the batch's own time, the confirming input, and the surface", () => {
    const views = fold(baseLog());
    const plan = batchPlan(SESSION_ID, openCards(views), (id) => id === pid(9));
    const { batchId, reviews } = batchReviews(plan.accept, {
      entities: {},
      timing: TIMING,
      input: "keyboard",
      surface: "inbox",
    });
    expect(reviews).toHaveLength(2);
    for (const review of reviews) {
      expect(review).toMatchObject({
        decision: "approved",
        target: null,
        mode: "batch",
        batchId,
        undoes: null,
        reason: null,
        timing: TIMING,
        input: "keyboard",
        surface: "inbox",
        seen: { tier: "none", relinked: null, clip: "none" },
      });
      // The contract the socket and the route parse with, key-shape refusal included.
      expect(ReviewInputSchema.safeParse(review).success).toBe(true);
    }
    expect(new Set(reviews.map((review) => review.reviewId)).size).toBe(2);
    expect(checkReviews(views, reviews.map(completed), client)).toEqual({ ok: true });
  });

  it("undoes the batch with one reopen per card it still stands on, each naming its own review", () => {
    const before = baseLog();
    const views = fold(before);
    const plan = batchPlan(SESSION_ID, openCards(views), (id) => id === pid(9));
    const { batchId, reviews } = batchReviews(plan.accept, {
      entities: {},
      timing: TIMING,
      input: "pointer",
      surface: "inbox",
    });
    const landed = [...before, ...reviews.map(reviewed)];
    const afterBatch = fold(landed);
    const items = batchItems(afterBatch, batchId);
    expect(items.map((p) => p.proposalId)).toEqual([pid(1), pid(2)]);
    const reopens = batchUndoReviews(items, {
      batchId,
      entities: {},
      input: "keyboard",
      surface: "inbox",
    });
    expect(reopens.map((r) => [r.proposalId, r.undoes])).toEqual(
      reviews.map((r) => [r.proposalId, r.reviewId]),
    );
    for (const reopened of reopens) {
      expect(reopened).toMatchObject({
        decision: "reopened",
        mode: "batch",
        batchId,
        reason: "undo",
        timing: { decisionMs: 0, handlingMs: 0 },
      });
      expect(ReviewInputSchema.safeParse(reopened).success).toBe(true);
    }
    expect(checkReviews(afterBatch, reopens.map(completed), client)).toEqual({ ok: true });
    const undone = fold([...landed, ...reopens.map(reviewed)]);
    expect(
      undone.filter((p) => [pid(1), pid(2)].includes(p.proposalId)).map((p) => p.status),
    ).toEqual(["proposed", "proposed"]);

    // A card reopened and decided again on its own since isn't the batch's any more: the undo
    // and Reviewed's batch row leave it alone.
    const second = reviews[1] as ReviewInput;
    const regrouped = fold([
      ...landed,
      reopen(2, second.reviewId),
      reviewV2(2, "rejected", { reviewId: uuid(7302) }),
    ]);
    expect(batchItems(regrouped, batchId).map((p) => p.proposalId)).toEqual([pid(1)]);
    const items2: SessionItem[] = regrouped
      .filter((p) => p.status !== "proposed")
      .map((proposal) => ({ sessionId: SESSION_ID, proposal }));
    const rows = reviewedRows(items2);
    expect(rows.filter((row) => row.kind === "batch")).toEqual([
      expect.objectContaining({
        batchId,
        items: [
          expect.objectContaining({ proposal: expect.objectContaining({ proposalId: pid(1) }) }),
        ],
      }),
    ]);
  });
});

// ─── Focus ──────────────────────────────────────────────────────────────────────────────────────

describe("focus after a batch leaves", () => {
  it("goes to the first card the batch left in its group, from the group's start", () => {
    const groups = [["a", "b", "c", "d"], ["e"]];
    expect(focusAfterBatch(groups, new Set(["a", "c"]))).toEqual({ kind: "card", id: "b" });
    expect(focusAfterBatch(groups, new Set(["b", "d"]))).toEqual({ kind: "card", id: "a" });
  });

  it("then the next group's first card, an earlier group's last, and All caught up", () => {
    const groups = [["a", "b"], ["c", "d"], ["e"]];
    expect(focusAfterBatch(groups, new Set(["c", "d"]))).toEqual({ kind: "card", id: "e" });
    expect(focusAfterBatch(groups, new Set(["e"]))).toEqual({ kind: "card", id: "d" });
    expect(focusAfterBatch([["a", "b"]], new Set(["a", "b"]))).toEqual({ kind: "caught-up" });
    // Never <body>: a batch nobody shows still lands focus on a card.
    expect(focusAfterBatch([["a"]], new Set(["z"]))).toEqual({ kind: "card", id: "a" });
  });
});

// ─── The optimistic sink, batch by batch ────────────────────────────────────────────────────────

function proposalOf(n: number): InboxProposal {
  const [view] = fold([started(), utterance(1), proposalV2(n, exact, { riskFlags: [] })]);
  return view as InboxProposal;
}

/** A batch change over `count` unmarked cards, numbered from 100. */
function batchChange(
  count: number,
  options: { pad?: number } = {},
): { change: Change; cards: InboxProposal[] } {
  const cards = Array.from({ length: count }, (_, index) => proposalOf(100 + index));
  const { reviews } = batchReviews(cards, {
    entities: {},
    timing: TIMING,
    input: "pointer",
    surface: "inbox",
    batchId: uuid(0xba7c),
  });
  const padded: ReviewInput[] = options.pad
    ? reviews.map(
        (review): ReviewInput => ({
          ...review,
          seen: {
            ...(review.seen as NonNullable<ReviewInput["seen"]>),
            fields: { title: { proposed: "x".repeat(options.pad as number) } },
          },
        }),
      )
    : reviews;
  const at = new Date(NOW);
  const items: ChangeItem[] = cards.map((card, index) => ({
    proposalId: card.proposalId,
    previous: stateOf(card),
    next: { ...reviewedState(padded[index] as ReviewInput, at, 30_000), snoozedUntil: null },
  }));
  return {
    change: { sessionId: SESSION_ID, items, request: { reviews: padded, snoozes: [] } },
    cards,
  };
}

/** A sink that records each request and answers with the next scripted result (ok by default). */
function scriptedSink(results: SinkResult[] = []) {
  const sent: ReviewRequest[] = [];
  const sink: ReviewSink = {
    send: async (_sessionId, request) => {
      sent.push(request);
      return results.shift() ?? { ok: true };
    },
  };
  return { sink, sent };
}

describe("a batch through the optimistic sink", () => {
  it("leaves as a whole, in one update, and lands as one request when it fits one", async () => {
    const { sink, sent } = scriptedSink();
    const store = new OptimisticReviews(sink);
    const updates = vi.fn();
    store.subscribe(updates);
    const { change, cards } = batchChange(3);
    const landed = store.apply(change);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(cards.map((card) => withLocal(card, store.overlay()).status)).toEqual([
      "approved",
      "approved",
      "approved",
    ]);
    expect(cards.every((card) => store.pending(card.proposalId))).toBe(true);
    await expect(landed).resolves.toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.reviews).toHaveLength(3);
    expect(store.pendingIds().size).toBe(0);
  });

  it("splits by count, 25 a request, in order, keeping one batchId", async () => {
    const { sink, sent } = scriptedSink();
    const store = new OptimisticReviews(sink);
    const { change } = batchChange(30);
    await expect(store.apply(change)).resolves.toEqual({ ok: true });
    expect(sent.map((request) => request.reviews.length)).toEqual([25, 5]);
    expect(new Set(sent.flatMap((request) => request.reviews.map((r) => r.batchId)))).toEqual(
      new Set([uuid(0xba7c)]),
    );
    expect(sent.flatMap((request) => request.reviews.map((r) => r.proposalId))).toEqual(
      change.request.reviews.map((r) => r.proposalId),
    );
  });

  it("splits by bytes too, so no request passes 64 KiB", () => {
    const { change } = batchChange(10, { pad: 12_000 });
    const parts = splitRequest(change.request);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const body = JSON.stringify({ reviews: part.reviews, snoozes: part.snoozes });
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(65_536);
    }
    expect(parts.flatMap((part) => part.reviews)).toEqual(change.request.reviews);
    // A request within the limits is itself.
    const small = batchChange(2).change.request;
    expect(splitRequest(small)).toEqual([small]);
  });

  it("refused partway: the part that landed stays, the rest comes back, and one failure says so", async () => {
    const { sink, sent } = scriptedSink([{ ok: true }, { ok: false, reason: "stale" }]);
    const onFailure = vi.fn();
    const store = new OptimisticReviews(sink, { onFailure });
    const { change, cards } = batchChange(30);
    await expect(store.apply(change)).resolves.toEqual({ ok: false, reason: "stale" });
    expect(sent).toHaveLength(2);
    const statuses = cards.map((card) => withLocal(card, store.overlay()).status);
    expect(statuses.slice(0, 25).every((status) => status === "approved")).toBe(true);
    expect(statuses.slice(25).every((status) => status === "proposed")).toBe(true);
    expect(onFailure).toHaveBeenCalledOnce();
    const failure = onFailure.mock.calls[0]?.[0];
    expect(failure.reason).toBe("stale");
    expect(failure.landed).toHaveLength(25);
    expect(failure.failed.map((item: ChangeItem) => item.proposalId)).toEqual(
      cards.slice(25).map((card) => card.proposalId),
    );
    expect(batchFailureMessage("accept", 30, failure.landed.length, failure.reason)).toBe(
      "Accepted 25 of 30. Couldn't accept the other 5: one of them changed since the page loaded. Reload to see them as they are now.",
    );
  });

  it("refused at once: nothing landed, the whole batch comes back, and the rest isn't sent", async () => {
    const { sink, sent } = scriptedSink([{ ok: false, reason: "failed" }]);
    const onFailure = vi.fn();
    const store = new OptimisticReviews(sink, { onFailure });
    const { change, cards } = batchChange(30);
    await store.apply(change);
    expect(sent).toHaveLength(1);
    expect(cards.every((card) => withLocal(card, store.overlay()).status === "proposed")).toBe(
      true,
    );
    expect(onFailure.mock.calls[0]?.[0].landed).toHaveLength(0);
  });

  it("an undo queued behind a batch refused partway goes out for the part that landed only", async () => {
    let release: (() => void) | undefined;
    const sent: ReviewRequest[] = [];
    const results: SinkResult[] = [{ ok: true }, { ok: false, reason: "stale" }];
    const sink: ReviewSink = {
      send: async (_sessionId, request) => {
        sent.push(request);
        if (sent.length === 1) await new Promise<void>((resolve) => (release = resolve));
        return results.shift() ?? { ok: true };
      },
    };
    const store = new OptimisticReviews(sink);
    const { change, cards } = batchChange(30);
    const batch = store.apply(change);
    // The batch's undo, queued behind it: one reopen per card, each naming its batch review.
    const reopens = batchUndoReviews(
      cards.map((card) => withLocal(card, store.overlay())),
      { batchId: uuid(0xba7c), entities: {}, input: "keyboard", surface: "inbox" },
    );
    const undo = store.apply({
      sessionId: SESSION_ID,
      items: cards.map((card, index) => ({
        proposalId: card.proposalId,
        previous: withLocal(card, store.overlay()),
        next: {
          ...reviewedState(reopens[index] as ReviewInput, new Date(NOW), 30_000),
          snoozedUntil: null,
        },
      })),
      request: { reviews: reopens, snoozes: [] },
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.();
    await batch;
    await expect(undo).resolves.toEqual({ ok: true });
    // Batch: 25 then 5 (refused). Undo: only the 25 reopens whose reviews landed.
    expect(sent.map((request) => request.reviews.length)).toEqual([25, 5, 25]);
    expect(sent[2]?.reviews.map((r) => r.proposalId)).toEqual(
      cards.slice(0, 25).map((card) => card.proposalId),
    );
  });
});

// ─── What it says ───────────────────────────────────────────────────────────────────────────────

describe('what "accept all" says', () => {
  it("labels its button, says why it's disabled, and sums up the checkpoint", () => {
    expect(batchButtonLabel(3)).toBe("Accept 3 unmarked");
    expect(batchButtonLabel(0)).toBe("Accept all unmarked");
    expect(batchNoneReason(["loud", "quiet", "name_note"])).toBe(
      "Every card here is marked, so each needs a look.",
    );
    expect(batchNoneReason(["quiet", "saving"])).toBe("Your last review here is still saving.");
    expect(batchNoneReason(["loud", "no_record"])).toBe(
      "Nothing here can be accepted as it stands.",
    );
    expect(batchSummary(3, 2)).toBe("3 will be accepted. 2 stay for review.");
    expect(batchSummary(1, 1)).toBe("1 will be accepted. 1 stays for review.");
    expect(batchSummary(4, 0)).toBe("4 will be accepted. Nothing stays for review.");
  });

  it("says why each card stays, from what the card shows", () => {
    const views = fold(baseLog());
    const words = (n: number) => {
      const proposal = views.find((p) => p.proposalId === pid(n)) as InboxProposal;
      const reason = stayReason(proposal, false);
      return reason ? stayWords(reason, cardModel(proposal, {}, {})) : null;
    };
    expect(words(3)).toBe("Needs a check: I'm not sure which company you meant.");
    expect(words(6)).toBe("Has a note: Open account assumed");
    expect(words(7)).toBe("Record matched by sound");
    expect(words(8)).toBe("No record to add it to");
    expect(words(1)).toBeNull();
  });

  it("gives one polite message per batch and its undo, and one urgent one per failure", () => {
    expect(batchMessage(3, 2, 5, true)).toBe("Accepted 3. 2 stay for review. Press U to undo.");
    expect(batchMessage(3, 0, 4, false)).toBe("Accepted 3. 4 left.");
    expect(batchMessage(3, 0, 0, false)).toBe("Accepted 3. All caught up.");
    expect(batchRestoredMessage(3, 7)).toBe("Back for review: 3 proposals. 7 left.");
    expect(batchFailureMessage("accept", 3, 0, "failed")).toBe(
      "Couldn't accept the 3 proposals: Earshot couldn't reach the server. Try again.",
    );
    expect(batchFailureMessage("undo", 26, 25, "not_sealed")).toBe(
      "Brought back 25 of 26. Couldn't bring back the other 1: its debrief is still finishing. Try again in a minute.",
    );
  });
});
