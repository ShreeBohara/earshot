// Name normalization, for matching only: a card shows the CRM's own spelling. Every matcher here
// (exact names and aliases, Double Metaphone keys, initials, Jaro-Winkler) compares these forms,
// so "Maple & Vine Grocers, Inc." and "maple and vine grocers" are the same name.

/**
 * Legal-form suffixes, ignored at the end of a name ("Midland Steel Corp" matches "Midland
 * Steel"). Lowercase, as they read once folded. Periods are dropped before the check, so "L.L.C."
 * and "Inc." count too.
 */
export const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  "ab",
  "ag",
  "bv",
  "co",
  "company",
  "corp",
  "corporation",
  "gmbh",
  "inc",
  "incorporated",
  "kk",
  "limited",
  "llc",
  "lllp",
  "llp",
  "lp",
  "ltd",
  "nv",
  "oy",
  "pc",
  "plc",
  "pllc",
  "pte",
  "pty",
  "sa",
  "sas",
  "spa",
  "srl",
  "ulc",
]);

/** Marks that join the letters around them: "O'Brien" is "obrien", "L.L.C." is "llc". */
const JOINERS = /['.‘’ʼ]/gu;
/** Anything that isn't a letter, a combining mark, or a number separates words. */
const SEPARATORS = /[^\p{L}\p{M}\p{N}]+/gu;

/**
 * Folds text for comparison:
 * - NFKC, so compatibility forms ("ﬁ", full-width letters) read as plain letters;
 * - case folding ("ß" as "ss", final sigma as sigma);
 * - "&" as "and";
 * - apostrophes and periods dropped, joining what they separate;
 * - every other punctuation mark or symbol as a space;
 * - runs of spaces as one, none at the ends.
 *
 * Diacritics stay ("José" isn't "Jose"); the sound and trigram matchers absorb them.
 */
export function foldName(text: string): string {
  return (
    text
      .normalize("NFKC")
      // Lower, upper, lower again: full case folding for everything a name holds, "ẞ" → "ß" →
      // "SS" → "ss" included.
      .toLowerCase()
      .toUpperCase()
      .toLowerCase()
      .normalize("NFKC")
      .replaceAll("&", " and ")
      .replace(JOINERS, "")
      .replace(SEPARATORS, " ")
      .trim()
  );
}

/** Whether a folded token is a legal-form suffix such as "inc" or "llc". */
export function isLegalSuffix(token: string): boolean {
  return LEGAL_SUFFIXES.has(token);
}

/**
 * The matching form of a name: `foldName`, then legal-form suffixes dropped from the end, with an
 * "and" they leave behind ("Smith & Co" → "smith"). A name is never emptied: "Corp" alone stays
 * "corp".
 */
export function normalizeName(text: string): string {
  return nameTokens(text).join(" ");
}

/** The matching form's tokens: `normalizeName` split on spaces. Empty for a name with no letters. */
export function nameTokens(text: string): string[] {
  const folded = foldName(text);
  if (folded === "") return [];
  const tokens = folded.split(" ");
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1] ?? "";
    if (!isLegalSuffix(last) && last !== "and") break;
    tokens.pop();
  }
  return tokens;
}
