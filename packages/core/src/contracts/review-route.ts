// The web Worker's review route (Phase 5 spec §4.3, WP3): `POST /api/sessions/:id/reviews`, how the
// inbox writes reviews and snoozes once a session is sealed, and how the tray sends a review the
// socket refused with `sealed`, under the same review id.
//
// Like the session protocol, these schemas aren't exported to JSON Schema or Pydantic: only
// TypeScript speaks the route, and its key-shape check has no JSON Schema form.
import { z } from "zod";
import { ReviewInput, refuseStrayKeys, SnoozeInput } from "./session-protocol";

/** The most reviews and snoozes one request carries, together (target), as a `review` message. */
export const MAX_REVIEW_REQUEST_ITEMS = 25;
/** The largest request body the route reads: 64 KiB of UTF-8, the socket's frame cap (target). */
export const MAX_REVIEW_REQUEST_BYTES = 65_536;

/**
 * What the route takes: reviews and snoozes as a person sends them (`ReviewInput` and
 * `SnoozeInput`, without `by` and `syncEligibleAt`, which the route fills from the sign-in and its
 * own clock), 1 to 25 in all. Anything shaped like a key, anywhere, is refused.
 */
export const ReviewRouteRequest = z
  .strictObject({
    reviews: z.array(ReviewInput).max(MAX_REVIEW_REQUEST_ITEMS).default([]),
    snoozes: z.array(SnoozeInput).max(MAX_REVIEW_REQUEST_ITEMS).default([]),
  })
  .refine(
    (request) => {
      const items = request.reviews.length + request.snoozes.length;
      return items >= 1 && items <= MAX_REVIEW_REQUEST_ITEMS;
    },
    { message: `send 1 to ${MAX_REVIEW_REQUEST_ITEMS} reviews and snoozes in all` },
  )
  .superRefine(refuseStrayKeys);
export type ReviewRouteRequest = z.infer<typeof ReviewRouteRequest>;

/** One review or snooze the route answered for: where it is in the log, and whether it's new. */
export interface ReviewRouteWrite {
  /** The `reviewId` or `snoozeId`. */
  readonly id: string;
  readonly seq: number;
  /** `now` if this request wrote it, `before` if the log already held it (a resend). */
  readonly recorded: "now" | "before";
}

/** `POST /api/sessions/:id/reviews`, 200: every item is in the session's log. */
export interface ReviewRouteResponse {
  readonly sessionId: string;
  /** In the request's order. */
  readonly reviews: readonly ReviewRouteWrite[];
  readonly snoozes: readonly ReviewRouteWrite[];
  /** The log's last seq after the request. */
  readonly lastSeq: number;
}

/**
 * Why the route refused a request: a fixed code, and nothing quoted from the request.
 *
 * - `not_sealed` (409): the session isn't sealed in Postgres yet, so `SessionDO` may still write
 *   its log; the inbox shows it as "Finishing". Retry after a while.
 * - `stale` (409): a proposal was decided, reopened, or replaced since the card loaded. Reload it.
 * - `audit_unavailable` (503): reviews need a signed checkpoint, and the deployment has no usable
 *   signing key. Snooze-only requests still work.
 */
export type ReviewRouteError =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "too_large"
  | "not_found"
  | "not_sealed"
  | "stale"
  | "audit_unavailable"
  | "server_error";

/** The body of every refusal. For `stale` and `invalid_request`, which item, when one is to blame. */
export interface ReviewRouteErrorBody {
  readonly error: ReviewRouteError;
  readonly message: string;
  readonly item?: { readonly kind: "review" | "snooze"; readonly index: number };
}
