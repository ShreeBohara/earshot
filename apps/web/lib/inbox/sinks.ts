// Where the inbox's reviews go (Phase 5 spec WP5 step 4, WP6): a `ReviewSink`. In the inbox it's the
// web route, `POST /api/sessions/:id/reviews` (`routeSink`); the capture screen's tray sends over
// the session socket (`socketSink`, on `SessionClient`, which hands a sealed session's reviews to
// the same route under the same review ids); WP7's pilot page will fold events in the page.
//
// Actions are optimistic (`OptimisticReviews`): the card leaves at once, and focus moves with it,
// within 100 ms (target), while the request goes out behind it. Changes leave one at a time, in
// order, so an undo never overtakes the review it reverses.
//
// A change is one action over one or more cards: a decision, a snooze, an undo, or "accept all"
// (a batch), which leaves and comes back as a whole and reports one failure. A change too big for
// one request (25 items or 64 KiB, the route's and the socket's limits) is split into several, in
// order, each its own all-or-nothing write; a batch keeps its `batchId` across them. The first
// refusal stops the rest. Cards whose part already landed stay as the change made them (the log
// holds their reviews, so showing them back would be false), and the batch's undo reverses exactly
// those; the refused part and anything unsent come back as they were. Anything queued after the
// change that built on a card that came back (an undo of a review that never landed) is dropped
// for that card, and the one failure says how many landed.
import type {
  ReviewInput,
  ReviewRouteError,
  ReviewRouteErrorBody,
  ReviewRouteResponse,
  SnoozeInput,
} from "@earshot/core";
import type { ProposalStatus } from "@earshot/events";
import { type ReviewDelivery, splitReviews } from "@earshot/voice/session";
import type { InboxProposal, InboxReview } from "./types";

/** One request's reviews and snoozes, for one debrief. */
export interface ReviewRequest {
  readonly reviews: readonly ReviewInput[];
  readonly snoozes: readonly SnoozeInput[];
}

/**
 * Why a sink refused:
 * - `stale`: the card changed since it loaded (decided, reopened, or replaced elsewhere);
 * - `not_sealed`: the debrief is still finishing;
 * - `sealed`: the debrief is done and its session takes no more reviews (the tray, with no route);
 * - `unavailable`: reviews can't be recorded here now (no audit signing key);
 * - `invalid`: the review broke a rule (a bug, or a page out of date);
 * - `gone`: the debrief isn't there any more, or isn't the viewer's;
 * - `signed_out`: the sign-in ended;
 * - `failed`: the network or the server failed.
 */
export type SinkRefusal =
  | "stale"
  | "not_sealed"
  | "sealed"
  | "unavailable"
  | "invalid"
  | "gone"
  | "signed_out"
  | "failed";

export type SinkResult =
  | {
      readonly ok: true;
      /**
       * The session log's seq the write reached, when the writer said (the route's `lastSeq`, the
       * socket's ack). `OptimisticReviews.reconcile` reads it to tell when the session's own
       * events have caught up with the write, or gone past it.
       */
      readonly seq?: number;
    }
  | { readonly ok: false; readonly reason: SinkRefusal };

/**
 * Takes one request: reviews and snoozes for one debrief, within one request's limits (25 items and
 * 64 KiB; `OptimisticReviews` splits anything bigger), written all or nothing.
 */
export interface ReviewSink {
  send(sessionId: string, request: ReviewRequest): Promise<SinkResult>;
}

const ROUTE_REFUSALS: Readonly<Partial<Record<ReviewRouteError, SinkRefusal>>> = {
  stale: "stale",
  not_sealed: "not_sealed",
  audit_unavailable: "unavailable",
  invalid_request: "invalid",
  too_large: "invalid",
  not_found: "gone",
  unauthorized: "signed_out",
  forbidden: "invalid",
};

