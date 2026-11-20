// Initials and spelled-out abbreviations: "Meridian Supply Co" → "msc", and "M.S.C." or "M S C" as
// a speech-to-text transcript might write it → "msc". Lowercase, like every matching form here.
import { foldName, nameTokens } from "./normalize";

/** Words that don't give a letter: "Consolidated Parts & Supply" → "cps". */
const SKIPPED: ReadonlySet<string> = new Set(["and", "of", "the"]);

function firstLetters(tokens: readonly string[]): string {
  return tokens
    .filter((token) => !SKIPPED.has(token))
    .map((token) => Array.from(token)[0] ?? "")
    .join("");
}

/**
 * A name's initials: the first character of each folded word, except "and", "of", and "the".
 * Legal-form suffixes count, as they do when people abbreviate: "Meridian Supply Co" → "msc".
 */
export function initials(name: string): string {
  const folded = foldName(name);
  return folded === "" ? "" : firstLetters(folded.split(" "));
}

/**
 * Folds text and joins each run of two or more single-character words into one word, as an
 * abbreviation spelled out letter by letter: "M. S. C." → "msc", "A C M E Corp" → "acme corp".
 * A lone initial stays a word: "Dana J Lee" → "dana j lee".
 */
export function joinSpelledLetters(text: string): string {
  const folded = foldName(text);
  if (folded === "") return "";
  const out: string[] = [];
  let run = "";
  const flush = () => {
    if (run !== "") out.push(run);
    run = "";
  };
  for (const token of folded.split(" ")) {
    if (Array.from(token).length === 1) {
      run += token;
    } else {
      flush();
      out.push(token);
    }
  }
  flush();
  return out.join(" ");
}

/**
 * Whether a mention is a name's initials: one word of at least two letters, once spelled-out
 * letters are joined, equal to the name's initials with or without its legal-form suffix
 * ("MSC" and "M.S.C." for "Meridian Supply Co"; "MS" for "Midland Steel Corp").
 */
export function isInitialsOf(mention: string, name: string): boolean {
  const said = joinSpelledLetters(mention);
  if (said.includes(" ") || Array.from(said).length < 2) return false;
  return said === initials(name) || said === firstLetters(nameTokens(name));
}
