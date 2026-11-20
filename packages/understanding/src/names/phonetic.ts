// Double Metaphone (`double-metaphone` 2.0.1), word by word. The JS port returns full-length
// codes ("acceptingness" → AKSPTNNS), while Postgres's `dmetaphone()` stops at 4 characters, so
// keys are only ever computed here and never compared with Postgres's. The port doesn't document
// how it treats spaces and punctuation, so it only ever sees one folded word at a time.
import { doubleMetaphone } from "double-metaphone";
import { normalizedEditDistance } from "./edit-distance";
import { foldName, nameTokens } from "./normalize";

/** A word's Double Metaphone codes. `alternate` equals `primary` when there's one pronunciation. */
export interface Codes {
  readonly primary: string;
  readonly alternate: string;
}

/** One significant token of a name, with its codes. */
export interface TokenCodes extends Codes {
  readonly token: string;
}

/**
 * Words left out of a name's codes and keys: they say nothing about which record it is, and "and"
 * would make "Maple & Vine" sound like every other name with an "and" in it.
 */
const CONNECTORS: ReadonlySet<string> = new Set(["and", "of", "the"]);

function encode(word: string): Codes {
  const [primary, alternate] = doubleMetaphone(word);
  return { primary, alternate };
}

/**
 * The codes of a word as a transcript has it, folded first ("Knight's" → "knights"). Folding can
 * split a word ("AT&T" → "at and t"); each part is encoded and the codes concatenated, so the
 * port never sees a space. Nothing is dropped: this is for transcript words, not names.
 */
export function wordCodes(word: string): Codes {
  const parts = foldName(word).split(" ");
  let primary = "";
  let alternate = "";
  for (const part of parts) {
    if (part === "") continue;
    const codes = encode(part);
    primary += codes.primary;
    alternate += codes.alternate;
  }
  return { primary, alternate };
}

/**
 * The codes of each significant token of a name: the tokens of its matching form
 * (`normalizeName`: legal-form suffixes dropped), without "and", "of", and "the". A token with no
 * letters the algorithm encodes (digits, a lone "h") has empty codes.
 */
export function nameCodes(name: string): TokenCodes[] {
  return nameTokens(name)
    .filter((token) => !CONNECTORS.has(token))
    .map((token) => ({ token, ...encode(token) }));
}

/**
 * Every significant token's primary code, and every alternate, concatenated: the codes `phonFull`
 * compares. "Atmas Group" → ATMSKRP.
 */
export function joinedCodes(name: string): Codes {
  const codes = nameCodes(name);
  return {
    primary: codes.map((token) => token.primary).join(""),
    alternate: codes.map((token) => token.alternate).join(""),
  };
}

/**
 * A CRM record's `phonetic_keys`: every non-empty token code, primary and alternate, of its name
 * and aliases, sorted and without repeats. Two records share a key when some token of one sounds
 * like some token of the other ("Nite Security Group" and "Knight Security" share NT), which is
 * what an overlap query (`&&`) on the column finds.
 */
export function phoneticKeys(names: string | readonly string[]): string[] {
  const keys = new Set<string>();
  for (const name of typeof names === "string" ? [names] : names) {
    for (const { primary, alternate } of nameCodes(name)) {
      if (primary !== "") keys.add(primary);
      if (alternate !== "") keys.add(alternate);
    }
  }
  return [...keys].sort();
}

/** Whether two words or names share a non-empty code, primary or alternate ("Peer" and "Pier"). */
export function sameSound(a: Codes, b: Codes): boolean {
  const left = [a.primary, a.alternate].filter((code) => code !== "");
  return left.some((code) => code === b.primary || code === b.alternate);
}

/**
 * How differently two sets of codes sound, in [0, 1]: the normalized edit distance between them,
 * at the closest of the four pairings of primary and alternate codes. 0 when they share a code,
 * and when neither has any.
 */
export function codeDistance(a: Codes, b: Codes): number {
  // Most words have one pronunciation, so most pairings repeat: each distinct one is measured once.
  let best = normalizedEditDistance(a.primary, b.primary);
  const bHasAlternate = b.alternate !== b.primary;
  if (best > 0 && bHasAlternate)
    best = Math.min(best, normalizedEditDistance(a.primary, b.alternate));
  if (best > 0 && a.alternate !== a.primary) {
    best = Math.min(best, normalizedEditDistance(a.alternate, b.primary));
    if (best > 0 && bHasAlternate) {
      best = Math.min(best, normalizedEditDistance(a.alternate, b.alternate));
    }
  }
  return best;
}

/** `codeDistance` between two names' joined codes: "Atmas" and "Atlas" are 0.25 apart. */
export function phoneticDistance(a: string, b: string): number {
  return codeDistance(joinedCodes(a), joinedCodes(b));
}
