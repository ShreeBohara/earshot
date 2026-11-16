export interface BackoffOptions {
  /** The cap on the first attempt's delay, in ms. */
  readonly baseMs?: number;
  /** The cap on any delay, in ms. */
  readonly maxMs?: number;
  /** Returns a number in [0, 1). Defaults to `Math.random`; tests pass a constant. */
  readonly random?: () => number;
}

/**
 * Exponential backoff with full jitter: a random delay up to `baseMs * 2^attempt`, capped at
 * `maxMs`. Attempt 0 is the first retry. Spreading retries keeps a fleet of clients that dropped
 * together from reconnecting together.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 250;
  const max = options.maxMs ?? 8_000;
  const random = options.random ?? Math.random;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(ceiling * Math.min(1, Math.max(0, random())));
}
