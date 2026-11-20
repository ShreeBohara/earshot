// Token alignment at a phonetic-aware cost, for comparing two transcripts of the same audio when
// one has no word timings (spec §4.6): which words of the unbiased transcript did it hear where
// the biased one has the mention?
//
// A weighted edit distance over words, with two extra steps for the commonest way transcripts
// disagree on word boundaries: one word heard as two ("Glovex" / "Glow Vex"), and two heard as
// one. Every step's cost is symmetric, so aligning b to a costs what aligning a to b does.
import { normalizedEditDistance } from "./edit-distance";
import { foldName } from "./normalize";
import { type Codes, codeDistance, sameSound, wordCodes } from "./phonetic";

/** One step of an alignment: the words of each side it covers, and what it cost. */
export interface AlignmentStep {
  /**
   * Indices into the first sequence: none when the second has a word the first doesn't, one, or
   * two when the second heard them as one word.
   */
  readonly a: readonly number[];
  /** Indices into the second sequence, likewise. */
  readonly b: readonly number[];
  readonly cost: number;
}

/** The cheapest alignment of two word sequences: its steps in order, and their total cost. */
export interface Alignment {
  readonly steps: readonly AlignmentStep[];
  readonly cost: number;
}

/** A word with no counterpart on the other side. */
export const GAP_COST = 1;
/** What two different words cost when they share a code: the least a non-identical pair costs. */
const SOUND_ALIKE_COST = 0.2;
/**
 * Added to a split or a join. Joining a filler to an exact match ("uh" + "Acme" against "Acme")
 * costs at least the sound-alike floor, so with this penalty it never beats inserting the filler
 * and matching the word (`GAP_COST`). A real split ("Glow Vex" for "Glovex") still beats
 * substituting one half and inserting the other.
 */
export const MERGE_PENALTY = GAP_COST - SOUND_ALIKE_COST;

interface Word {
  /** Folded, with any inner spaces removed: the word as one unit. */
  readonly text: string;
  readonly codes: Codes;
}

function prepare(raw: string): Word {
  return { text: foldName(raw).replaceAll(" ", ""), codes: wordCodes(raw) };
}

function join(first: Word, second: Word): Word {
  return {
    text: first.text + second.text,
    codes: {
      primary: first.codes.primary + second.codes.primary,
      alternate: first.codes.alternate + second.codes.alternate,
    },
  };
}

function compare(x: Word, y: Word): number {
  if (x.text === y.text) return 0;
  if (x.text === "" || y.text === "") return GAP_COST;
  if (sameSound(x.codes, y.codes)) return SOUND_ALIKE_COST;
  const distance = Math.min(codeDistance(x.codes, y.codes), normalizedEditDistance(x.text, y.text));
  return Math.min(1, SOUND_ALIKE_COST + (1 - SOUND_ALIKE_COST) * distance);
}

/**
 * What substituting one word for the other costs, in [0, 1]: 0 when they fold to the same word,
 * 0.2 when they share a Double Metaphone code ("Nite" / "Knight"), and up to 1 as their codes and
 * spellings diverge, by whichever is closer. Symmetric.
 */
export function wordCost(a: string, b: string): number {
  return compare(prepare(a), prepare(b));
}

type Move = "substitute" | "split" | "join" | "delete" | "insert";

/** How many words of each side a move covers. */
const SPAN: Readonly<Record<Move, readonly [number, number]>> = {
  substitute: [1, 1],
  split: [1, 2],
  join: [2, 1],
  delete: [1, 0],
  insert: [0, 1],
};

/**
 * Aligns two word sequences (transcript words, as they're written) at the least total cost:
 * substituting costs `wordCost`, a word with no counterpart costs 1, and a word heard as two (or
 * two as one) costs `wordCost` of the joined pair plus `MERGE_PENALTY`. Ties break toward
 * substituting, then splits, joins, deletions, and insertions, so the result is deterministic.
 */
export function alignTokens(a: readonly string[], b: readonly string[]): Alignment {
  const left = a.map(prepare);
  const right = b.map(prepare);
  // Each adjacent pair joined into one word, for splits and joins: pairs[k] joins words k and k+1.
  const pairs = (words: readonly Word[]) =>
    words.slice(1).map((word, k) => join(words[k] ?? word, word));
  const leftPairs = pairs(left);
  const rightPairs = pairs(right);
  const width = right.length + 1;
  const cells = (left.length + 1) * width;
  const total = new Float64Array(cells);
  const stepCost = new Float64Array(cells);
  const moves = new Array<Move>(cells).fill("insert");
  const at = (i: number, j: number) => total[i * width + j] ?? Number.POSITIVE_INFINITY;
  // The cell being filled: the first option at the least cost wins, and options come in
  // tie-breaking order.
  let best = Number.POSITIVE_INFINITY;
  let bestMove: Move = "insert";
  let bestCost = 0;
  const consider = (move: Move, before: number, cost: number) => {
    if (before + cost < best) {
      best = before + cost;
      bestMove = move;
      bestCost = cost;
    }
  };

  for (let i = 0; i <= left.length; i++) {
    for (let j = 0; j <= right.length; j++) {
      if (i === 0 && j === 0) continue;
      best = Number.POSITIVE_INFINITY;
      const x = left[i - 1];
      const y = right[j - 1];
      const yJoined = rightPairs[j - 2];
      const xJoined = leftPairs[i - 2];
      if (x && y) consider("substitute", at(i - 1, j - 1), compare(x, y));
      if (x && yJoined) consider("split", at(i - 1, j - 2), MERGE_PENALTY + compare(x, yJoined));
      if (xJoined && y) consider("join", at(i - 2, j - 1), MERGE_PENALTY + compare(xJoined, y));
      if (x) consider("delete", at(i - 1, j), GAP_COST);
      if (y) consider("insert", at(i, j - 1), GAP_COST);
      total[i * width + j] = best;
      moves[i * width + j] = bestMove;
      stepCost[i * width + j] = bestCost;
    }
  }

  const steps: AlignmentStep[] = [];
  let i = left.length;
  let j = right.length;
  while (i > 0 || j > 0) {
    const [ai, bj] = SPAN[moves[i * width + j] ?? "insert"];
    const cost = stepCost[i * width + j] ?? 0;
    steps.push({ a: range(i - ai, i), b: range(j - bj, j), cost });
    i -= ai;
    j -= bj;
  }
  steps.reverse();
  return { steps, cost: at(left.length, right.length) };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, k) => from + k);
}

/**
 * The words of the second sequence aligned with `a[start..end)`: from the first to the last of
 * them, so a word the second side inserted in the middle comes along. Null when the second side
 * has nothing there (every word of the span was deleted), which is an unavailable reading, not
 * a different one.
 */
export function alignedRange(
  alignment: Alignment,
  start: number,
  end: number,
): { start: number; end: number } | null {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const step of alignment.steps) {
    if (!step.a.some((index) => index >= start && index < end)) continue;
    for (const index of step.b) {
      first = Math.min(first, index);
      last = Math.max(last, index);
    }
  }
  return first === Number.POSITIVE_INFINITY ? null : { start: first, end: last + 1 };
}
