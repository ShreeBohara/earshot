// Where the inbox's reviews go (Phase 5 spec WP5 step 4): a `ReviewSink`. Here it's the web route,
// `POST /api/sessions/:id/reviews` (`routeSink`); WP6 adds the session socket for the tray, and
// WP7 a local sink for the pilot page, which folds events in the page.
//
// Actions are optimistic (`OptimisticReviews`): the card leaves at once, and focus moves with it,
// within 100 ms (target), while the request goes out behind it. Requests leave one at a time, in
// order, so an undo never overtakes the review it reverses. A refusal brings the card back as it
// was, drops anything queued after it for the same proposal (an undo of a review that never
// landed), and is reported once, for the page's one urgent message.
import type {
  ReviewInput,
  ReviewRouteError,
  ReviewRouteErrorBody,
  ReviewRouteResponse,
  SnoozeInput,
} from "@earshot/core";
import type { ProposalStatus } from "@earshot/events";
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
 * - `unavailable`: reviews can't be recorded here now (no audit signing key);
 * - `invalid`: the review broke a rule (a bug, or a page out of date);
 * - `gone`: the debrief isn't there any more, or isn't the viewer's;
 * - `signed_out`: the sign-in ended;
 * - `failed`: the network or the server failed.
 */
export type SinkRefusal =
  | "stale"
  | "not_sealed"
  | "unavailable"
  | "invalid"
  | "gone"
  | "signed_out"
  | "failed";

export type SinkResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SinkRefusal };

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
        return body?.sessionId ? { ok: true } : { ok: false, reason: "failed" };
      }
      const body = (await response.json().catch(() => null)) as ReviewRouteErrorBody | null;
      const reason = body?.error ? ROUTE_REFUSALS[body.error] : undefined;
      return { ok: false, reason: reason ?? "failed" };
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

/** One optimistic change: what the proposal becomes, what it was, and the request that records it. */
export interface Change {
  readonly sessionId: string;
  readonly proposalId: string;
  readonly next: LocalState;
  readonly previous: LocalState;
  readonly request: ReviewRequest;
}

/** A change that didn't land: why, and the state the card went back to. */
export interface Failure {
  readonly change: Change;
  readonly reason: SinkRefusal;
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
  readonly #queue: Queued[] = [];
  #overlay: ReadonlyMap<string, LocalState> = new Map();
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
    return this.#queue.some((queued) => queued.change.proposalId === proposalId);
  }

  /** How many changes are still on their way: a number, for `useSyncExternalStore`. */
  readonly queued = (): number => this.#queue.length;

  /** Applies `change` now and sends it after any before it. Resolves with how it landed. */
  apply(change: Change): Promise<SinkResult> {
    this.#set(change.proposalId, change.next);
    const result = new Promise<SinkResult>((resolve) => {
      this.#queue.push({ change, resolve });
    });
    void this.#drain();
    return result;
  }

  /**
   * Forgets the page's state for proposals whose loaded state has caught up with it: a fresh load
   * holds the review the page made. Changes still on their way stay.
   */
  reconcile(
    loaded: Iterable<Pick<InboxProposal, "proposalId" | "status" | "review" | "snoozedUntil">>,
  ): void {
    let changed = false;
    const next = new Map(this.#overlay);
    for (const proposal of loaded) {
      const local = next.get(proposal.proposalId);
      if (!local || this.pending(proposal.proposalId)) continue;
      if (
        local.status === proposal.status &&
        (local.review?.reviewId ?? null) === (proposal.review?.reviewId ?? null) &&
        local.snoozedUntil === proposal.snoozedUntil
      ) {
        next.delete(proposal.proposalId);
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
        let result: SinkResult;
        try {
          result = await this.#sink.send(change.sessionId, change.request);
        } catch {
          result = { ok: false, reason: "failed" };
        }
        this.#queue.shift();
        queued.resolve(result);
        if (result.ok) this.#emit();
        else this.#rollback(change, result.reason);
      }
    } finally {
      this.#sending = false;
    }
  }

  #rollback(change: Change, reason: SinkRefusal): void {
    // Anything queued after it for the same proposal built on it: drop it unsent.
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const queued = this.#queue[index];
      if (queued?.change.proposalId !== change.proposalId) continue;
      this.#queue.splice(index, 1);
      queued.resolve({ ok: false, reason });
    }
    this.#set(change.proposalId, change.previous);
    this.#onFailure({ change, reason });
  }

  #set(proposalId: string, state: LocalState): void {
    const next = new Map(this.#overlay);
    next.set(proposalId, state);
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
