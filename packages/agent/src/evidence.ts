// Evidence by quotation (Phase 3 spec, WP5 step 5). The model quotes the words each value came
// from; this code finds those words in the turn's utterances and turns them into `Evidence`:
// the utterance, the `[start, end)` character span, the audio window, and a confidence.
//
// Phase 4 replaces this with the entity linker, the normalizers, and the faithfulness check.
import type { Evidence, UtteranceFinalV2 } from "@earshot/core";

/** How a quote was found, from strictest to most lenient. */
export type QuoteMatch =
  /** The quote is a substring of the utterance's text. */
  | "exact"
  /** It matches once case is ignored and runs of whitespace count as one space (the spec's rule). */
  | "case_whitespace"
  /**
   * It matches word for word once punctuation at the edges of words is ignored, and curly quotes
   * and dashes count as straight ones: "Dana Lee their" finds "Dana Lee, their". Punctuation
   * inside a word still has to match, so "15" never finds "1.5".
   */
  | "word_edges";

export interface QuoteLocation {
  readonly utterance: UtteranceFinalV2;
  /** `[start, end)` in UTF-16 code units of `utterance.text`, as `Evidence.span` is. */
  readonly span: readonly [number, number];
  readonly match: QuoteMatch;
}

/**
 * Finds a quote in a turn's utterances. Each rule is tried across every utterance before the next,
 * more lenient one, so an exact match in a later utterance wins over a loose one in an earlier
 * utterance. A quote must sit inside one utterance. Returns null for an empty quote, or one that
 * isn't there.
 */
export function locateQuote(
  quote: string,
  utterances: readonly UtteranceFinalV2[],
): QuoteLocation | null {
  if (quote.trim() === "") return null;
  for (const utterance of utterances) {
    const start = utterance.text.indexOf(quote);
    if (start >= 0) return { utterance, span: [start, start + quote.length], match: "exact" };
  }
  const foldedQuote = foldCaseAndSpace(quote).folded;
  for (const utterance of utterances) {
    const span = findFolded(utterance.text, foldedQuote);
    if (span) return { utterance, span, match: "case_whitespace" };
  }
  const quoteWords = words(quote).map((word) => word.key);
  if (quoteWords.length === 0) return null;
  for (const utterance of utterances) {
    const span = findWords(utterance.text, quoteWords);
    if (span) return { utterance, span, match: "word_edges" };
  }
  return null;
}

/**
 * The evidence for a located quote. With word timings, the span maps to the words it overlaps:
 * their audio window and the lowest of their confidences. Without them, or where the words can't
 * be lined up with the text, the window is interpolated by character position across the
 * utterance, and the confidence is the utterance's.
 */
export function evidenceFor(location: QuoteLocation): Evidence {
  const { utterance, span } = location;
  const [start, end] = span;
  const overlapping = alignWords(utterance).filter(
    (aligned) => aligned.start < end && aligned.end > start,
  );
  if (overlapping.length > 0) {
    return {
      utteranceId: utterance.utteranceId,
      span: [start, end],
      audioMs: [
        Math.min(...overlapping.map((aligned) => aligned.word.startMs)),
        Math.max(...overlapping.map((aligned) => aligned.word.endMs)),
      ],
      confidence: Math.min(...overlapping.map((aligned) => aligned.word.confidence)),
    };
  }
  const length = Math.max(utterance.text.length, 1);
  const startMs = utterance.startMs;
  const durationMs = Math.max(utterance.endMs - startMs, 0);
  const at = (offset: number) => startMs + Math.round((durationMs * offset) / length);
  return {
    utteranceId: utterance.utteranceId,
    span: [start, end],
    audioMs: [at(start), at(end)],
    confidence: utterance.confidence,
  };
}

/** Up to `count` words just before the span, joined with spaces: the context a negation hides in. */
export function wordsBefore(location: QuoteLocation, count: number): string {
  const before = words(location.utterance.text.slice(0, location.span[0]));
  return before
    .slice(-count)
    .map((word) => word.raw)
    .join(" ");
}

/** The utterance text the span covers. */
export function spanText(location: QuoteLocation): string {
  return location.utterance.text.slice(location.span[0], location.span[1]);
}

// --- Matching helpers -------------------------------------------------------------------------

