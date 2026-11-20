// Self-corrections (spec WP7 step 4): "one hundred eighty thousand, sorry, one hundred eighty-five
// thousand". A correction is a value, a marker right after it, and a value of the same kind right
// after the marker, all in one utterance. A quote that stops at the first value quotes words the
// rep took back: `self_correction`, and `value_mismatch` too if the model kept the retracted value
// (faithfulness.ts decides that, with the values' readings).
import { matchPhrase, overlaps, type TextToken, tokenize } from "./text";

/**
 * How a rep takes back what they just said: the spec's list (sorry, actually, no wait, I mean,
 * scratch that, make that, rather), plus "I meant" and "correction", which the evals' scripts
 * count as markers too.
 */
export const CORRECTION_MARKERS: readonly (readonly string[])[] = [
  ["no", "wait"],
  ["scratch", "that"],
  ["make", "that"],
  ["i", "mean"],
  ["i", "meant"],
  ["sorry"],
  ["actually"],
  ["rather"],
  ["correction"],
];

/**
 * Hesitations allowed between the taken-back value and the marker: "Tuesday, uh, no wait", and
 * another marker ("Tuesday. Sorry, I mean Wednesday").
 */
export const CORRECTION_FILLERS: ReadonlySet<string> = new Set([
  "actually",
  "sorry",
  "wait",
  "uh",
  "um",
  "er",
  "erm",
  "ah",
  "oh",
  "no",
  "or",
  "well",
  "oops",
]);

/** The most fillers between the taken-back value and the marker. */
export const MAX_FILLERS_BEFORE_MARKER = 2;
/** The most words between the marker and the new value: "sorry, it's", "actually, make it". */
export const MAX_WORDS_BEFORE_REPLACEMENT = 3;

/** Where a value of some kind sits in a text: `[start, end)`. */
export interface ValueSpan {
  readonly start: number;
  readonly end: number;
}

/** Finds every value of one kind (dates, amounts) in a text. */
export type ValueFinder = (text: string) => readonly ValueSpan[];

/** A value the rep took back, and what they said instead. */
export interface Correction {
  /** The marker as said: "sorry", "no, wait". */
  readonly marker: string;
  readonly markerSpan: readonly [number, number];
  /** `[start, end)` of the value taken back. */
  readonly retracted: readonly [number, number];
  /** `[start, end)` of the value said instead. */
  readonly replacement: readonly [number, number];
}

/** A correction as it bears on one quote. */
export interface QuoteCorrection extends Correction {
  /**
   * Whether the quote runs past the marker into the new value ("Tuesday, no wait, Wednesday"),
   * rather than stopping before the marker ("Tuesday").
   */
  readonly spansMarker: boolean;
}

/** Words (not punctuation) strictly between two offsets. */
function wordsBetween(tokens: readonly TextToken[], start: number, end: number): TextToken[] {
  return tokens.filter(
    (token) => token.kind === "word" && token.start >= start && token.end <= end,
  );
}

/**
 * Every self-correction in an utterance, in order: a value, then at most
 * `MAX_FILLERS_BEFORE_MARKER` fillers, a marker, at most `MAX_WORDS_BEFORE_REPLACEMENT` words, and
 * a value of the same kind. In a chain ("Tuesday, sorry, Wednesday, no wait, Thursday") each value
 * but the last is taken back.
 */
export function findCorrections(text: string, find: ValueFinder): Correction[] {
  const tokens = tokenize(text);
  const values = [...find(text)].sort((left, right) => left.start - right.start);
  const found: Correction[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    for (const phrase of CORRECTION_MARKERS) {
      const end = matchPhrase(tokens, index, phrase);
      if (end < 0) continue;
      const first = tokens[index];
      const last = tokens[end - 1];
      if (!first || !last) continue;
      const before = values.filter((value) => value.end <= first.start).at(-1);
      const after = values.find((value) => value.start >= last.end);
      if (!before || !after) break;
      const fillers = wordsBetween(tokens, before.end, first.start);
      const gap = wordsBetween(tokens, last.end, after.start);
      if (
        fillers.length <= MAX_FILLERS_BEFORE_MARKER &&
        fillers.every((token) => CORRECTION_FILLERS.has(token.key)) &&
        gap.length <= MAX_WORDS_BEFORE_REPLACEMENT
      ) {
        found.push({
          marker: text.slice(first.start, last.end),
          markerSpan: [first.start, last.end],
          retracted: [before.start, before.end],
          replacement: [after.start, after.end],
        });
      }
      break;
    }
  }
  return found;
}

/**
 * The correction that takes back a quote: the first whose retracted value the quote's `[start,
 * end)` span touches. A quote that only covers the new value ("one hundred eighty-five thousand")
 * isn't taken back: null.
 */
export function findCorrection(
  text: string,
  span: readonly [number, number],
  find: ValueFinder,
): QuoteCorrection | null {
  for (const correction of findCorrections(text, find)) {
    if (!overlaps(correction.retracted, span)) continue;
    return { ...correction, spansMarker: overlaps(correction.replacement, span) };
  }
  return null;
}
