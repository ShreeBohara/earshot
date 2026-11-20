// The live smoke eval's pacing (Phase 4 WP11 step 1): at most 60 requests in any minute, after a
// slow start, because Anthropic limits sudden ramps in a workspace's traffic as well as its
// steady rate (spec Appendix A: "ramp limits apply"). Every HTTP request the extractor makes goes
// through `pacedFetch`, the validation retry's and `runTurn`'s retries included, so the limit
// holds whatever the turns do.
//
// The first request goes at once. The gap before each later one shrinks from a 10-a-minute pace
// to the 60-a-minute one over the first ten gaps (about 24 s in all), then stays there. A sliding
// window also holds the count in any 60 s to the most, as the live eval's stream limiter does.
// The clock and the wait are injectable, so a test runs it on a fake clock.
import { streamDelayMs } from "../live";

export const SMOKE_PACE = {
  /** The most requests in any minute (spec WP11: 60 or fewer). */
  maxPerMinute: 60,
  /** The slow start's pace, for the first gap. */
  startPerMinute: 10,
  /** Gaps until the pace reaches the most. */
  rampGaps: 10,
} as const;

export interface PacerOptions {
  readonly maxPerMinute?: number;
  readonly startPerMinute?: number;
  readonly rampGaps?: number;
  readonly now?: () => number;
  /** Waits `ms`; rejects with the signal's reason if it aborts first. */
  readonly sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
}

export interface Pacer {
  /** Resolves when another request may start, and counts it; rejects if the signal aborts first. */
  acquire(signal?: AbortSignal | null): Promise<void>;
  /** Requests started so far. */
  readonly started: number;
}

const MINUTE_MS = 60_000;

/** The gap before request `k` (0-based, after request `k - 1`), in ms: the slow start's ramp. */
export function paceGapMs(k: number, options: PacerOptions = {}): number {
  if (k <= 0) return 0;
  const max = options.maxPerMinute ?? SMOKE_PACE.maxPerMinute;
  const start = Math.min(options.startPerMinute ?? SMOKE_PACE.startPerMinute, max);
  const ramp = Math.max(1, options.rampGaps ?? SMOKE_PACE.rampGaps);
  const rate = start + (max - start) * Math.min(1, (k - 1) / ramp);
  return Math.ceil(MINUTE_MS / rate);
}

function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createPacer(options: PacerOptions = {}): Pacer {
  const max = options.maxPerMinute ?? SMOKE_PACE.maxPerMinute;
  if (!Number.isFinite(max) || max <= 0) throw new RangeError("maxPerMinute must be positive");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const starts: number[] = [];
  let started = 0;
  let last = Number.NEGATIVE_INFINITY;
  // One waiter at a time, in order; a waiter that's cancelled doesn't hold up the next.
  let queue: Promise<void> = Promise.resolve();
  return {
    get started() {
      return started;
    },
    acquire(signal) {
      const turn = queue.then(async () => {
        for (;;) {
          if (signal?.aborted) throw signal.reason;
          const at = now();
          const wait = Math.max(
            last + paceGapMs(started, options) - at,
            streamDelayMs(starts, at, max, MINUTE_MS),
          );
          if (wait <= 0) break;
          await sleep(wait, signal);
        }
        last = now();
        starts.push(last);
        if (starts.length > max) starts.shift();
        started++;
      });
      queue = turn.catch(() => {});
      return turn;
    },
  };
}

/** A `fetch` that waits for the pacer before each request. */
export function pacedFetch(fetch: typeof globalThis.fetch, pacer: Pacer): typeof globalThis.fetch {
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    await pacer.acquire(signal);
    return fetch(input, init);
  }) as typeof globalThis.fetch;
}
