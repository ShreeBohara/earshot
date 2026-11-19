// Bounded retries for one request (spec WP8 `retry`): honor `Retry-After`, otherwise back off
// exponentially with jitter, and make at most 3 attempts within an 8-second deadline (targets).
// SessionDO's LLM calls and the browser's token requests share it.
//
// `nextRetryDelay` and `DEFAULT_RETRY_POLICY` match `@earshot/agent`'s local copy
// (packages/agent/src/retry.ts) name for name and number for number, so WP5 can swap its copy
// for this one with an import change. The reducer below wraps the same decision in states, for
// drivers that also need the deadline and cancellation: `withRetry` in `@earshot/voice/session`.

export interface RetryPolicy {
  /** Attempts per request, the first included. */
  readonly maxAttempts: number;
  /** The request's deadline: no attempt starts or waits past it. */
  readonly deadlineMs: number;
  /** The first backoff, before jitter; it doubles with each attempt. */
  readonly baseDelayMs: number;
  /** The longest backoff, before jitter. */
  readonly maxDelayMs: number;
}

/** The spec's targets: 3 attempts in 8 s, backing off from 250 ms up to 2 s. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  deadlineMs: 8_000,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
});

/** How an attempt failed, as far as retrying cares. */
export interface RetryFailure {
  readonly retryable: boolean;
  /** The server's `Retry-After`, in ms. */
  readonly retryAfterMs?: number;
}

export interface RetryInput {
  /** Attempts made so far, this failed one included. */
  readonly attempt: number;
  readonly failure: RetryFailure;
  /** Time since the first attempt started. */
  readonly elapsedMs: number;
  /** A number in [0, 1), for jitter. */
  readonly random: number;
}

/**
 * How long to wait before the next attempt, or null to stop. A `Retry-After` is used as given;
 * otherwise the wait is exponential with equal jitter (half fixed, half random), so retries from
 * many clients don't line up. A wait that would end at or past the deadline means stop: report
 * the failure rather than start an attempt that can't finish.
 */
export function nextRetryDelay(policy: RetryPolicy, input: RetryInput): number | null {
  if (!input.failure.retryable || input.attempt >= policy.maxAttempts) return null;
  let delay = input.failure.retryAfterMs;
  if (delay === undefined) {
    const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (input.attempt - 1));
    delay = Math.round(cap / 2 + (cap / 2) * input.random);
  }
  return input.elapsedMs + delay < policy.deadlineMs ? delay : null;
}

export const RETRY_STATES = ["idle", "attempting", "waiting", "succeeded", "failed"] as const;
export type RetryState = (typeof RETRY_STATES)[number];

export const RETRY_EVENTS = [
  "start",
  "success",
  "failure",
  "retry_due",
  "deadline",
  "cancel",
] as const;
export type RetryEventType = (typeof RETRY_EVENTS)[number];

export type RetryEvent =
  /** Begin the request. `at` is the driver's clock, in ms. */
  | { readonly type: "start"; readonly at: number }
  | { readonly type: "success" }
  /** The attempt in flight failed. `random` is in [0, 1), for jitter. */
  | ({ readonly type: "failure"; readonly at: number; readonly random: number } & RetryFailure)
  | { readonly type: "retry_due" }
  /** The request's deadline passed. */
  | { readonly type: "deadline" }
  /** The caller gave up on the request. */
  | { readonly type: "cancel" };

/** Why a request failed for good. */
export type RetryGiveUp = "not_retryable" | "attempts_exhausted" | "deadline" | "cancelled";

export type RetryEffect =
  /** Start attempt `attempt` (1-based). */
  | { readonly type: "attempt"; readonly attempt: number }
  | { readonly type: "schedule_retry"; readonly delayMs: number }
  | { readonly type: "cancel_retry" }
  | { readonly type: "start_deadline"; readonly delayMs: number }
  | { readonly type: "cancel_deadline" }
  /** Abort the attempt in flight; its result no longer matters. */
  | { readonly type: "abort_attempt" }
  | { readonly type: "give_up"; readonly reason: RetryGiveUp };

export interface RetryContext {
  /** Attempts started. */
  readonly attempts: number;
  /** When the first attempt started, on the driver's clock. */
  readonly startedAt: number | null;
  readonly reason: RetryGiveUp | null;
}

export interface Retry {
  readonly state: RetryState;
  readonly context: RetryContext;
}

export interface RetryStep {
  readonly retry: Retry;
  readonly effects: readonly RetryEffect[];
}

export const initialRetry: Retry = {
  state: "idle",
  context: { attempts: 0, startedAt: null, reason: null },
};

const step = (
  state: RetryState,
  context: RetryContext,
  effects: RetryEffect[] = [],
): RetryStep => ({ retry: { state, context }, effects });

/**
 * The next state, and the effects to perform, for one event. Every pair is decided; `succeeded`
 * and `failed` are final, so a stale timer or a late result changes nothing.
 */
export function retryTransition(
  retry: Retry,
  event: RetryEvent,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): RetryStep {
  const { state, context } = retry;
  const same = step(state, context);
  const fail = (reason: RetryGiveUp, effects: RetryEffect[]) =>
    step("failed", { ...context, reason }, [...effects, { type: "give_up", reason }]);

  switch (state) {
    case "idle":
      switch (event.type) {
        case "start":
          return step("attempting", { attempts: 1, startedAt: event.at, reason: null }, [
            { type: "start_deadline", delayMs: policy.deadlineMs },
            { type: "attempt", attempt: 1 },
          ]);
        case "cancel":
          return fail("cancelled", []);
        default:
          return same; // nothing is running yet
      }

    case "attempting":
      switch (event.type) {
        case "success":
          return step("succeeded", context, [{ type: "cancel_deadline" }]);
        case "failure": {
          const delayMs = nextRetryDelay(policy, {
            attempt: context.attempts,
            failure: event,
            elapsedMs: event.at - (context.startedAt ?? event.at),
            random: event.random,
          });
          if (delayMs !== null) {
            return step("waiting", context, [{ type: "schedule_retry", delayMs }]);
          }
          const reason: RetryGiveUp = !event.retryable
            ? "not_retryable"
            : context.attempts >= policy.maxAttempts
              ? "attempts_exhausted"
              : "deadline";
          return fail(reason, [{ type: "cancel_deadline" }]);
        }
        case "deadline":
          return fail("deadline", [{ type: "abort_attempt" }]);
        case "cancel":
          return fail("cancelled", [{ type: "cancel_deadline" }, { type: "abort_attempt" }]);
        default:
          return same; // a second start, or a stale retry timer
      }

    case "waiting":
      switch (event.type) {
        case "retry_due": {
          const attempts = context.attempts + 1;
          return step("attempting", { ...context, attempts }, [
            { type: "attempt", attempt: attempts },
          ]);
        }
        case "deadline":
          return fail("deadline", [{ type: "cancel_retry" }]);
        case "cancel":
          return fail("cancelled", [{ type: "cancel_retry" }, { type: "cancel_deadline" }]);
        default:
          return same; // a late result from an attempt already settled
      }

    case "succeeded":
    case "failed":
      return same;
  }
}
