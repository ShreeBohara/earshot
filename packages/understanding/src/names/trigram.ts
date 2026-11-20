// pg_trgm's `similarity` and `word_similarity`, computed as contrib/pg_trgm/trgm_op.c computes them,
// so a score here equals the one Postgres gives for the same strings (test/pg-parity.test.ts checks
// 200 pairs against PGlite to within 1e-6):
// - A word is a run of letters and numbers. Everything else separates words and is dropped.
// - Each word is lowercased and padded with two spaces before and one after: "acme" → "  acme ".
// - Its trigrams are every run of three characters of the padded word.
// - `similarity` is shared trigrams over all distinct trigrams of both strings.
// - `word_similarity` is the best `similarity` between the first string's trigrams and any
//   continuous extent of the second string's trigram sequence, found by pg_trgm's greedy scan.
//
// Two documented differences, neither visible on names: Postgres rounds its scores to `real`
// (float4), within 1e-7 of these doubles; and it stores a trigram of multibyte characters as a
// 3-byte hash, which can, very rarely, make two different trigrams equal there and not here.

/** pg_trgm's padding: two spaces before each word, one after. */
const LEFT_PAD = "  ";
const RIGHT_PAD = " ";
/** pg_trgm's word characters (`t_isalnum`), as a UTF-8 database classifies them. */
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Lowercases one character at a time, as Postgres's `str_tolower` does with libc: each character
 * maps to one character, with no context ("Σ" is always "σ") and no expansion ("İ" is "i").
 */
function lowercase(word: string): string {
  let out = "";
  for (const char of word) {
    const lower = char.toLowerCase();
    out += lower.length === char.length ? lower : String.fromCodePoint(lower.codePointAt(0) ?? 0);
  }
  return out;
}

/** Every trigram of `text`, in order and with repeats: pg_trgm's `generate_trgm_only`. */
function trigramSequence(text: string): string[] {
  const sequence: string[] = [];
  for (const word of text.match(WORD) ?? []) {
    const chars = Array.from(LEFT_PAD + lowercase(word) + RIGHT_PAD);
    for (let i = 0; i + 3 <= chars.length; i++) {
      sequence.push(chars.slice(i, i + 3).join(""));
    }
  }
  return sequence;
}

/**
 * The distinct trigrams of `text`, sorted: what Postgres's `show_trgm` lists (for multibyte
 * characters it shows a hash instead). Empty for text with no letters or numbers.
 */
export function trigrams(text: string): string[] {
  return [...new Set(trigramSequence(text))].sort();
}

/**
 * `similarity` on two trigram sets, as `trigrams` returns them (pg_trgm's `cnt_sml`): the shared
 * trigrams over the distinct trigrams of both. 0 when either set is empty.
 */
export function trigramSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const trigram of right) if (left.has(trigram)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * Postgres's `similarity(a, b)`: how alike two strings are, from 0 to 1, by their trigrams.
 * Symmetric. "Akme" and "Acme" score 0.25: pg_trgm's 0.3 default threshold misses them.
 */
export function similarity(a: string, b: string): number {
  return trigramSimilarity(trigrams(a), trigrams(b));
}

/**
 * Postgres's `word_similarity(a, b)`: how well `a` matches some run of words in `b`, from 0 to 1.
 * Not symmetric: "Northwind" against "Northwind Logistics" scores 1, the other way round 0.5.
 *
 * A port of `calc_word_similarity` and `iterate_word_similarity` (non-strict, no threshold
 * shortcut). The scan walks `b`'s trigram sequence; each trigram that's also in `a` closes a
 * window, whose start then moves right while that raises the score.
 */
export function wordSimilarity(a: string, b: string): number {
  const query = new Set(trigramSequence(a));
  const sequence = trigramSequence(b);
  if (query.size === 0 || sequence.length === 0) return 0;

  const queryCount = query.size;
  const score = (shared: number, windowCount: number) =>
    shared / (queryCount + windowCount - shared);

  // The last position of each trigram in the current window: pg_trgm's `lastpos`.
  const lastPosition = new Map<string, number>();
  let lower = -1;
  let windowCount = 0; // distinct trigrams in the window (`ulen2`)
  let shared = 0; // of those, how many are in `a` (`count`)
  let best = 0;

  for (let upper = 0; upper < sequence.length; upper++) {
    const trigram = sequence[upper] ?? "";
    const found = query.has(trigram);
    // Before the first shared trigram, nothing counts.
    if (lower >= 0 || found) {
      if (!lastPosition.has(trigram)) {
        windowCount++;
        if (found) shared++;
      }
      lastPosition.set(trigram, upper);
    }
    if (!found) continue;

    if (lower === -1) {
      lower = upper;
      windowCount = 1;
    }
    let current = score(shared, windowCount);

    // Try every later start for this end, keeping the first that scores best.
    let trialShared = shared;
    let trialCount = windowCount;
    const previousLower = lower;
    for (let start = previousLower; start <= upper; start++) {
      const trial = score(trialShared, trialCount);
      if (trial > current) {
        current = trial;
        windowCount = trialCount;
        lower = start;
        shared = trialShared;
      }
      const leaving = sequence[start] ?? "";
      if (lastPosition.get(leaving) === start) {
        trialCount--;
        if (query.has(leaving)) trialShared--;
      }
    }
    best = Math.max(best, current);

    // Trigrams whose last position fell before the new start have left the window.
    for (let start = previousLower; start < lower; start++) {
      const leaving = sequence[start] ?? "";
      if (lastPosition.get(leaving) === start) lastPosition.delete(leaving);
    }
  }
  return best;
}
