// `withRetry`: runs one request under the retry machine (`@earshot/voice/machines`): at most 3
// attempts within an 8-second deadline, honoring `Retry-After`, with backoff and jitter between.
// The browser's token requests use it: the session ticket here, and the speech credential the
// app mints for the Debrief engine.
import {
  DEFAULT_RETRY_POLICY,
  initialRetry,
  type Retry,
  type RetryEffect,
  type RetryEvent,
  type RetryFailure,
  type RetryPolicy,
  retryTransition,
} from "../machines/retry";
import { type Clock, systemClock } from "../stt/socket";

export interface WithRetryOptions {
  readonly policy?: RetryPolicy;
  readonly clock?: Clock;
  /** For jitter; tests pass a constant. */
  readonly random?: () => number;
  /** Aborting it cancels the request: the attempt in flight is aborted too. */
  readonly signal?: AbortSignal;
  /**
   * How a thrown error counts. By default an error's own `retryable` and `retryAfterMs` decide,
   * an abort is final, and anything else (a network failure) may be retried.
   */
  readonly classify?: (error: unknown) => RetryFailure;
}

/** The deadline passed before any attempt failed in a way worth reporting. */
export class RetryDeadlineError extends Error {
  override readonly name = "RetryDeadlineError";
  readonly retryable = true;
}

export function defaultClassify(error: unknown): RetryFailure {
  if (isAbort(error)) return { retryable: false };
  if (typeof error === "object" && error !== null && "retryable" in error) {
    const { retryable, retryAfterMs } = error as { retryable: unknown; retryAfterMs?: unknown };
    return {
      retryable: retryable === true,
      ...(typeof retryAfterMs === "number" && retryAfterMs >= 0 ? { retryAfterMs } : {}),
    };
  }
  return { retryable: true };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Runs `attempt` until it succeeds or the retry machine gives up, then settles with its value or
 * with the last attempt's error. Each attempt gets its own signal, aborted when the deadline
 * passes or the caller cancels.
 */
export function withRetry<T>(
  attempt: (signal: AbortSignal, attemptNumber: number) => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const classify = options.classify ?? defaultClassify;
  const outer = options.signal;

  return new Promise<T>((resolve, reject) => {
    let machine: Retry = initialRetry;
    let current: AbortController | undefined;
    let lastError: unknown;
    let retryTimer: unknown;
    let deadlineTimer: unknown;

    const onAbort = () => dispatch({ type: "cancel" });

    const finish = () => {
      clock.clearTimeout(retryTimer);
      clock.clearTimeout(deadlineTimer);
      outer?.removeEventListener("abort", onAbort);
    };

    const run = (effect: RetryEffect) => {
      switch (effect.type) {
        case "attempt": {
          const controller = new AbortController();
          current = controller;
          attempt(controller.signal, effect.attempt).then(
            (value) => {
              if (current !== controller || machine.state !== "attempting") return;
              dispatch({ type: "success" });
              finish();
              resolve(value);
            },
            (error: unknown) => {
              if (current !== controller || machine.state !== "attempting") return;
              lastError = error;
              dispatch({ type: "failure", at: clock.now(), random: random(), ...classify(error) });
            },
          );
          return;
        }
        case "schedule_retry":
          retryTimer = clock.setTimeout(() => dispatch({ type: "retry_due" }), effect.delayMs);
          return;
        case "cancel_retry":
          clock.clearTimeout(retryTimer);
          return;
        case "start_deadline":
          deadlineTimer = clock.setTimeout(() => dispatch({ type: "deadline" }), effect.delayMs);
          return;
        case "cancel_deadline":
          clock.clearTimeout(deadlineTimer);
          return;
        case "abort_attempt":
          current?.abort(
            machine.context.reason === "cancelled"
              ? outer?.reason
              : new DOMException("the request's deadline passed", "TimeoutError"),
          );
          current = undefined;
          return;
        case "give_up":
          finish();
          if (effect.reason === "cancelled") {
            reject(outer?.reason ?? new DOMException("the request was cancelled", "AbortError"));
          } else {
            reject(lastError ?? new RetryDeadlineError("the request ran out of time"));
          }
          return;
      }
    };

    const dispatch = (event: RetryEvent) => {
      const step = retryTransition(machine, event, policy);
      machine = step.retry;
      for (const effect of step.effects) run(effect);
    };

    if (outer?.aborted) {
      reject(outer.reason);
      return;
    }
    outer?.addEventListener("abort", onAbort, { once: true });
    dispatch({ type: "start", at: clock.now() });
  });
}
