// The unbiased reading (spec §4.6 steps 1 and 2): the words of the second witness's transcript
// that cover the words a proposal quotes from the biased one.
//
// Both ways of reading align the two transcripts word by word at a phonetic-aware cost
// (`alignTokens`) and keep the unbiased words between the quote's neighbours: the words aligned
// with the quote, and any the alignment inserted at its edges, which the biased transcript has
// nothing for. That's how a name's last word that the biased stream dropped ("Summit Ridge"
// against "Summit Ridge Capital") stays in the reading. At most two inserted words count on each
// side, and fillers ("uh", "um") never start or end a reading.
//
// - By time, when the quote has an audio window and the unbiased words have timings: of the words
//   the alignment gives the quote, those that overlap the window widened by 150 ms on each side
//   (target), for the two transcribers' timing differences. In continuous speech the widening
//   reaches into the neighbouring words; the alignment leaves them out ("told Atmo Systems
//   they'd" over the quote "Atmos Industrial" reads "Atmo Systems"), and the window keeps a
//   name said twice to the stretch the quote covers. When no unbiased word overlaps the window
//   itself, the witness heard nothing there, and there's no reading.
// - By alignment, when either side lacks timings: the alignment alone.
//
// No reading (null) means the comparison is "unavailable", which is never a conflict.
import { alignTokens } from "../names";

/** One word of a transcript, timed on the session's audio clock: `Word`'s shape. */
export interface TimedWord {
  readonly w: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** A transcript as the reading needs it: `utterance.final`'s shape. */
export interface WitnessUtterance {
  readonly utteranceId: string;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  /** Word timings, when the provider returns them. */
  readonly words?: readonly TimedWord[];
}

/** The quoted words of the biased transcript: where they sit in its text, and when they were said. */
export interface BiasedQuote {
  /** The biased utterance's text. */
  readonly text: string;
  /** The quote's `[start, end)` character span in `text`: its evidence's `span`. */
  readonly span: readonly [number, number];
  /** The quote's `[start, end]` audio window: its evidence's `audioMs`. Null without timings. */
  readonly audioMs?: readonly [number, number] | null;
}

export type ReadingMethod = "time" | "alignment";

/**
 * What the unbiased witness heard where the biased one has the quote: `WitnessConflict.unbiased`'s
 * fields, and how they were found.
 */
export interface UnbiasedReading {
  readonly text: string;
  readonly utteranceId: string;
  /** From its words' timings, or the whole utterance's span when it was read by alignment. */
  readonly audioMs: readonly [number, number];
  readonly method: ReadingMethod;
}

/** How far the time window reaches past the quote's on each side (spec §4.6, target). */
export const READING_PAD_MS = 150;

/** How many words the alignment inserted at each edge of the quote a reading takes in. */
export const MAX_EDGE_WORDS = 2;

/** Hesitations no name starts or ends with: never the first or last word of a reading. */
export const FILLERS: ReadonlySet<string> = new Set([
  "uh",
  "uhm",
  "um",
  "umm",
  "er",
  "erm",
  "ah",
  "eh",
  "hm",
  "hmm",
  "mm",
  "mhm",
]);

/** A word of a transcript, without the punctuation at its edges, and its `[start, end)` span. */
export interface TranscriptToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const LEADING = /^[^\p{L}\p{M}\p{N}&]+/u;
const TRAILING = /[^\p{L}\p{M}\p{N}&]+$/u;

/**
 * A transcript's words: runs of non-space characters, without the punctuation at either end
 * ("Capital," is "Capital"; "they'd" and "multi-year" stay whole, and "&" is a word). A run
 * that's nothing but punctuation, such as a dash, isn't a word.
 */
export function transcriptTokens(text: string): TranscriptToken[] {
  const tokens: TranscriptToken[] = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const raw = match[0];
    const lead = LEADING.exec(raw)?.[0].length ?? 0;
    const word = raw.slice(lead).replace(TRAILING, "");
    if (word === "") continue;
    const start = match.index + lead;
    tokens.push({ text: word, start, end: start + word.length });
  }
  return tokens;
}

/** The words of the quote: those of `tokens` its span touches, as a range. */
function quoteRange(
  tokens: readonly TranscriptToken[],
  span: readonly [number, number],
): { from: number; to: number } | null {
  const [start, end] = span;
  let from = -1;
  let to = -1;
  tokens.forEach((token, k) => {
    if (token.end <= start || token.start >= end) return;
    if (from < 0) from = k;
    to = k;
  });
  return from < 0 ? null : { from, to };
}

/**
 * The unbiased words a quote covers: from just after the last word aligned with what comes before
 * the quote to just before the first word aligned with what comes after it, with at most
 * `MAX_EDGE_WORDS` inserted words taken in on each side and fillers trimmed from both ends. Null
 * when nothing is left: the second witness has no words there.
 */
