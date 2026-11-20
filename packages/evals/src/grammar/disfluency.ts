// Disfluencies, after LARD (Passali et al., 2022, arXiv 2201.05041): the three kinds it
// generates, repetitions ("I I owe"), replacements ("for, uh, to"), and restarts ("Remind me, uh,
// remind me to"), plus fillers ("um", "you know"). Every witness hears them alike, so they're
// written into the segments that read the same for all three, and only where no field or name
// is: a quote stays a substring of the heard text, and the words next to a date, amount, time,
// stage, email, or phone stay as they were, so the normalizers read those the same way.
import type { Rng } from "../channel/rng";
import { FILLERS, REPLACEMENTS } from "./lexicon";
import { lit, type Seg } from "./segments";

export const DISFLUENCY_KINDS = ["filler", "repetition", "replacement", "restart"] as const;
export type DisfluencyKind = (typeof DISFLUENCY_KINDS)[number];

/** Fields whose neighbouring words a disfluency must leave alone. */
const VALUE_FIELDS = new Set([
  "dueDate",
  "closeDate",
  "date",
  "time",
  "amount",
  "stage",
  "email",
  "phone",
]);

function fieldName(field: string): string {
  const dot = field.indexOf(".");
  return dot < 0 ? field : field.slice(dot + 1);
}

function isWordChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    char === "'"
  );
}

/** A space between two words in a lit at depth 0, or after one, before a name or a field's words. */
interface Gap {
  readonly seg: number;
  readonly at: number;
}

/** A whole word inside a lit at depth 0. */
interface WordAt {
  readonly seg: number;
  readonly start: number;
  readonly end: number;
  readonly word: string;
}

function scan(segs: readonly Seg[]): { gaps: Gap[]; words: WordAt[] } {
  const gaps: Gap[] = [];
  const words: WordAt[] = [];
  let depth = 0;
  segs.forEach((seg, index) => {
    if (seg.kind === "open") depth++;
    else if (seg.kind === "close") depth--;
    if (seg.kind !== "lit" || seg.frozen || depth > 0) return;
    const next = segs[index + 1];
    const prev = segs[index - 1];
    const nextIsValue = next?.kind === "open" && VALUE_FIELDS.has(fieldName(next.field));
    const prevIsValue = prev?.kind === "close" && VALUE_FIELDS.has(fieldName(prev.field));
    const text = seg.text;
    // Words wholly inside the lit: bounded by its edges or spaces, and not touching a value.
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i < text.length && text.charAt(i) !== " ") continue;
      const word = text.slice(start, i);
      const atStart = start === 0;
      const atEnd = i === text.length;
      const whole = word !== "" && [...word].every(isWordChar);
      const touchesValue = (atEnd && nextIsValue) || (atStart && prevIsValue);
      const boundedLeft = atStart ? prev === undefined || prev.kind === "lit" : true;
      // A word running to the lit's end touches whatever comes next, without a space.
      if (whole && !touchesValue && boundedLeft && !atEnd) {
        words.push({ seg: index, start, end: i, word });
      }
      start = i + 1;
    }
    for (let i = 1; i < text.length; i++) {
      if (text.charAt(i) !== " " || !isWordChar(text.charAt(i - 1))) continue;
      const after = text.charAt(i + 1);
      if (i + 1 < text.length) {
        if (isWordChar(after)) gaps.push({ seg: index, at: i });
        continue;
      }
      // A trailing space: before a name, or before the words of a free-text field.
      if (next?.kind === "var" || (next?.kind === "open" && !nextIsValue))
        gaps.push({ seg: index, at: i });
    }
  });
  return { gaps, words };
}

function replaceLit(segs: readonly Seg[], index: number, text: string): Seg[] {
  return segs.map((seg, at) => (at === index ? lit(text) : seg));
}

/** The words a restart repeats: the turn's first words, when it starts with a plain lit. */
function restart(segs: readonly Seg[], rng: Rng): Seg[] | null {
  const first = segs[0];
  if (first?.kind !== "lit" || first.frozen) return null;
  const words = first.text.split(" ");
  const usable = words.findIndex((word) => word === "" || ![...word].every(isWordChar));
  const available = usable < 0 ? words.length - 1 : usable;
  if (available < 2) return null;
  const count = rng.int(1, Math.min(3, available));
  const repeated = words.slice(0, count);
  const lower = (word: string) =>
    word === "I" || word.startsWith("I'") ? word : word.toLowerCase();
  const rest = [lower(words[0] as string), ...words.slice(1)].join(" ");
  const filler = rng.pick(["uh", "um"]);
  return replaceLit(segs, 0, `${repeated.join(" ")}, ${filler}, ${rest}`);
}

/**
 * Adds one disfluency of the given kind; null when the turn has nowhere to put it (a restart
 * needs a plain opening, a replacement a function word it knows).
 */
export function addDisfluency(segs: readonly Seg[], kind: DisfluencyKind, rng: Rng): Seg[] | null {
  if (kind === "restart") return restart(segs, rng);
  const { gaps, words } = scan(segs);
  if (kind === "filler") {
    if (gaps.length === 0) return null;
    const gap = rng.pick(gaps);
    const seg = segs[gap.seg] as Extract<Seg, { kind: "lit" }>;
    const filler = rng.pick(FILLERS);
    return replaceLit(
      segs,
      gap.seg,
      `${seg.text.slice(0, gap.at)}, ${filler},${seg.text.slice(gap.at)}`,
    );
  }
  if (kind === "repetition") {
    const short = words.filter((word) => word.word.length <= 5);
    if (short.length === 0) return null;
    const word = rng.pick(short);
    const seg = segs[word.seg] as Extract<Seg, { kind: "lit" }>;
    const joiner = rng.chance(0.5) ? " " : ", ";
    const text = `${seg.text.slice(0, word.end)}${joiner}${word.word.toLowerCase() === "i" ? "I" : word.word.toLowerCase()}${seg.text.slice(word.end)}`;
    return replaceLit(segs, word.seg, text);
  }
  const swappable = words.filter((word) => REPLACEMENTS[word.word] !== undefined);
  if (swappable.length === 0) return null;
  const word = rng.pick(swappable);
  const seg = segs[word.seg] as Extract<Seg, { kind: "lit" }>;
  const other = rng.pick(REPLACEMENTS[word.word] ?? []);
  const filler = rng.pick(["uh", "um"]);
  const text = `${seg.text.slice(0, word.start)}${other}, ${filler}, ${seg.text.slice(word.start)}`;
  return replaceLit(segs, word.seg, text);
}

/**
 * Whether a text shows a disfluency: a filler, or a word said twice in a row (a repetition, or
 * the repeat a restart makes). Scans tokens; no regular expression to backtrack.
 */
export function showsDisfluency(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .split(" ")
    .map((token) => [...token].filter(isWordChar).join(""))
    .filter((token) => token !== "");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token === "um" || token === "uh" || token === "er") return true;
    if (token === "you" && tokens[i + 1] === "know") return true;
    if (i > 0 && tokens[i - 1] === token) return true;
  }
  // A restart repeats its opening words after the filler, which the loop above already caught;
  // a replacement says a filler, which it caught too.
  return false;
}
