// The capture screen's tray reviews (Phase 5 spec WP6 step 2; ADR-0035): its socket sink over
// `@earshot/voice/testing`'s in-memory SessionDO, through the same optimistic store as the inbox.
// One decision, an "accept all" of 30 split across two `review` messages with one batch id, its
// undo, and a snooze go over the socket and SessionDO writes them; then the seal, after which the
// socket refuses and the client hands each review to the web route under the same review id, so
// the tray keeps working.
import type { ProposalReviewedV2, ReviewInput, ReviewRouteResponse } from "@earshot/core";
import type { ProposalView } from "@earshot/events";
import { createSessionClient, type ReviewRoute, ReviewRouteFailure } from "@earshot/voice/session";
import { FakePageLifecycle, FakeSessionServer, settle } from "@earshot/voice/testing";
import { describe, expect, it, vi } from "vitest";
import { batchItems, batchPlan, batchReviews, batchUndoReviews } from "@/lib/inbox/batch";
import { inboxSections } from "@/lib/inbox/groups";
import { decisionReview, reviewedState, snoozeOf } from "@/lib/inbox/review";
import {
  type Change,
  OptimisticReviews,
  type ReviewSink,
  singleChange,
  socketSink,
  stateOf,
  withLocal,
} from "@/lib/inbox/sinks";
import type { InboxProposal, InboxSession } from "@/lib/inbox/types";
import { ManualClock } from "./support/manual-clock";

const SESSION = "0000000a-0000-7000-8000-00000000bee5";
const ENTITY = "01a0f831-ac00-75a0-a2b2-cb79eb1835bf";

let count = 0;
const uuid = (prefix: string) => {
  count += 1;
  return `${prefix}-0000-7000-8000-${count.toString(16).padStart(12, "0")}`;
};

/** A proposal SessionDO would write: a task linked to one record by its exact name, unmarked. */
function linkedProposal() {
  const utteranceId = uuid("0000000d");
  return {
    proposalId: uuid("0000000e"),
    type: "task",
    target: {
      decision: "linked",
      entityId: ENTITY,
      kind: "company",
      basis: "exact",
      p: 0.98,
      mention: {
        quote: "Acme",
        evidence: { utteranceId, span: [0, 4], audioMs: [0, 300], confidence: 0.9 },
      },
      company: null,
      candidates: [{ entityId: ENTITY, p: 0.98 }],
    },
    fields: {
      title: {
        value: "Send the deck",
        evidence: { utteranceId, span: [5, 18], audioMs: [300, 900], confidence: 0.9 },
      },
    },
    riskFlags: [],
    supersedes: null,
    linker: "linker.v1",
  };
}

/** The web route as the client sees it: it writes what it's sent and says so. */
function fakeRoute() {
  return vi.fn<ReviewRoute>(async (request) => {
    const answer: ReviewRouteResponse = {
      sessionId: SESSION,
      reviews: request.reviews.map((review, index) => ({
        id: review.reviewId,
        seq: 100 + index,
        recorded: "now",
      })),
      snoozes: request.snoozes.map((snooze, index) => ({
        id: snooze.snoozeId,
        seq: 200 + index,
        recorded: "now",
      })),
      lastSeq: 300,
    };
    return answer;
  });
}

async function tray(proposals: number) {
  const clock = new ManualClock();
  const server = new FakeSessionServer({
    sessionId: SESSION,
    reviewer: {
      userId: "user-1",
      auth: { method: "magic_link", signedInAt: "2026-11-20T08:00:00.000Z" },
    },
  });
  const route = fakeRoute();
  const client = createSessionClient({
    sessionId: SESSION,
    url: server.edgeUrl,
    socket: server.factory,
    clock,
    random: () => 0.5,
    page: new FakePageLifecycle(),
    getTicket: async () => server.issueTicket(),
    sendBudget: { burst: 100, perSecond: 100 },
    reviewRoute: route,
  });
  client.start();
  await settle(400);
  client.sendStart({
    providers: {
      speechToText: { provider: "assemblyai", model: "universal-streaming-english" },
      llm: { provider: "anthropic", model: "claude-haiku-5-5" },
    },
    startedAt: "2026-11-20T12:00:00.000Z",
    entities: [{ id: ENTITY, kind: "company", name: "Acme Corp", aliases: [] }],
  });
  await settle(400);
  for (let n = 0; n < proposals; n += 1) server.append("proposal.created", linkedProposal());
  await settle(400);
  const sink: ReviewSink = socketSink(client);
  const store = new OptimisticReviews(sink);
  /** The tray's debrief, folded from the socket, with the page's own changes over it. */
  const session = (): InboxSession => ({
    sessionId: SESSION,
    startedAt: "2026-11-20T12:00:00.000Z",
    endedAt: null,
    sealedAt: client.store.getState().projections.session?.sealedAt ?? null,
    focusEntityId: null,
    proposals: client.store
      .getState()
      .projections.proposals.map((proposal: ProposalView) => withLocal(proposal, store.overlay())),
  });
  const open = () =>
    inboxSections([session()], {}, Date.now(), () => true).review.flatMap((group) =>
      group.accounts.flatMap((account) => account.proposals),
    );
  return { clock, server, client, route, store, session, open };
}

