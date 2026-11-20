// The mishearing rules (spec WP3 step 1). Each rule lists every way it could change a name, so
// the simulator can pick a rule among those that apply and then one of its outcomes, using the
// seeded stream for both. A rule never changes a word it can't change believably: vowels after
// the first letter, consonants by the swaps below, splits only where the word is a compound.
//
// "Same sound" rules (homophone, commonSpelling, vowel, consonant, split, join) keep every word's
// sound as `sound.ts` defines it: each candidate is checked, and one that changed the sound is
// dropped. `soundChange` keeps only candidates one consonant away ("near"). `dropTail` drops the
// last word, which is a deletion, not a change of sound.
import type { EntityKind } from "@earshot/core";
import { isLegalSuffix } from "@earshot/understanding/names";
import { commonSpelling, homophoneSet } from "./homophones";
import { soundWords, wordsLikeness } from "./sound";

export const MISHEAR_OPS = [
  "homophone",
  "commonSpelling",
  "vowel",
  "consonant",
  "soundChange",
  "split",
  "join",
  "dropTail",
] as const;
export type MishearOp = (typeof MISHEAR_OPS)[number];

const VOWEL_SWAPS: Readonly<Record<string, readonly string[]>> = {
  a: ["e", "o"],
  e: ["a", "i"],
  i: ["e", "y"],
  o: ["u", "a"],
  u: ["o"],
  y: ["i", "ie"],
  ee: ["ea", "i"],
  ea: ["ee"],
  oo: ["ou"],
  ou: ["oo"],
};

/**
 * Consonant swaps a listener can't hear inside a word: voicing pairs Double Metaphone merges,
 * spellings, doubling. A word's first letter only ever changes by `INITIAL_SWAPS`, since "Bruno"
 * and "Pruno" sound different to a person even where the codes agree.
 */
const SAME_SOUND_SWAPS: readonly (readonly [string, string])[] = [
  ["t", "d"],
  ["d", "t"],
  ["p", "b"],
  ["b", "p"],
  ["c", "k"],
  ["k", "c"],
  ["ck", "k"],
  ["k", "ck"],
  ["f", "v"],
  ["v", "f"],
  ["ph", "f"],
  ["f", "ph"],
  ["s", "z"],
  ["z", "s"],
  ["x", "ks"],
  ["ll", "l"],
  ["tt", "t"],
  ["ss", "s"],
  ["nn", "n"],
  ["rr", "r"],
  ["mm", "m"],
];

/** Letters a stream may double, only between two vowels ("Sara" as "Sarra"). */
const DOUBLED = ["l", "s", "r", "n", "t"];
const VOWEL = /[aeiouy]/;

/** Every way to double one of `DOUBLED` between two vowels in `word`. */
function doublings(word: string): string[] {
  const lower = word.toLowerCase();
  const out: string[] = [];
  for (let at = 1; at + 1 < lower.length; at++) {
    const letter = lower[at] as string;
    if (!DOUBLED.includes(letter)) continue;
    if (!VOWEL.test(lower[at - 1] ?? "") || !VOWEL.test(lower[at + 1] ?? "")) continue;
    out.push(inCase(word, lower.slice(0, at) + letter + lower.slice(at)));
  }
  return out;
}

/** Swaps at the start of a word that keep its sound: "Catherine" and "Katherine". */
const INITIAL_SWAPS: readonly (readonly [string, string])[] = [
  ["c", "k"],
  ["k", "c"],
  ["ph", "f"],
];

/** Swaps that change the sound by one consonant: what a stream without keyterms gets wrong. */
const SOUND_CHANGE_SWAPS: readonly (readonly [string, string])[] = [
  ["m", "n"],
  ["n", "m"],
  ["l", "r"],
  ["r", "l"],
  ["p", "f"],
  ["b", "v"],
  ["v", "b"],
  ["t", "k"],
  ["g", "d"],
];

/**
 * Compounds a stream may hear as two words ("Glovex" as "Glow Vex"), from the demo CRM's names
 * and the decoys. The parts join back to the word, so the sound is the same.
 */
const SPLITS: Readonly<Record<string, readonly [string, string]>> = {
  adeyemi: ["ade", "yemi"],
  castellano: ["castell", "ano"],
  copperleaf: ["copper", "leaf"],
  copperline: ["copper", "line"],
  dalgaard: ["dal", "gaard"],
  eriksen: ["erik", "sen"],
  ferndale: ["fern", "dale"],
  fernhill: ["fern", "hill"],
  fontaine: ["fon", "taine"],
  globalex: ["global", "ex"],
  globelex: ["globe", "lex"],
  glovex: ["glow", "vex"],
  harborside: ["harbor", "side"],
  harborview: ["harbor", "view"],
  ironbridge: ["iron", "bridge"],
  ironridge: ["iron", "ridge"],
  knightley: ["knight", "ley"],
  kowalski: ["ko", "walski"],
  lindqvist: ["lind", "qvist"],
  nakamura: ["naka", "mura"],
  northwind: ["north", "wind"],
  northwood: ["north", "wood"],
  oakmere: ["oak", "mere"],
  oakmont: ["oak", "mont"],
  okafor: ["oka", "for"],
  quintero: ["quin", "tero"],
  rasmussen: ["rasmus", "sen"],
  redwood: ["red", "wood"],
  sandoval: ["sando", "val"],
  tidewater: ["tide", "water"],
  tidewell: ["tide", "well"],
  underhill: ["under", "hill"],
  whitaker: ["whit", "aker"],
  whitfield: ["whit", "field"],
  willowbank: ["willow", "bank"],
  willowbrook: ["willow", "brook"],
  zielinski: ["zie", "linski"],
};

