// The participants' orders (Phase 5 spec WP7 step 1): a seeded, balanced Latin rectangle. Each
// participant reviews the same sessions in an order of their own, so no session always comes
// first, last, or after the same one.
//
// The rectangle is rows of a Williams square, the standard balanced design for an even number of
// treatments: row 0 is 0, 1, n−1, 2, n−2, …, and row r adds r to each, mod n. Across the square's
// n rows every session takes every position once and directly follows every other session once.
// Any subset of rows keeps the first property as "at most once" in each position, and the second
// as "at most once" for each ordered pair, which is as balanced as fewer rows than sessions allow.
// The seed relabels the sessions and picks which rows.
import type { Rng } from "../channel/rng";

/** Row `r` of the n × n Williams square, n even. */
export function williamsRow(n: number, r: number): number[] {
  if (n < 2 || n % 2 !== 0) throw new RangeError("a Williams square needs an even n of 2 or more");
  const first: number[] = [0];
  for (let k = 1; first.length < n; k++) {
    first.push(k);
    if (first.length < n) first.push(n - k);
  }
  return first.map((symbol) => (symbol + r) % n);
}

/**
 * `rows` orders of `labels` (an even number of them): distinct rows of a Williams square, with the
 * labels shuffled onto its symbols and the rows chosen by `rng`.
 */
export function balancedLatinRectangle(
  labels: readonly string[],
  rows: number,
  rng: Rng,
): string[][] {
  const n = labels.length;
  if (rows < 1 || rows > n) throw new RangeError(`a rectangle of ${n} labels has 1 to ${n} rows`);
  const relabel = rng.shuffle(labels);
  const chosen = rng.shuffle(Array.from({ length: n }, (_, r) => r)).slice(0, rows);
  return chosen.map((r) => williamsRow(n, r).map((symbol) => relabel[symbol] as string));
}
