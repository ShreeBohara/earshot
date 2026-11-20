// The pilot analysis's statistics (Phase 5 spec WP7 step 3; docs/pilot/pre-registration.md): the
// median, a nearest-rank percentile, and the two-sided Clopper–Pearson interval. Pure.
import { clopperPearsonUpper } from "../linking/metrics";

/** The median: the middle value, or the mean of the two middle ones; null for no values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * The `q` quantile by nearest rank: the smallest value with at least `q` of the values at or
 * below it (`sorted[ceil(q × n) − 1]`), always one of the values; null for no values.
 */
export function nearestRank(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  if (!(q > 0 && q <= 1)) throw new RangeError(`a quantile is in (0, 1], not ${q}`);
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] as number;
}

/**
 * The two-sided Clopper–Pearson interval for k events in n trials (95% by default): each tail
 * holds (1 − confidence) / 2. The lower limit is 1 − the upper limit of the n − k non-events,
 * since n − X counts those. 36 of 40 gives 76.3–97.2%.
 */
export function clopperPearson(
  k: number,
  n: number,
  confidence = 0.95,
): { readonly lower: number; readonly upper: number } {
  const oneSided = 1 - (1 - confidence) / 2;
  return {
    lower: k === 0 ? 0 : 1 - clopperPearsonUpper(n - k, n, oneSided),
    upper: clopperPearsonUpper(k, n, oneSided),
  };
}
