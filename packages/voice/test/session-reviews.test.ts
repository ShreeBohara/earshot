// The tray's reviews from SessionClient (Phase 5 WP3): split by count and by bytes to fit the
// socket, idempotent by review id, and sent to the web route with the same ids once SessionDO
// seals the session. Against the in-memory SessionDO, on a manual clock.
import {
  MAX_MESSAGE_BYTES,
  MAX_REVIEWS_PER_MESSAGE,
  type ReviewInput,
  type ReviewRouteResponse,
} from "@earshot/core";
import { describe, expect, it, vi } from "vitest";
import { createSessionClient } from "../src/session/client";
import {
  createReviewRoute,
  type ReviewRoute,
  ReviewRouteFailure,
  reviewFrameBytes,
  splitReviews,
} from "../src/session/reviews";
import { FakePageLifecycle } from "../src/testing/fake-page";
import { FakeSessionServer } from "../src/testing/fake-session-server";
import { settle } from "../src/testing/fake-socket";
import { counterIds } from "./support/ids";
import { ManualClock } from "./support/manual-clock";

const SESSION = "0000000a-0000-7000-8000-00000000beef";
const ENTITY = "01a0f831-ac00-75a0-a2b2-cb79eb1835bf";

let count = 0;
const uuid = (prefix: string) => {
  count += 1;
  return `${prefix}-0000-7000-8000-${count.toString(16).padStart(12, "0")}`;
};

/** A proposal SessionDO would write: a task linked to one record, unmarked. */
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

function reviewOf(proposalId: string, overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    reviewId: uuid("0000000f"),
    proposalId,
    decision: "approved",
    target: null,
    mode: "single",
    batchId: null,
    policy: null,
    undoes: null,
    reason: null,
    seen: { tier: "none", fields: {}, target: null, relinked: null, clip: "none" },
    timing: { decisionMs: 700, handlingMs: 700 },
    input: "keyboard",
    surface: "tray",
    ...overrides,
  };
}

async function harness(options: { proposals?: number; route?: ReviewRoute } = {}) {
  const clock = new ManualClock();
  const server = new FakeSessionServer({
    sessionId: SESSION,
    reviewer: {
      userId: "user-1",
      auth: { method: "passkey", signedInAt: "2026-11-20T08:00:00.000Z" },
    },
  });
  const client = createSessionClient({
    sessionId: SESSION,
    url: server.edgeUrl,
    socket: server.factory,
    clock,
    random: () => 0.5,
    createId: counterIds(),
    page: new FakePageLifecycle(),
    getTicket: async () => server.issueTicket(),
    // A budget wide enough for a long batch, so the test needn't wait out the pacing.
    sendBudget: { burst: 100, perSecond: 100 },
    ...(options.route ? { reviewRoute: options.route } : {}),
  });
  client.start();
  await settle(400);
  client.sendStart({
    providers: {
      speechToText: { provider: "assemblyai", model: "universal-streaming-english" },
      llm: { provider: "anthropic", model: "claude-haiku-5-5" },
    },
    startedAt: "2026-11-20T12:00:00.000Z",
    entities: [],
  });
  await settle(400);
  const proposals = Array.from({ length: options.proposals ?? 1 }, () => {
    const proposal = linkedProposal();
    server.append("proposal.created", proposal);
    return proposal;
  });
  await settle(400);
  return { clock, server, client, proposals };
}

const reviewMessages = (server: FakeSessionServer) =>
  server.received.flatMap((message) => (message.t === "review" ? [message] : []));