const reviewMessages = (server: FakeSessionServer) =>
  server.received.flatMap((message) => (message.t === "review" ? [message] : []));

function decided(review: ReviewInput, proposal: InboxProposal): Change {
  return singleChange(
    SESSION,
    proposal.proposalId,
    {
      previous: stateOf(proposal),
      next: { ...reviewedState(review, new Date(), 30_000), snoozedUntil: null },
    },
    { reviews: [review], snoozes: [] },
  );
}

describe("the tray's reviews over the session socket", () => {
  it("sends a decision over the socket, and SessionDO writes it as the tray's", async () => {
    const t = await tray(1);
    const [proposal] = t.open();
    if (!proposal) throw new Error("no card");
    const review = decisionReview({
      proposal,
      entities: {},
      decision: "approved",
      timing: { decisionMs: 900, handlingMs: 900 },
      input: "keyboard",
      surface: "tray",
    });
    const landed = t.store.apply(decided(review, proposal));
    expect(t.open()).toHaveLength(0);
    await settle(400);
    await expect(landed).resolves.toEqual({ ok: true });
    const event = t.server.log.at(-1);
    expect(event).toMatchObject({ type: "proposal.reviewed", schemaVersion: 3 });
    expect(event?.payload).toMatchObject({
      reviewId: review.reviewId,
      surface: "tray",
      by: { userId: "user-1", auth: { method: "magic_link" } },
    });
    expect(t.route).not.toHaveBeenCalled();
    // The socket's own event catches up with the page's change: nothing left to remember.
    t.store.reconcile(t.client.store.getState().projections.proposals);
    expect(t.store.overlay().size).toBe(0);
  });

  // Codex's review of #59: SessionDO reopens an approval that a late flag put in doubt. When that
  // reopen overtakes the approval before the tray reconciles (its list renders deferred, and can
  // skip the approved state), the page's approval must not keep the card hidden in Reviewed.
  it("brings a card back when SessionDO reopens it after a late flag, even if the approval never showed", async () => {
    const t = await tray(1);
    const [proposal] = t.open();
    if (!proposal) throw new Error("no card");
    const review = decisionReview({
      proposal,
      entities: {},
      decision: "approved",
      timing: { decisionMs: 900, handlingMs: 900 },
      input: "keyboard",
      surface: "tray",
    });
    const landed = t.store.apply(decided(review, proposal));
    await settle(400);
    await expect(landed).resolves.toEqual({ ok: true });
    expect(t.open()).toHaveLength(0);

    // Before the tray reconciles, SessionDO's system reopen, as `#systemReopen` writes it.
    const reopen: ProposalReviewedV2 = {
      reviewId: uuid("0000000f"),
      proposalId: proposal.proposalId,
      decision: "reopened",
      target: null,
      mode: "system",
      batchId: null,
      policy: null,
      undoes: review.reviewId,
      reason: "flagged",
      seen: {
        tier: "loud",
        fields: { title: { proposed: "Send the deck" } },
        target: { entityId: ENTITY, offered: [] },
        relinked: null,
        clip: "none",
      },
      timing: { decisionMs: 0, handlingMs: 0 },
      input: "none",
      surface: "session",
      syncEligibleAt: null,
      by: { userId: "user-1", auth: null },
    };
    t.server.append("proposal.reviewed", reopen);
    await settle(400);
    t.store.reconcile(t.client.store.getState().projections.proposals);
    expect(t.store.overlay().size).toBe(0);
    expect(t.open().map((card) => card.proposalId)).toEqual([proposal.proposalId]);
  });

  it("accepts all 30 as one change, in two review messages with one batch id, and undoes it the same way", async () => {
    const t = await tray(30);
    const plan = batchPlan(SESSION, t.open());
    expect(plan.accept).toHaveLength(30);
    const { batchId, reviews } = batchReviews(plan.accept, {
      entities: {},
      timing: { decisionMs: 2_400, handlingMs: 2_400 },
      input: "pointer",
      surface: "tray",
    });
    const at = new Date();
    const accepted = t.store.apply({
      sessionId: SESSION,
      items: plan.accept.map((proposal, index) => ({
        proposalId: proposal.proposalId,
        previous: stateOf(proposal),
        next: { ...reviewedState(reviews[index] as ReviewInput, at, 30_000), snoozedUntil: null },
      })),
      request: { reviews, snoozes: [] },
    });
    expect(t.open()).toHaveLength(0);
    await settle(800);
    await expect(accepted).resolves.toEqual({ ok: true });
    const messages = reviewMessages(t.server);
    expect(messages.map((message) => message.reviews.length)).toEqual([25, 5]);
    expect(new Set(messages.flatMap((m) => m.reviews.map((r) => r.batchId)))).toEqual(
      new Set([batchId]),
    );
    const approvals = t.server.log.filter((event) => event.type === "proposal.reviewed");
    expect(approvals).toHaveLength(30);

    // One undo: a reopen per card, each naming its own review, in batch mode with the batch's id.
    const items = batchItems(t.session().proposals, batchId);
    expect(items).toHaveLength(30);
    const reopens = batchUndoReviews(items, {
      batchId,
      entities: {},
      input: "keyboard",
      surface: "tray",
    });
    const undone = t.store.apply({
      sessionId: SESSION,
      items: items.map((proposal, index) => ({
        proposalId: proposal.proposalId,
        previous: stateOf(proposal),
        next: { ...reviewedState(reopens[index] as ReviewInput, at, 30_000), snoozedUntil: null },
      })),
      request: { reviews: reopens, snoozes: [] },
    });
    expect(t.open()).toHaveLength(30);
    await settle(800);
    await expect(undone).resolves.toEqual({ ok: true });
    expect(reviewMessages(t.server).map((message) => message.reviews.length)).toEqual([
      25, 5, 25, 5,
    ]);
    const folded = t.client.store.getState().projections.proposals;
    expect(folded.every((proposal) => proposal.status === "proposed")).toBe(true);
  });

  it("sends a snooze as a snooze message", async () => {
    const t = await tray(1);
    const [proposal] = t.open();
    if (!proposal) throw new Error("no card");
    const snooze = snoozeOf(proposal.proposalId, new Date("2026-11-21T09:00:00.000Z"));
    const landed = t.store.apply(
      singleChange(
        SESSION,
        proposal.proposalId,
        { previous: stateOf(proposal), next: { ...stateOf(proposal), snoozedUntil: snooze.until } },
        { reviews: [], snoozes: [snooze] },
      ),
    );
    await settle(400);
    await expect(landed).resolves.toEqual({ ok: true });
    expect(t.server.received.some((message) => message.t === "snooze")).toBe(true);
    expect(t.server.log.at(-1)?.type).toBe("proposal.snoozed");
  });

  it("after the seal, hands each review to the web route under the same review id, and keeps working", async () => {
    const t = await tray(2);
    t.server.seal();
    await settle(400);
    // The seal reached the tray: it says the debrief is done and links to the inbox.
    expect(t.session().sealedAt).not.toBeNull();
    const before = t.server.log.length;
    const [first] = t.open();
    if (!first) throw new Error("no card");
    const review = decisionReview({
      proposal: first,
      entities: {},
      decision: "rejected",
      timing: { decisionMs: 600, handlingMs: 600 },
      input: "pointer",
      surface: "tray",
    });
    const landed = t.store.apply(decided(review, first));
    await settle(400);
    await expect(landed).resolves.toEqual({ ok: true });
    // SessionDO refused it with `sealed` and wrote nothing; the route got the same review.
    expect(t.server.log).toHaveLength(before);
    expect(t.route).toHaveBeenCalledTimes(1);
    expect(t.route.mock.calls[0]?.[0].reviews.map((r) => r.reviewId)).toEqual([review.reviewId]);

    // Once the client has closed for good (the capture screen stops it after the seal), reviews
    // go straight to the route.
    t.client.stop();
    const [second] = t.open();
    if (!second) throw new Error("no card");
    const next = decisionReview({
      proposal: second,
      entities: {},
      decision: "approved",
      timing: { decisionMs: 700, handlingMs: 700 },
      input: "keyboard",
      surface: "tray",
    });
    await expect(t.store.apply(decided(next, second))).resolves.toEqual({ ok: true });
    expect(t.route.mock.calls[1]?.[0].reviews.map((r) => r.reviewId)).toEqual([next.reviewId]);
  });

  it("brings a card back with the route's refusal when the seal hasn't reached Postgres", async () => {
    const t = await tray(1);
    t.route.mockRejectedValue(new ReviewRouteFailure("not_sealed", { status: 409 }));
    t.server.seal();
    await settle(400);
    const [proposal] = t.open();
    if (!proposal) throw new Error("no card");
    const review = decisionReview({
      proposal,
      entities: {},
      decision: "approved",
      timing: { decisionMs: 500, handlingMs: 500 },
      input: "keyboard",
      surface: "tray",
    });
    const result = await (async () => {
      const landed = t.store.apply(decided(review, proposal));
      await settle(400);
      return landed;
    })();
    expect(result).toEqual({ ok: false, reason: "not_sealed" });
    expect(t.open().map((p) => p.proposalId)).toEqual([proposal.proposalId]);
  });
});