export function coveredRange(
  biased: readonly string[],
  quote: { readonly from: number; readonly to: number },
  unbiased: readonly string[],
): { start: number; end: number } | null {
  let before = -1;
  let after = unbiased.length;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const step of alignTokens(biased, unbiased).steps) {
    if (step.a.length === 0 || step.b.length === 0) continue;
    const touches = step.a.some((index) => index >= quote.from && index <= quote.to);
    if (touches) {
      first = Math.min(first, ...step.b);
      last = Math.max(last, ...step.b);
    } else if (step.a.every((index) => index < quote.from)) {
      before = Math.max(before, ...step.b);
    } else {
      after = Math.min(after, ...step.b);
    }
  }
  let start = before + 1;
  let end = after;
  if (first <= last) {
    start = Math.max(start, first - MAX_EDGE_WORDS);
    end = Math.min(end, last + 1 + MAX_EDGE_WORDS);
  } else {
    // Nothing aligned with the quote itself: only words inserted between its neighbours remain.
    end = Math.min(end, start + MAX_EDGE_WORDS);
  }
  const filler = (k: number) => FILLERS.has((unbiased[k] ?? "").toLowerCase());
  while (start < end && filler(start)) start++;
  while (end > start && filler(end - 1)) end--;
  return start < end ? { start, end } : null;
}

/** Whether a word overlaps `[t0, t1]`: by a positive length, or covers it when it's an instant. */
function during(word: TimedWord, t0: number, t1: number): boolean {
  return t1 > t0 ? word.startMs < t1 && word.endMs > t0 : word.startMs <= t0 && word.endMs >= t0;
}

function readByTime(
  quote: BiasedQuote,
  window: readonly [number, number],
  unbiased: WitnessUtterance,
  padMs: number,
): UnbiasedReading | null {
  const biased = transcriptTokens(quote.text);
  const quoted = quoteRange(biased, quote.span);
  if (quoted === null) return null;
  const [t0, t1] = window;
  const words = (unbiased.words ?? [])
    .map((word) => ({ word, text: word.w.replace(LEADING, "").replace(TRAILING, "") }))
    .filter((entry) => entry.text !== "")
    .sort((a, b) => a.word.startMs - b.word.startMs || a.word.endMs - b.word.endMs);
  if (!words.some(({ word }) => during(word, t0, t1))) return null;
  const range = coveredRange(
    biased.map((token) => token.text),
    quoted,
    words.map((entry) => entry.text),
  );
  if (range === null) return null;
  // Of the words the alignment gives the quote, those within the padded window: aligned against
  // the whole utterance, so the neighbours outside the window still anchor it.
  const inWindow = (k: number) => {
    const word = words[k]?.word;
    return word !== undefined && word.startMs <= t1 + padMs && word.endMs >= t0 - padMs;
  };
  let start = range.start;
  let end = range.end;
  while (start < end && !inWindow(start)) start++;
  while (end > start && !inWindow(end - 1)) end--;
  const kept = words.slice(start, end);
  const first = kept[0];
  const last = kept.at(-1);
  if (!first || !last) return null;
  return {
    text: kept.map((entry) => entry.text).join(" "),
    utteranceId: unbiased.utteranceId,
    audioMs: [first.word.startMs, last.word.endMs],
    method: "time",
  };
}

function readByAlignment(quote: BiasedQuote, unbiased: WitnessUtterance): UnbiasedReading | null {
  const biased = transcriptTokens(quote.text);
  const quoted = quoteRange(biased, quote.span);
  const heard = transcriptTokens(unbiased.text);
  if (quoted === null || heard.length === 0) return null;
  const range = coveredRange(
    biased.map((token) => token.text),
    quoted,
    heard.map((token) => token.text),
  );
  if (range === null) return null;
  const first = heard[range.start];
  const last = heard[range.end - 1];
  if (!first || !last) return null;
  return {
    text: unbiased.text.slice(first.start, last.end),
    utteranceId: unbiased.utteranceId,
    audioMs: [unbiased.startMs, unbiased.endMs],
    method: "alignment",
  };
}

/**
 * The unbiased reading of a quote (spec §4.6): by time when the quote has an audio window and the
 * unbiased words have timings, by alignment otherwise. Null when the second witness heard nothing
 * where the quote is: an unavailable reading, not a different one.
 */
export function readUnbiased(
  quote: BiasedQuote,
  unbiased: WitnessUtterance,
  options: { readonly padMs?: number } = {},
): UnbiasedReading | null {
  const window = quote.audioMs ?? null;
  if (window !== null && (unbiased.words?.length ?? 0) > 0) {
    return readByTime(quote, window, unbiased, options.padMs ?? READING_PAD_MS);
  }
  return readByAlignment(quote, unbiased);
}
