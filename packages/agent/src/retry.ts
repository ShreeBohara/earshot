// When a failed extraction is worth another try. A local seam: the spec gives this job to WP8's
// `retry` machine in `@earshot/voice/machines`, shared by SessionDO's LLM calls and the
// browser's token requests, which doesn't exist yet. Its targets are copied here: honor
// `Retry-After`, then exponential backoff with jitter, at most 3 attempts within an 8-second
// turn deadline. Swap `nextRetryDelay` for the machine when it lands.
import type { ExtractionFailure } from "./errors";

export interface RetryPolicy {
  /** Extractions per turn, the first included. */
  readonly maxAttempts: number;
  /** The turn's deadline, from `turn_end`: no attempt starts or waits past it. */
  readonly deadlineMs: number;
  /** The first backoff, before jitter; it doubles with each attempt. */
  readonly baseDelayMs: number;
  /** The longest backoff, before jitter. */
  readonly maxDelayMs: number;
}

/** The spec's targets (WP8 `retry`). */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  deadlineMs: 8_000,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
});

export interface RetryInput {
  /** Extractions made so far, this failed one included. */
  readonly attempt: number;
  readonly failure: {
    readonly code: ExtractionFailure;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
  };
  /** Time since the turn started. */
  readonly elapsedMs: number;
  /** A number in [0, 1), for jitter. */
  readonly random: number;
}

/**
 * How long to wait before the next extraction, or null to stop. A provider's `Retry-After` is
 * used as given; otherwise the wait is exponential with equal jitter (half fixed, half random),
 * so retries from many sessions don't line up. A wait that would end past the deadline means
 * stop: the caller reports the failure instead of starting a call it can't finish.
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
