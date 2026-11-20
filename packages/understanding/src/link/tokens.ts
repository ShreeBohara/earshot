// Words and phrases as the linker compares them. A word carries its Double Metaphone codes, the
// codes of its homophone set's first spelling ("Shawn" sounds like "Sean": SN, though its own code
// is XN), and the keys the index files it under. A phrase is a name or a mention in its matching
// form (`normalizeName`), with its significant words and its codes run together two ways.
import {
  type Codes,
  homophoneSet,
  joinSpelledLetters,
  nameTokens,
  normalizedEditDistance,
  sameSound,
  trigrams,
  wordCodes,
} from "../names";

/** Words that carry no sound of their own in a name: "Maple & Vine", "Bank of the West". */
const CONNECTORS: ReadonlySet<string> = new Set(["and", "of", "the"]);

/** Starts a key that names a homophone set rather than a code: "~sean" for Sean, Shawn, Shaun. */
export const HOMOPHONE_KEY = "~";

/** One folded word, with what it sounds like. */
export interface SoundToken {
  readonly text: string;
  /** Its own Double Metaphone codes. */
  readonly codes: Codes;
  /** The codes it's compared by: its homophone set's first spelling's, or its own. */
  readonly sound: Codes;
  /** Its homophone set's key ("~sean"), or null outside the list. */
  readonly homophone: string | null;
  /** What the index files it under: each non-empty code, then its homophone key. */
  readonly keys: readonly string[];
}

/** A folded word's codes and keys. Pass words `nameTokens` produced: folded, one word each. */
export function soundToken(text: string): SoundToken {
  const codes = wordCodes(text);
  const first = homophoneSet(text)?.[0]?.toLowerCase() ?? null;
  const sound = first !== null && first !== text ? wordCodes(first) : codes;
  const homophone = first === null ? null : HOMOPHONE_KEY + first;
  const keys: string[] = [];
  for (const code of [codes.primary, codes.alternate]) {
    if (code !== "" && !keys.includes(code)) keys.push(code);
  }
  if (homophone !== null) keys.push(homophone);
  return { text, codes, sound, homophone, keys };
}

/**
 * Whether two words sound the same: the same folded word, a shared non-empty code ("Nite" and
 * "Knight": NT), or the same homophone set ("Sean" and "Shawn").
 */
export function sameSoundToken(a: SoundToken, b: SoundToken): boolean {
  return (
    a.text === b.text ||
    sameSound(a.codes, b.codes) ||
    (a.homophone !== null && a.homophone === b.homophone)
  );
}

/** A name, alias, or mention as the linker matches it. */
export interface Phrase {
  /** The matching form (`normalizeName`): folded, legal suffixes dropped, "&" as "and". */
  readonly text: string;
  /** Its significant words: connectors dropped, unless the phrase is nothing but connectors. */
  readonly tokens: readonly SoundToken[];
  /**
   * Its codes run together, as distinct non-empty strings: word by word (each word as its
   * homophone set's first spelling), and the words written as one ("yara underhill" for
   * "Yara Under Hill"), primary and alternate. `phonFull` compares these.
   */
  readonly codes: readonly string[];
  /** pg_trgm's trigrams of the matching form, sorted and distinct. */
  readonly trigrams: readonly string[];
  /** Each adjacent pair of `tokens` run together: pairs[k] joins words k and k + 1. */
  readonly pairs: readonly SoundToken[];
}

function addCode(out: string[], code: string): void {
  if (code !== "" && !out.includes(code)) out.push(code);
}

function joinedCodes(tokens: readonly SoundToken[]): string[] {
  const out: string[] = [];
  addCode(out, tokens.map((token) => token.sound.primary).join(""));
  addCode(out, tokens.map((token) => token.sound.alternate).join(""));
  if (tokens.length > 1 || tokens.some((token) => token.sound !== token.codes)) {
    const run = wordCodes(tokens.map((token) => token.text).join(""));
    addCode(out, run.primary);
    addCode(out, run.alternate);
  }
  return out;
}

/**
 * The codes of each proper prefix of a phrase's words, run together word by word: "summit ridge
 * capital" → SMT, SMTRJ. A rep may stop early ("Summit Ridge"), so a mention is compared with
 * these too.
 */
export function prefixCodes(tokens: readonly SoundToken[]): string[] {
  const out: string[] = [];
  for (let k = 1; k < tokens.length; k++) {
    const prefix = tokens.slice(0, k);
    addCode(out, prefix.map((token) => token.sound.primary).join(""));
    addCode(out, prefix.map((token) => token.sound.alternate).join(""));
  }
  return out;
}

/** Builds a phrase. `token` lets a caller share one memo of words across many phrases. */
export function phrase(text: string, token: (word: string) => SoundToken = soundToken): Phrase {
  const all = nameTokens(text);
  const kept = all.filter((word) => !CONNECTORS.has(word));
  const tokens = (kept.length > 0 ? kept : all).map(token);
  const matching = all.join(" ");
  return {
    text: matching,
    tokens,
    codes: joinedCodes(tokens),
    trigrams: trigrams(matching),
    pairs: tokens.slice(1).map((second, k) => token((tokens[k]?.text ?? "") + second.text)),
  };
}

/** A mention, ready to compare: its phrase, and its letters joined for initials ("M. S. C."). */
export interface PreparedMention {
  readonly phrase: Phrase;
  /** `joinSpelledLetters`: "M. S. C." → "msc", "A C M E Corp" → "acme corp". */
  readonly spelled: string;
}

export function prepareMention(text: string): PreparedMention {
  return { phrase: phrase(text), spelled: joinSpelledLetters(text) };
}

/**
 * How alike two sets of run-together codes sound, in [0, 1]: 1 minus the normalized edit distance
 * of the closest pair. 0 when either side has no codes.
 */
export function codeSimilarity(a: readonly string[], b: readonly string[]): number {
  let best = 0;
  for (const left of a) {
    for (const right of b) {
      const similarity = 1 - normalizedEditDistance(left, right);
      if (similarity > best) best = similarity;
      if (best === 1) return 1;
    }
  }
  return best;
}

/**
 * Which of `tokens` a phrase says: one of its words sounds like the token, two of its words run
 * together do ("Under Hill" for "Underhill"), or one of its words sounds like the token run
 * together with a neighbour ("Rightfabrication" says both "Right" and "Fabrication").
 */
export function heard(
  tokens: readonly SoundToken[],
  pairs: readonly SoundToken[],
  said: Phrase,
): boolean[] {
  const flags = tokens.map(
    (token) =>
      said.tokens.some((word) => sameSoundToken(token, word)) ||
      said.pairs.some((word) => sameSoundToken(token, word)),
  );
  pairs.forEach((pair, k) => {
    if (said.tokens.some((word) => sameSoundToken(pair, word))) {
      flags[k] = true;
      flags[k + 1] = true;
    }
  });
  return flags;
}

/** Whether two phrases start with the same sound: their first words, or a first word split or joined. */
export function sameHead(a: Phrase, b: Phrase): boolean {
  const [x] = a.tokens;
  const [y] = b.tokens;
  if (!x || !y) return false;
  if (sameSoundToken(x, y)) return true;
  const [xs] = a.pairs;
  const [ys] = b.pairs;
  return (xs !== undefined && sameSoundToken(xs, y)) || (ys !== undefined && sameSoundToken(x, ys));
}
