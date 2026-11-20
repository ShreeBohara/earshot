// What "sounds the same" means to the simulator and to the set's ground truth: Double Metaphone
// codes from @earshot/understanding/names (the primitives only: folding, per-word codes, and the
// distance between codes), plus the homophone list. The linker (WP4) builds its own features on
// the same codes; this file decides the labels, so it stays small and stays here.
//
// Two words are:
// - "same" when they fold to the same word, are listed homophones, or share a non-empty code;
// - "near" when their codes are at most `NEAR_DISTANCE` apart (normalized edit distance): one
//   consonant away in a short word ("Lane" LN / "Lake" LK), or two in a long one;
// - "far" otherwise.
//
// Phrases are compared word by word, in order, where one word may stand for two ("Glow Vex" for
// "Glovex") and two for one. Connectors ("and", "of", "the") and legal suffixes ("Co", "Corp")
// carry no sound and are left out first.
import {
  type Codes,
  codeDistance,
  foldName,
  isLegalSuffix,
  sameSound,
  wordCodes,
} from "@earshot/understanding/names";
import { areHomophones } from "./homophones";

/** Two words whose codes are at most this far apart are near: one edit in a two-letter code. */
export const NEAR_DISTANCE = 0.5;

const CONNECTORS: ReadonlySet<string> = new Set(["and", "of", "the"]);

/** One word of a phrase, folded, with its codes. */
export interface SoundWord {
  readonly text: string;
  readonly codes: Codes;
}

export type Likeness = "same" | "near" | "far";

/**
 * The words of a name or mention that carry sound: folded (`foldName`), without connectors and
 * legal suffixes. A phrase made only of those keeps all its words, so it still has some.
 */
export function soundWords(text: string): readonly SoundWord[] {
  const cached = PHRASES.get(text);
  if (cached) return cached;
  const folded = foldName(text);
  const all = folded === "" ? [] : folded.split(" ");
  const kept = all.filter((word) => !CONNECTORS.has(word) && !isLegalSuffix(word));
  const words = (kept.length > 0 ? kept : all).map(soundWord);
  PHRASES.set(text, words);
  return words;
}

// Memos: the generator compares the same few hundred names many thousand times. Both maps are
// bounded by the vocabulary the set uses.
const PHRASES = new Map<string, readonly SoundWord[]>();
const WORDS = new Map<string, SoundWord>();

function soundWord(text: string): SoundWord {
  let word = WORDS.get(text);
  if (!word) {
    word = { text, codes: wordCodes(text) };
    WORDS.set(text, word);
  }
  return word;
}

function hasCodes(codes: Codes): boolean {
  return codes.primary !== "" || codes.alternate !== "";
}

/** How alike two words sound, with the distance between their codes (0 when the same). */
export function wordLikeness(a: SoundWord, b: SoundWord): { likeness: Likeness; distance: number } {
  if (a.text === b.text || areHomophones(a.text, b.text)) return { likeness: "same", distance: 0 };
  if (!hasCodes(a.codes) || !hasCodes(b.codes)) return { likeness: "far", distance: 1 };
  if (sameSound(a.codes, b.codes)) return { likeness: "same", distance: 0 };
  const distance = codeDistance(a.codes, b.codes);
  return { likeness: distance <= NEAR_DISTANCE ? "near" : "far", distance };
}

/** `wordLikeness` on raw words, folded first. */
export function wordsLikeness(a: string, b: string): Likeness {
  return wordLikeness(soundWord(foldName(a)), soundWord(foldName(b))).likeness;
}

function joined(first: SoundWord, second: SoundWord): SoundWord {
  return soundWord(first.text + second.text);
}

/** How a phrase lines up with another: how many word pairs were only near, and their distance. */
export interface PhraseMatch {
  readonly near: number;
  readonly distance: number;
  /** How many words of the second phrase were matched: all of them, unless `prefix` was set. */
  readonly matched: number;
}

export interface AlignOptions {
  /** Let the second phrase run on past the first ("Juniper Bay" against "Juniper Bay Telecom"). */
  readonly prefix: boolean;
  /** How many word pairs may be near rather than the same. */
  readonly maxNear: number;
}

function better(a: PhraseMatch | null, b: PhraseMatch): boolean {
  return a === null || b.near < a.near || (b.near === a.near && b.distance < a.distance - 1e-12);
}

/**
 * Lines up `heard` with `form` word by word, in order: each step pairs one word with one, one
 * with two joined, or two joined with one. A one-to-one pair must be at least near; a joined
 * pair must sound the same. Null when no
 * alignment covers every word of `heard` (and of `form`, without `prefix`) within `maxNear` near
 * pairs. Of several, the one with the fewest near pairs and then the least distance wins.
 */
export function alignPhrase(
  heard: readonly SoundWord[],
  form: readonly SoundWord[],
  options: AlignOptions,
): PhraseMatch | null {
  if (heard.length === 0 || form.length === 0) return null;
  const rows = heard.length + 1;
  const cols = form.length + 1;
  const best: (PhraseMatch | null)[] = new Array(rows * cols).fill(null);
  best[0] = { near: 0, distance: 0, matched: 0 };
  const at = (i: number, j: number) => best[i * cols + j] ?? null;
  const step = (i: number, j: number, di: number, dj: number, x: SoundWord, y: SoundWord) => {
    const from = at(i, j);
    if (from === null) return;
    const { likeness, distance } = wordLikeness(x, y);
    // A split or a join moves a word boundary; it never also changes a sound.
    if (likeness === "far" || (likeness === "near" && di + dj > 2)) return;
    const candidate = {
      near: from.near + (likeness === "near" ? 1 : 0),
      distance: from.distance + distance,
      matched: j + dj,
    };
    if (candidate.near > options.maxNear) return;
    const index = (i + di) * cols + (j + dj);
    if (better(best[index] ?? null, candidate)) best[index] = candidate;
  };
  for (let i = 0; i < heard.length; i++) {
    for (let j = 0; j < form.length; j++) {
      const x = heard[i] as SoundWord;
      const y = form[j] as SoundWord;
      step(i, j, 1, 1, x, y);
      const y2 = form[j + 1];
      if (y2) step(i, j, 1, 2, x, joined(y, y2));
      const x2 = heard[i + 1];
      if (x2) step(i, j, 2, 1, joined(x, x2), y);
    }
  }
  let result: PhraseMatch | null = null;
  const last = heard.length;
  for (let j = options.prefix ? 1 : form.length; j <= form.length; j++) {
    const candidate = at(last, j);
    if (candidate !== null && better(result, candidate)) result = candidate;
  }
  return result;
}

/** Whether two phrases sound the same, word for word (no near pairs, no words left over). */
export function sameSoundPhrase(a: string, b: string): boolean {
  return alignPhrase(soundWords(a), soundWords(b), { prefix: false, maxNear: 0 }) !== null;
}