const TRAILING_CONNECTORS: ReadonlySet<string> = new Set(["&", "and", "of", "the", "-"]);

/** A replacement written the way the original was: capitalized if it was. */
function inCase(original: string, replacement: string): string {
  const first = original[0] ?? "";
  if (original.length > 1 && original === original.toUpperCase()) return replacement.toUpperCase();
  return first !== first.toLowerCase()
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase()
    : replacement.toLowerCase();
}

/**
 * A word worth changing: letters only, not an abbreviation such as "MSC", and not a word names
 * are matched without ("Corp", "and"), since changing one would turn silence into a sound.
 */
function isPlainWord(word: string): boolean {
  const lower = word.toLowerCase();
  return (
    /^\p{L}+$/u.test(word) &&
    !(word.length <= 4 && word === word.toUpperCase()) &&
    !isLegalSuffix(lower) &&
    !["and", "of", "the"].includes(lower)
  );
}

function replaceWord(words: readonly string[], index: number, replacement: string): string {
  return words.map((word, i) => (i === index ? replacement : word)).join(" ");
}

/** Every one-place substitution of `from` by `to` in `word`, after its first letter. */
function substitutions(word: string, from: string, to: string, fromIndex = 1): string[] {
  const lower = word.toLowerCase();
  const out: string[] = [];
  for (let at = lower.indexOf(from, fromIndex); at !== -1; at = lower.indexOf(from, at + 1)) {
    out.push(inCase(word, lower.slice(0, at) + to + lower.slice(at + from.length)));
  }
  return out;
}

function distinct(values: readonly string[], except: string): string[] {
  return [...new Set(values)].filter((value) => value !== except);
}

/** Candidates that change one word of the phrase, kept when `keep` holds for the changed word. */
function perWord(
  phrase: string,
  change: (word: string) => readonly string[],
  keep: (before: string, after: string) => boolean,
): string[] {
  const words = phrase.split(" ");
  const out: string[] = [];
  words.forEach((word, index) => {
    if (!isPlainWord(word)) return;
    for (const after of distinct(change(word), word)) {
      if (keep(word, after)) out.push(replaceWord(words, index, after));
    }
  });
  return distinct(out, phrase);
}

const sameSound = (before: string, after: string) => wordsLikeness(before, after) === "same";
const nearSound = (before: string, after: string) => wordsLikeness(before, after) === "near";

/**
 * Every outcome of one rule applied once to a name as said. Contacts are never joined or cut
 * short: a stream writes a person's two names as two words, and "Dana" alone isn't a mention.
 */
export function opCandidates(op: MishearOp, phrase: string, kind: EntityKind): string[] {
  const words = phrase.split(" ");
  switch (op) {
    case "homophone":
      return perWord(
        phrase,
        (word) => (homophoneSet(word) ?? []).map((other) => inCase(word, other)),
        () => true,
      );
    case "commonSpelling":
      return perWord(
        phrase,
        (word) => [inCase(word, commonSpelling(word))],
        () => true,
      );
    case "vowel":
      return perWord(
        phrase,
        (word) =>
          word.length < 4
            ? []
            : Object.entries(VOWEL_SWAPS).flatMap(([from, tos]) =>
                tos.flatMap((to) => substitutions(word, from, to)),
              ),
        sameSound,
      );
    case "consonant":
      return perWord(
        phrase,
        (word) => [
          ...SAME_SOUND_SWAPS.flatMap(([from, to]) => substitutions(word, from, to)),
          ...doublings(word),
          ...INITIAL_SWAPS.flatMap(([from, to]) =>
            word.toLowerCase().startsWith(from) ? [inCase(word, to + word.slice(from.length))] : [],
          ),
        ],
        sameSound,
      );
    case "soundChange":
      return perWord(
        phrase,
        (word) => SOUND_CHANGE_SWAPS.flatMap(([from, to]) => substitutions(word, from, to)),
        nearSound,
      );
    case "split":
      return distinct(
        words.flatMap((word, index) => {
          const parts = SPLITS[word.toLowerCase()];
          if (!parts || !isPlainWord(word)) return [];
          return [replaceWord(words, index, parts.map((part) => inCase(word, part)).join(" "))];
        }),
        phrase,
      );
    case "join": {
      if (kind === "contact") return [];
      const out: string[] = [];
      for (let i = 0; i + 1 < words.length; i++) {
        const a = words[i] as string;
        const b = words[i + 1] as string;
        if (!isPlainWord(a) || !isPlainWord(b) || a.length < 3 || b.length < 3) continue;
        const merged = inCase(a, `${a}${b}`.toLowerCase());
        out.push([...words.slice(0, i), merged, ...words.slice(i + 2)].join(" "));
      }
      return distinct(out, phrase);
    }
    case "dropTail": {
      if (kind === "contact") return [];
      const kept = words.slice(0, -1);
      while (kept.length > 0 && TRAILING_CONNECTORS.has((kept.at(-1) ?? "").toLowerCase())) {
        kept.pop();
      }
      return kept.length > 0 && soundWords(kept.join(" ")).length > 0 ? [kept.join(" ")] : [];
    }
  }
}