/**
 * Lowercases and collapses whitespace, keeping a map from each folded character back to the
 * original index, so a match in the folded text maps back to a span in the original.
 */
function foldCaseAndSpace(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let pendingSpace = -1;
  let index = 0;
  for (const char of text) {
    if (/\s/u.test(char)) {
      if (folded !== "" && pendingSpace < 0) pendingSpace = index;
    } else {
      if (pendingSpace >= 0) {
        folded += " ";
        map.push(pendingSpace);
        pendingSpace = -1;
      }
      const lower = char.toLowerCase();
      for (let i = 0; i < lower.length; i++) map.push(index);
      folded += lower;
    }
    index += char.length;
  }
  return { folded, map };
}

function findFolded(text: string, foldedQuote: string): readonly [number, number] | null {
  if (foldedQuote === "") return null;
  const { folded, map } = foldCaseAndSpace(text);
  const at = folded.indexOf(foldedQuote);
  if (at < 0) return null;
  const first = map[at];
  const last = map[at + foldedQuote.length - 1];
  if (first === undefined || last === undefined) return null;
  return [first, last + codePointLength(text, last)];
}

function codePointLength(text: string, index: number): number {
  const code = text.codePointAt(index);
  return code !== undefined && code > 0xffff ? 2 : 1;
}

interface TextWord {
  /** The word as written, punctuation included. */
  readonly raw: string;
  /** Its comparison key: edge punctuation stripped, lowercased, typographic marks straightened. */
  readonly key: string;
  /** `[start, end)` of the word without its edge punctuation. */
  readonly start: number;
  readonly end: number;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Whitespace-separated words with their keys and spans. Words that are only punctuation drop out. */
function words(text: string): TextWord[] {
  const out: TextWord[] = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const raw = match[0];
    const offset = match.index ?? 0;
    let first = 0;
    let last = raw.length;
    while (first < last && !WORD_CHAR.test(raw.charAt(first))) first++;
    while (last > first && !WORD_CHAR.test(raw.charAt(last - 1))) last--;
    if (first === last) continue;
    out.push({
      raw,
      key: keyOf(raw.slice(first, last)),
      start: offset + first,
      end: offset + last,
    });
  }
  return out;
}

function keyOf(word: string): string {
  return word
    .normalize("NFC")
    .toLowerCase()
    .replace(/[‘’ʼ′]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/[‐-―]/gu, "-");
}

function findWords(text: string, quoteWords: readonly string[]): readonly [number, number] | null {
  const textWords = words(text);
  outer: for (let i = 0; i + quoteWords.length <= textWords.length; i++) {
    for (let j = 0; j < quoteWords.length; j++) {
      if (textWords[i + j]?.key !== quoteWords[j]) continue outer;
    }
    const first = textWords[i];
    const last = textWords[i + quoteWords.length - 1];
    if (first && last) return [first.start, last.end];
  }
  return null;
}

interface AlignedWord {
  readonly word: NonNullable<UtteranceFinalV2["words"]>[number];
  readonly start: number;
  readonly end: number;
}

/** How far ahead in the text a word may be found when the words and the text disagree. */
const ALIGN_LOOKAHEAD = 3;

/**
 * Lines each recognized word up with a word of the text. Providers' words usually match the
 * text one for one, punctuation aside; where they don't (a number written as digits, a word the
 * formatter merged), a word is looked for a few text words ahead, and left out if it isn't there.
 */
function alignWords(utterance: UtteranceFinalV2): AlignedWord[] {
  const recognized = utterance.words ?? [];
  if (recognized.length === 0) return [];
  const textWords = words(utterance.text);
  const out: AlignedWord[] = [];
  let next = 0;
  for (const word of recognized) {
    const key = keyOf(stripEdges(word.w));
    for (let k = next; k < textWords.length && k <= next + ALIGN_LOOKAHEAD; k++) {
      const textWord = textWords[k];
      if (textWord && textWord.key === key) {
        out.push({ word, start: textWord.start, end: textWord.end });
        next = k + 1;
        break;
      }
    }
  }
  return out;
}

function stripEdges(word: string): string {
  let first = 0;
  let last = word.length;
  while (first < last && !WORD_CHAR.test(word.charAt(first))) first++;
  while (last > first && !WORD_CHAR.test(word.charAt(last - 1))) last--;
  return word.slice(first, last);
}
