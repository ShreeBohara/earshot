// Keyterm limits, enforced by each adapter on connect and on every mid-stream update. The web
// app's keyterm route ranks and trims first (spec WP3 step 4); this is the backstop, so a bad list
// can never cost a socket.
//
// - AssemblyAI: at most 100 terms of at most 50 characters. Longer terms are ignored and more
//   than 100 is an error, so longer terms are dropped here and the list is cut to 100.
// - Deepgram: "up to 100" terms and 500 tokens in total, with 20–50 advised. Earshot sends at
//   most 50, under a conservative token estimate, since Deepgram doesn't document its tokenizer.

export interface KeytermLimits {
  readonly maxKeyterms: number;
  readonly maxKeytermChars?: number;
  readonly maxKeytermTokens?: number;
}

export const ASSEMBLYAI_KEYTERM_LIMITS = {
  maxKeyterms: 100,
  maxKeytermChars: 50,
} as const satisfies KeytermLimits;

export const DEEPGRAM_KEYTERM_LIMITS = {
  maxKeyterms: 50,
  maxKeytermTokens: 500,
} as const satisfies KeytermLimits;

export interface KeytermPlan {
  /** What to send, in the caller's order. */
  readonly terms: readonly string[];
  readonly dropped: {
    /** Repeats, ignoring case and spacing. */
    readonly duplicates: number;
    /** Over `maxKeytermChars`. */
    readonly tooLong: number;
    /** Past `maxKeyterms`. */
    readonly overCount: number;
    /** Wouldn't fit the token budget. */
    readonly overTokens: number;
  };
}

/**
 * A deliberately high estimate of a term's tokens: a token per 3 letters of each word (common
 * English runs nearer 4; names split more), a token per 2 digits, and one per other symbol, plus
 * one for the term itself.
 */
export function estimateKeytermTokens(term: string): number {
  let tokens = 1;
  for (const piece of term.match(/\p{L}+|\p{N}+|[^\p{L}\p{N}\s]/gu) ?? []) {
    if (/^\p{L}/u.test(piece)) tokens += Math.ceil(piece.length / 3);
    else if (/^\p{N}/u.test(piece)) tokens += Math.ceil(piece.length / 2);
    else tokens += 1;
  }
  return tokens;
}

/** Trims, collapses inner whitespace, and strips control characters. */
export function normalizeKeyterm(term: string): string {
  return term
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Applies a provider's limits to a ranked keyterm list. Never throws. */
export function prepareKeyterms(terms: readonly string[], limits: KeytermLimits): KeytermPlan {
  const seen = new Set<string>();
  const kept: string[] = [];
  let duplicates = 0;
  let tooLong = 0;
  let overCount = 0;
  let overTokens = 0;
  let tokens = 0;
  for (const raw of terms) {
    const term = normalizeKeyterm(raw);
    if (term === "") continue;
    const key = term.toLowerCase();
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    if (limits.maxKeytermChars !== undefined && term.length > limits.maxKeytermChars) {
      tooLong += 1;
      continue;
    }
    if (kept.length >= limits.maxKeyterms) {
      overCount += 1;
      continue;
    }
    if (limits.maxKeytermTokens !== undefined) {
      const cost = estimateKeytermTokens(term);
      if (tokens + cost > limits.maxKeytermTokens) {
        overTokens += 1;
        continue;
      }
      tokens += cost;
    }
    kept.push(term);
  }
  return { terms: kept, dropped: { duplicates, tooLong, overCount, overTokens } };
}