describe("splitReviews", () => {
  it("splits by count, 25 a message, keeping the order", () => {
    const reviews = Array.from({ length: 60 }, (_, n) =>
      reviewOf(`0000000e-0000-7000-8000-${n.toString(16).padStart(12, "0")}`),
    );
    const groups = splitReviews(reviews);
    expect(groups.map((group) => group.length)).toEqual([25, 25, 10]);
    expect(groups.flat()).toEqual(reviews);
    expect(MAX_REVIEWS_PER_MESSAGE).toBe(25);
  });

  it("splits by bytes as well, so no frame passes 64 KiB", () => {
    const big = "x".repeat(6_000);
    const reviews = Array.from({ length: 30 }, () =>
      reviewOf(uuid("0000000e"), {
        seen: {
          tier: "none",
          fields: { body: { proposed: big } },
          target: null,
          relinked: null,
          clip: "none",
        },
      }),
    );
    const groups = splitReviews(reviews);
    expect(groups.length).toBeGreaterThan(Math.ceil(30 / 25));
    for (const group of groups)
      expect(reviewFrameBytes(group)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(groups.flat()).toEqual(reviews);
  });
});

describe("SessionClient.sendReview", () => {
  it("sends one decision as one review message, which SessionDO fills in and appends", async () => {
    const h = await harness();
    const [proposal] = h.proposals;
    const review = reviewOf(proposal?.proposalId ?? "");
    const pending = h.client.sendReview([review]);
    await settle(400);
    const [delivery] = await pending;
    expect(delivery).toMatchObject({ ok: true, via: "socket", ids: [review.reviewId] });
    const event = h.server.log.at(-1);
    expect(event).toMatchObject({ type: "proposal.reviewed", schemaVersion: 2 });
    expect(event?.payload).toMatchObject({
      reviewId: review.reviewId,
      by: { userId: "user-1", auth: { method: "passkey" } },
    });
    if (delivery?.ok) expect(delivery.seq).toBe(event?.seq);
  });

  it("sends an accept-all of 60 as three messages with one batch id, all acknowledged", async () => {
    const h = await harness({ proposals: 60 });
    const batchId = uuid("00000010");
    const reviews = h.proposals.map((p) => reviewOf(p.proposalId, { mode: "batch", batchId }));
    const pending = h.client.sendReview(reviews);
    await settle(800);
    const deliveries = await pending;
    expect(deliveries.map((d) => d.ok && d.via)).toEqual(["socket", "socket", "socket"]);
    expect(reviewMessages(h.server).map((m) => m.reviews.length)).toEqual([25, 25, 10]);
    expect(h.server.log.filter((e) => e.type === "proposal.reviewed")).toHaveLength(60);
  });

  it("reports a review too big for any frame as too_large, and sends the rest", async () => {
    const h = await harness({ proposals: 2 });
    const huge = reviewOf(h.proposals[0]?.proposalId ?? "", {
      seen: {
        tier: "none",
        fields: { body: { proposed: "x".repeat(70_000) } },
        target: null,
        relinked: null,
        clip: "none",
      },
    });
    const fine = reviewOf(h.proposals[1]?.proposalId ?? "");
    const pending = h.client.sendReview([huge, fine]);
    await settle(400);
    expect(await pending).toEqual([
      { ok: false, ids: [huge.reviewId], code: "too_large" },
      expect.objectContaining({ ok: true, via: "socket", ids: [fine.reviewId] }),
    ]);
    expect(reviewMessages(h.server)).toHaveLength(1);
  });

  it("resolves a refusal as a failed delivery, never a rejection", async () => {
    const h = await harness();
    const review = reviewOf(h.proposals[0]?.proposalId ?? "", { target: { entityId: "co_none" } });
    const pending = h.client.sendReview([review]);
    await settle(400);
    expect(await pending).toEqual([{ ok: false, ids: [review.reviewId], code: "bad_message" }]);
  });

  it("refuses an accept-all item tierOf marks, as SessionDO does: the name note, not a lone self-correction", async () => {
    const h = await harness({ proposals: 0 });
    const soundLink = linkedProposal();
    // Linked by sound below 0.97: only the name note, but a marker all the same.
    const named = {
      ...soundLink,
      target: { ...soundLink.target, basis: "sound", p: 0.9 },
      riskFlags: [{ kind: "link_uncertain", field: "target" }],
    };
    // A flag, but no marker: the model took the rep's correction.
    const corrected = {
      ...linkedProposal(),
      riskFlags: [{ kind: "self_correction", field: "title" }],
    };
    h.server.append("proposal.created", named);
    h.server.append("proposal.created", corrected);
    await settle(400);
    const batchId = uuid("00000010");
    const refused = reviewOf(named.proposalId, { mode: "batch", batchId });
    const taken = reviewOf(corrected.proposalId, { mode: "batch", batchId });
    const first = h.client.sendReview([refused]);
    await settle(400);
    expect(await first).toEqual([{ ok: false, ids: [refused.reviewId], code: "bad_message" }]);
    const second = h.client.sendReview([taken]);
    await settle(400);
    expect(await second).toEqual([
      expect.objectContaining({ ok: true, via: "socket", ids: [taken.reviewId] }),
    ]);
  });

  it("sends a review SessionDO refuses with sealed to the web route, with the same review id", async () => {
    const sent: unknown[] = [];
    const route: ReviewRoute = async (request) => {
      sent.push(request);
      return {
        sessionId: SESSION,
        reviews: request.reviews.map((r) => ({ id: r.reviewId, seq: 9, recorded: "now" as const })),
        snoozes: [],
        lastSeq: 9,
      };
    };
    const h = await harness({ route });
    h.server.seal();
    await settle(400);
    const review = reviewOf(h.proposals[0]?.proposalId ?? "");
    const pending = h.client.sendReview([review]);
    await settle(400);
    expect(await pending).toEqual([{ ok: true, via: "route", ids: [review.reviewId], seq: 9 }]);
    expect(sent).toEqual([{ reviews: [review], snoozes: [] }]);
    // SessionDO wrote nothing after its seal.
    expect(h.server.log.at(-1)?.type).toBe("session.sealed");
  });

  it("without a route, reports the sealed refusal; once closed for good, goes straight to the route", async () => {
    const h = await harness();
    h.server.seal();
    await settle(400);
    const review = reviewOf(h.proposals[0]?.proposalId ?? "");
    const pending = h.client.sendReview([review]);
    await settle(400);
    expect(await pending).toEqual([{ ok: false, ids: [review.reviewId], code: "sealed" }]);

    const route = vi.fn<ReviewRoute>(async () => ({
      sessionId: SESSION,
      reviews: [],
      snoozes: [],
      lastSeq: 4,
    }));
    const closed = await harness({ route });
    closed.client.stop();
    const later = await closed.client.sendReview([reviewOf(closed.proposals[0]?.proposalId ?? "")]);
    expect(later).toMatchObject([{ ok: true, via: "route" }]);
    expect(route).toHaveBeenCalledTimes(1);
  });
});

describe("SessionClient.sendSnooze", () => {
  it("snoozes over the socket, idempotent by snooze id, and through the route after the seal", async () => {
    const route = vi.fn<ReviewRoute>(async (request) => ({
      sessionId: SESSION,
      reviews: [],
      snoozes: request.snoozes.map((s) => ({ id: s.snoozeId, seq: 7, recorded: "now" as const })),
      lastSeq: 7,
    }));
    const h = await harness({ route });
    const proposalId = h.proposals[0]?.proposalId ?? "";
    const snooze = { snoozeId: uuid("00000011"), proposalId, until: "2026-11-21T09:00:00.000Z" };
    const first = h.client.sendSnooze(snooze);
    await settle(400);
    expect(await first).toMatchObject({ ok: true, via: "socket", ids: [snooze.snoozeId] });
    const again = h.client.sendSnooze(snooze);
    await settle(400);
    expect(await again).toMatchObject({ ok: true, via: "socket" });
    expect(h.server.log.filter((e) => e.type === "proposal.snoozed")).toHaveLength(1);

    h.server.seal();
    await settle(400);
    const wake = { snoozeId: uuid("00000011"), proposalId, until: null };
    const sealedSnooze = h.client.sendSnooze(wake);
    await settle(400);
    expect(await sealedSnooze).toEqual({ ok: true, via: "route", ids: [wake.snoozeId], seq: 7 });
    expect(route).toHaveBeenCalledWith({ reviews: [], snoozes: [wake] });
  });
});

describe("createReviewRoute", () => {
  const answer: ReviewRouteResponse = { sessionId: SESSION, reviews: [], snoozes: [], lastSeq: 3 };

  it("posts the reviews as JSON, same-origin, and waits out not_sealed until the seal lands", async () => {
    const clock = new ManualClock();
    const calls: RequestInit[] = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return calls.length === 1
        ? Response.json({ error: "not_sealed", message: "…" }, { status: 409 })
        : Response.json(answer);
    });
    const route = createReviewRoute({
      sessionId: SESSION,
      fetch: fetch as unknown as typeof globalThis.fetch,
      retry: { clock, random: () => 0.5 },
    });
    const review = reviewOf("0000000e-0000-7000-8000-0000000000aa");
    const pending = route({ reviews: [review], snoozes: [] });
    await settle();
    await clock.advance(2_000);
    expect(await pending).toEqual(answer);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/sessions/${SESSION}/reviews`);
    expect(calls[0]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ reviews: [review], snoozes: [] });
  });

  it("gives up at once on stale, and on an answer for another session", async () => {
    const stale = createReviewRoute({
      sessionId: SESSION,
      fetch: (async () =>
        Response.json({ error: "stale", message: "…" }, { status: 409 })) as never,
    });
    const refused = await stale({ reviews: [], snoozes: [] }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ReviewRouteFailure);
    expect(refused).toMatchObject({ code: "stale", status: 409, retryable: false });

    const other = createReviewRoute({
      sessionId: SESSION,
      fetch: (async () => Response.json({ ...answer, sessionId: "someone-else" })) as never,
    });
    expect(
      await other({ reviews: [], snoozes: [] }).catch((error: unknown) => error),
    ).toMatchObject({
      code: "bad_response",
    });
  });
});
