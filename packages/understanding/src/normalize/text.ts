// Words and punctuation marks of an utterance, with their spans, for the rules that read a quote
// in its sentence: the negation scope (negation.ts) and the correction markers (corrections.ts).

/** A word, or a single punctuation mark, of an utterance. */
export interface TextToken {
  readonly kind: "word" | "punct";
  /** As written. */
  readonly raw: string;
  /** Lowercased, with typographic apostrophes straightened: "Won’t" reads "won't". */
  readonly key: string;
  /** `[start, end)` in UTF-16 code units of the text, as `Evidence.span` counts. */
  readonly start: number;
  readonly end: number;
}

/**
 * A word is letters and digits, joined by an apostrophe, a hyphen, or a period between them
 * ("won't", "add-on", "1.5"), or by a comma before three digits ("45,000"). Anything else that
 * isn't a space is a punctuation mark of its own.
 */
const TOKEN = /[\p{L}\p{N}]+(?:(?:['’ʼ.-]|,(?=\p{N}{3}(?!\p{N})))[\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;

/** Straight apostrophes and lowercase, the form every rule compares. */
export function tokenKey(text: string): string {
  return text.normalize("NFC").replace(/[‘’ʼ]/gu, "'").toLowerCase();
}

/** The words and punctuation marks of a text, in order. */
export function tokenize(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    const start = match.index;
    tokens.push({
      kind: /[\p{L}\p{N}]/u.test(raw) ? "word" : "punct",
      raw,
      key: tokenKey(raw),
      start,
      end: start + raw.length,
    });
  }
  return tokens;
}

/** Whether `[a, b)` and `[c, d)` share at least one character. */
export function overlaps(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] < right[1] && right[0] < left[1];
}

/**
 * Whether the words of `phrase` start at `tokens[index]`, ignoring punctuation marks between
 * them ("no, wait" is "no wait"). Returns the index just past the phrase's last word, or -1.
 */
export function matchPhrase(
  tokens: readonly TextToken[],
  index: number,
  phrase: readonly string[],
): number {
  let at = index;
  for (const [k, word] of phrase.entries()) {
    if (k > 0) {
      while (tokens[at]?.kind === "punct") at += 1;
    }
    const token = tokens[at];
    if (token?.kind !== "word" || token.key !== word) return -1;
    at += 1;
  }
  return at;
}
