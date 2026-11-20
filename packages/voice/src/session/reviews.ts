// Reviews from the browser (Phase 5 WP3, docs/adr/0032): fitting a batch into `review` messages
// within the socket's limits, and the web route a review goes to once its session is sealed.
//
// - `splitReviews`: at most 25 reviews a message, and a frame of at most 64 KiB of UTF-8, by count
//   and by bytes, so an "accept all" of any size goes through and no message is refused for size.
//   A review too big for a frame on its own is a group of one, which `SessionClient` reports as
//   `too_large` instead of sending.
// - `createReviewRoute`: `POST /api/sessions/:id/reviews`, with the same review ids the socket
//   would have carried, so a review is written once whichever writer takes it. Right after the
//   seal Postgres may not hold it yet (409 `not_sealed`), so that answer is retried, briefly.
import {
  MAX_MESSAGE_BYTES,
  MAX_REVIEWS_PER_MESSAGE,
  type ReviewInput,
  type ReviewRouteError,
  type ReviewRouteResponse,
  type SnoozeInput,
} from "@earshot/core";
import { type WithRetryOptions, withRetry } from "./retry";

const utf8 = new TextEncoder();
/** A UUIDv7 msgId's length, for sizing a frame before it has one. */
const MSG_ID_PLACEHOLDER = "00000000-0000-7000-8000-000000000000";

/** The bytes a `review` message carrying `reviews` takes on the socket. */
export function reviewFrameBytes(reviews: readonly ReviewInput[]): number {
  return utf8.encode(JSON.stringify({ t: "review", msgId: MSG_ID_PLACEHOLDER, reviews }))
    .byteLength;
}

/**
 * Splits reviews, in order, into as few groups as fit a `review` message: at most `maxCount`
 * reviews (25) and `maxBytes` (64 KiB) of frame each. A review that doesn't fit a frame alone is a
 * group of one; check it with `reviewFrameBytes` before sending.
 */
export function splitReviews(
  reviews: readonly ReviewInput[],
  options: { readonly maxCount?: number; readonly maxBytes?: number } = {},
): ReviewInput[][] {
  const maxCount = options.maxCount ?? MAX_REVIEWS_PER_MESSAGE;
  const maxBytes = options.maxBytes ?? MAX_MESSAGE_BYTES;
  const overhead = reviewFrameBytes([]);
  const groups: ReviewInput[][] = [];
  let group: ReviewInput[] = [];
  let bytes = overhead;
  for (const review of reviews) {
    const size = utf8.encode(JSON.stringify(review)).byteLength;
    const added = group.length === 0 ? size : size + 1; // and its comma
    if (group.length > 0 && (group.length >= maxCount || bytes + added > maxBytes)) {
      groups.push(group);
      group = [];
      bytes = overhead;
    }
    bytes += group.length === 0 ? size : size + 1;
    group.push(review);
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

/** What the route takes: reviews and snoozes as the socket would carry them. */
export interface ReviewRouteRequestBody {
  readonly reviews: readonly ReviewInput[];
  readonly snoozes: readonly SnoozeInput[];
}

/** Sends reviews and snoozes to the web route; `createReviewRoute` makes one. */
export type ReviewRoute = (
  request: ReviewRouteRequestBody,
  signal?: AbortSignal,
) => Promise<ReviewRouteResponse>;

/** Why the route didn't take a request: its own code, or `unavailable` / `bad_response`. */
export class ReviewRouteFailure extends Error {
  override readonly name = "ReviewRouteFailure";
  readonly code: ReviewRouteError | "unavailable" | "bad_response";
  readonly status: number | undefined;
  /** Whether trying again later can help: a session still finishing, or a server failure. */
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ReviewRouteFailure["code"],
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(`the review route refused: ${code}`, { cause: options.cause });
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable =
      code === "not_sealed" ||
      code === "unavailable" ||
      code === "server_error" ||
      code === "audit_unavailable";
  }
}

const ROUTE_ERRORS: ReadonlySet<string> = new Set<ReviewRouteError>([
  "unauthorized",
  "forbidden",
  "invalid_request",
  "too_large",
  "not_found",
  "not_sealed",
  "stale",
  "audit_unavailable",
  "server_error",
]);

/** How long to wait before asking again whether a session's seal reached Postgres. */
const NOT_SEALED_RETRY_MS = 2_000;

export interface ReviewRouteOptions {
  readonly sessionId: string;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Prefixed to `/api/sessions/...`; empty for the page's own origin. */
  readonly baseUrl?: string;
  /** Bounded retries within one request: the retry machine's targets by default. */
  readonly retry?: Omit<WithRetryOptions, "signal">;
}

/**
 * The function `SessionClient` sends a sealed session's reviews with: `POST
 * /api/sessions/:id/reviews`, same-origin, with bounded retries for `not_sealed` (the seal is on
 * its way to Postgres) and for network and server failures. Settles with the route's answer, or
 * rejects with a `ReviewRouteFailure` that says why.
 */
export function createReviewRoute(options: ReviewRouteOptions): ReviewRoute {
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const url = `${options.baseUrl ?? ""}/api/sessions/${encodeURIComponent(options.sessionId)}/reviews`;
  const once = async (request: ReviewRouteRequestBody, signal: AbortSignal) => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ reviews: request.reviews, snoozes: request.snoozes }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ReviewRouteFailure("unavailable", { cause: error });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ReviewRouteFailure(response.ok ? "bad_response" : "unavailable", {
        status: response.status,
        cause: error,
      });
    }
    if (!response.ok) {
      const code = (body as { error?: unknown } | null)?.error;
      const known = typeof code === "string" && ROUTE_ERRORS.has(code);
      throw new ReviewRouteFailure(known ? (code as ReviewRouteError) : "unavailable", {
        status: response.status,
        ...(code === "not_sealed" ? { retryAfterMs: NOT_SEALED_RETRY_MS } : {}),
      });
    }
    const answer = body as Partial<ReviewRouteResponse> | null;
    if (!answer || answer.sessionId !== options.sessionId || !Array.isArray(answer.reviews)) {
      throw new ReviewRouteFailure("bad_response", { status: response.status });
    }
    return answer as ReviewRouteResponse;
  };
  return (request, signal) =>
    withRetry((attemptSignal) => once(request, attemptSignal), {
      ...options.retry,
      ...(signal ? { signal } : {}),
    });
}