/** The web route as a sink: one POST per request, answered by its fixed codes. */
export function routeSink(fetcher: typeof fetch = fetch): ReviewSink {
  return {
    async send(sessionId, request) {
      let response: Response;
      try {
        response = await fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/reviews`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reviews: request.reviews, snoozes: request.snoozes }),
          credentials: "same-origin",
          cache: "no-store",
        });
      } catch {
        return { ok: false, reason: "failed" };
      }
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as ReviewRouteResponse | null;
        if (!body?.sessionId) return { ok: false, reason: "failed" };
        return typeof body.lastSeq === "number" ? { ok: true, seq: body.lastSeq } : { ok: true };
      }
      const body = (await response.json().catch(() => null)) as ReviewRouteErrorBody | null;
      const reason = body?.error ? ROUTE_REFUSALS[body.error] : undefined;
      return { ok: false, reason: reason ?? "failed" };
    },
  };
}

/**
 * What the tray's sink needs of `SessionClient`: its session, and its review and snooze writes.
 * They go over the socket while `SessionDO` takes them, and to the web route with the same ids
 * once it refuses them with `sealed` or the client has closed for good (WP3).
 */
export interface ReviewWriter {
  readonly sessionId: string;
  sendReview(reviews: readonly ReviewInput[]): Promise<readonly ReviewDelivery[]>;
  sendSnooze(snooze: SnoozeInput): Promise<ReviewDelivery>;
}

/**
 * A failed delivery's code, as a refusal: `SessionDO`'s codes (`bad_message` for a review its rules
 * refused, `internal` with no audit signing key, `sealed` with no route to hand it to), the route's
 * once the client hands a sealed session's reviews over, and the client's own `closed`.
 */
const DELIVERY_REFUSALS: Readonly<Record<string, SinkRefusal>> = {
  bad_message: "invalid",
  too_large: "invalid",
  internal: "unavailable",
  sealed: "sealed",
  stale: "stale",
  not_sealed: "not_sealed",
  audit_unavailable: "unavailable",
  invalid_request: "invalid",
  forbidden: "invalid",
  not_found: "gone",
  unauthorized: "signed_out",
};

/**
 * The session socket as a sink, for the capture screen's tray: a request's reviews as one `review`
 * message (`OptimisticReviews` keeps each within a message's limits), and each snooze as its own
 * `snooze`. A sealed session's go to the route with the same ids, so the tray keeps working after
 * the hand-over; the request is answered by the first delivery that failed, if any.
 */
export function socketSink(writer: ReviewWriter): ReviewSink {
  return {
    async send(sessionId, request) {
      if (sessionId !== writer.sessionId) return { ok: false, reason: "gone" };
      const deliveries: ReviewDelivery[] = [];
      if (request.reviews.length > 0)
        deliveries.push(...(await writer.sendReview(request.reviews)));
      for (const snooze of request.snoozes) deliveries.push(await writer.sendSnooze(snooze));
      let seq: number | undefined;
      for (const delivery of deliveries) {
        if (!delivery.ok)
          return { ok: false, reason: DELIVERY_REFUSALS[delivery.code] ?? "failed" };
        if (delivery.seq !== undefined) seq = Math.max(seq ?? delivery.seq, delivery.seq);
      }
      return seq === undefined ? { ok: true } : { ok: true, seq };
    },
  };
}

/** What the page has done to a proposal, over what the loader read. */
export interface LocalState {
  readonly status: ProposalStatus;
  readonly review: InboxReview | null;
  readonly snoozedUntil: string | null;
}

/** A proposal's own state, as `LocalState`. */
export function stateOf(
  proposal: Pick<InboxProposal, "status" | "review" | "snoozedUntil">,
): LocalState {
  return { status: proposal.status, review: proposal.review, snoozedUntil: proposal.snoozedUntil };
}

/** One card's part of a change: what it becomes, and what it was. */
export interface ChangeItem {
  readonly proposalId: string;
  readonly next: LocalState;
  readonly previous: LocalState;
}

/**
 * One optimistic change: one action over one or more cards of one debrief (a batch takes several),
 * and the request that records it.
 */
export interface Change {
  readonly sessionId: string;
  readonly items: readonly ChangeItem[];
  readonly request: ReviewRequest;
}

/** A change with one card: a decision, a snooze, a wake, or an undo. */
export function singleChange(
  sessionId: string,
  proposalId: string,
  states: { readonly previous: LocalState; readonly next: LocalState },
  request: ReviewRequest,
): Change {
  return { sessionId, items: [{ proposalId, ...states }], request };
}

/**
 * A change that didn't all land: why, the cards that came back as they were, and the cards whose
 * part landed before the refusal, which stay as the change made them.
 */
export interface Failure {
  readonly change: Change;
  readonly reason: SinkRefusal;
  readonly failed: readonly ChangeItem[];
  readonly landed: readonly ChangeItem[];
}

/** The most items one request carries: the route's, and a `review` message's (target). */
const MAX_REQUEST_ITEMS = 25;

/**
 * A request as the requests it takes, in order: reviews by count (25) and by bytes (64 KiB, as
 * `splitReviews` sizes a socket frame, which a route body of the same reviews is smaller than),
 * then snoozes, 25 at a time. A request within the limits is itself, unchanged.
 */
export function splitRequest(request: ReviewRequest): ReviewRequest[] {
  const parts: ReviewRequest[] = splitReviews(request.reviews).map((reviews) => ({
    reviews,
    snoozes: [],
  }));
  for (let index = 0; index < request.snoozes.length; index += MAX_REQUEST_ITEMS) {
    parts.push({ reviews: [], snoozes: request.snoozes.slice(index, index + MAX_REQUEST_ITEMS) });
  }
  if (parts.length <= 1) return [request];
  return parts;
}

/** The cards a request writes for. */
function proposalsOf(request: ReviewRequest): Set<string> {
  return new Set([
    ...request.reviews.map((review) => review.proposalId),
    ...request.snoozes.map((snooze) => snooze.proposalId),
  ]);
}

/** A request without the items for `dropped` cards. */
function without(request: ReviewRequest, dropped: ReadonlySet<string>): ReviewRequest {
  return {
    reviews: request.reviews.filter((review) => !dropped.has(review.proposalId)),
    snoozes: request.snoozes.filter((snooze) => !dropped.has(snooze.proposalId)),
  };
}

interface Queued {
  readonly change: Change;
  readonly resolve: (result: SinkResult) => void;
}

/**
 * The page's own changes over the loaded data, applied at once and sent in order. Subscribe to
 * re-render; `overlay()` is a fresh map after every change, for `useSyncExternalStore`.
 */
export class OptimisticReviews {
  readonly #sink: ReviewSink;
  readonly #onFailure: (failure: Failure) => void;
  readonly #listeners = new Set<() => void>();
  #queue: Queued[] = [];
  #overlay: ReadonlyMap<string, LocalState> = new Map();
  #pendingIds: ReadonlySet<string> = new Set();
  /** Each card's latest landed write: the log's seq it reached, when its writer said. */
  readonly #reached = new Map<string, number>();
  #sending = false;

  constructor(sink: ReviewSink, options: { onFailure?: (failure: Failure) => void } = {}) {
    this.#sink = sink;
    this.#onFailure = options.onFailure ?? (() => {});
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly overlay = (): ReadonlyMap<string, LocalState> => this.#overlay;

  /** Whether a change to `proposalId` is still on its way. */
  pending(proposalId: string): boolean {
    return this.#pendingIds.has(proposalId);
  }

  /**
   * The cards with a change still on its way: a fresh set whenever the queue changes, for
   * `useSyncExternalStore` (a change landing moves no card, but frees it to join a batch).
   */
  readonly pendingIds = (): ReadonlySet<string> => this.#pendingIds;

  /** How many changes are still on their way: a number, for `useSyncExternalStore`. */
  readonly queued = (): number => this.#queue.length;

  /**
   * Applies `change` to every card it touches now, in one update, and sends it after any before
   * it. Resolves with how it landed: ok only if every part did.
   */
  apply(change: Change): Promise<SinkResult> {
    const result = new Promise<SinkResult>((resolve) => {
      this.#queue.push({ change, resolve });
    });
    this.#queueChanged();
    this.#set(change.items.map((item) => [item.proposalId, item.next]));
    void this.#drain();
    return result;
  }

  /**
   * Forgets the page's state for proposals whose loaded state has caught up with it, or gone past
   * it, so the loaded state is the authority again. Changes still on their way stay. Any of these
   * is enough:
   * - **Caught up:** the loaded card is what the page made it (status, latest review, and snooze).
   * - **Reversed:** the loaded latest review reverses the page's (its `undoes` names it), such as
   *   `SessionDO`'s system reopen after a late flag, or an undo made elsewhere.
   * - **Gone past:** the loaded latest review's seq is at or past the seq the page's write
   *   reached, when its writer said (the tray's cards come from the session's own events, which
   *   carry it). The events hold the write and whatever followed it.
   *
   * Without the last two, an event that overtook the page's write before this ran (a list that
   * renders deferred can skip the approved state between them) left the page's approval showing
   * forever, hiding the reopen.
   */
  reconcile(
    loaded: Iterable<Pick<InboxProposal, "proposalId" | "status" | "review" | "snoozedUntil">>,
  ): void {
    let changed = false;
    const next = new Map(this.#overlay);
    for (const proposal of loaded) {
      const local = next.get(proposal.proposalId);
      if (!local || this.pending(proposal.proposalId)) continue;
      const caughtUp =
        local.status === proposal.status &&
        (local.review?.reviewId ?? null) === (proposal.review?.reviewId ?? null) &&
        local.snoozedUntil === proposal.snoozedUntil;
      const reversed =
        local.review !== null &&
        proposal.review !== null &&
        proposal.review.undoes === local.review.reviewId;
      const reached = this.#reached.get(proposal.proposalId);
      const loadedSeq = proposal.review?.seq;
      const gonePast = reached !== undefined && loadedSeq !== undefined && loadedSeq >= reached;
      if (caughtUp || reversed || gonePast) {
        next.delete(proposal.proposalId);
        this.#reached.delete(proposal.proposalId);
        changed = true;
      }
    }
    if (changed) {
      this.#overlay = next;
      this.#emit();
    }
  }

  async #drain(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    try {
      for (let queued = this.#queue[0]; queued; queued = this.#queue[0]) {
        const { change } = queued;
        // Part by part, in order; the first refusal stops the rest.
        const landed = new Set<string>();
        let refusal: SinkRefusal | null = null;
        for (const part of splitRequest(change.request)) {
          let result: SinkResult;
          try {
            result = await this.#sink.send(change.sessionId, part);
          } catch {
            result = { ok: false, reason: "failed" };
          }
          if (!result.ok) {
            refusal = result.reason;
            break;
          }
          for (const proposalId of proposalsOf(part)) {
            landed.add(proposalId);
            if (result.seq !== undefined) {
              const before = this.#reached.get(proposalId);
              this.#reached.set(proposalId, Math.max(before ?? result.seq, result.seq));
            }
          }
        }
        this.#queue.shift();
        this.#queueChanged();
        if (refusal === null) {
          queued.resolve({ ok: true });
          this.#emit();
        } else {
          queued.resolve({ ok: false, reason: refusal });
          this.#rollback(change, landed, refusal);
        }
      }
    } finally {
      this.#sending = false;
    }
  }

  #rollback(change: Change, landed: ReadonlySet<string>, reason: SinkRefusal): void {
    const failed = change.items.filter((item) => !landed.has(item.proposalId));
    const stood = change.items.filter((item) => landed.has(item.proposalId));
    const back = new Set(failed.map((item) => item.proposalId));
    // Anything queued after it that built on a card coming back: drop that card's part unsent,
    // and the whole change if nothing else is left of it.
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const queued = this.#queue[index];
      if (!queued?.change.items.some((item) => back.has(item.proposalId))) continue;
      const items = queued.change.items.filter((item) => !back.has(item.proposalId));
      if (items.length === 0) {
        this.#queue.splice(index, 1);
        queued.resolve({ ok: false, reason });
        continue;
      }
      this.#queue[index] = {
        change: { ...queued.change, items, request: without(queued.change.request, back) },
        resolve: queued.resolve,
      };
    }
    this.#queueChanged();
    if (failed.length > 0) this.#set(failed.map((item) => [item.proposalId, item.previous]));
    else this.#emit();
    this.#onFailure({ change, reason, failed, landed: stood });
  }

  #queueChanged(): void {
    this.#pendingIds = new Set(
      this.#queue.flatMap((queued) => queued.change.items.map((item) => item.proposalId)),
    );
  }

  #set(entries: readonly (readonly [string, LocalState])[]): void {
    if (entries.length === 0) return;
    const next = new Map(this.#overlay);
    for (const [proposalId, state] of entries) next.set(proposalId, state);
    this.#overlay = next;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** A proposal with the page's own state for it, if the page has any. */
export function withLocal<T extends InboxProposal>(
  proposal: T,
  overlay: ReadonlyMap<string, LocalState>,
): T {
  const local = overlay.get(proposal.proposalId);
  return local ? { ...proposal, ...local } : proposal;
}
