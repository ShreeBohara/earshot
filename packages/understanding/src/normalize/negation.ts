// Negation, NegEx-style (spec WP7 step 3; decision 11): a trigger word negates the few words after
// it, up to a terminator. It runs as a risk flag beside the model's own reading, cheaply and
// deterministically; where the rule and the model disagree, a reviewer looks.
//
// After Chapman et al.'s NegEx (2001), cut down to what a sales debrief needs: forward scopes only,
// a short trigger list, and the pseudo-triggers that look like negations but aren't.
import { matchPhrase, overlaps, type TextToken, tokenize } from "./text";

/** The most words a trigger negates (target). */
export const MAX_SCOPE_TOKENS = 6;

/**
 * Negation triggers, as token sequences. The spec's list (not, no, never, won't, don't, can't,
 * isn't, without, no longer, not going to) plus the rest of the family the debrief scripts use:
 * every "n't" contraction counts too (see `isTrigger`), and so do the same contractions written
 * without an apostrophe, as speech-to-text sometimes writes them. A longer trigger wins, so the
 * scope of "not going to" starts after "to".
 */
export const NEGATION_TRIGGERS: readonly (readonly string[])[] = [
  ["not", "going", "to"],
  ["no", "longer"],
  ["not"],
  ["no"],
  ["never"],
  ["without"],
  ["cannot"],
  ["none"],
  ["nothing"],
  ["nobody"],
  ["neither"],
  ["nor"],
];

/** Contractions without their apostrophe, which "n't" alone can't catch. */
const BARE_CONTRACTIONS: ReadonlySet<string> = new Set([
  "arent",
  "cant",
  "couldnt",
  "didnt",
  "doesnt",
  "dont",
  "hadnt",
  "hasnt",
  "havent",
  "isnt",
  "shouldnt",
  "wasnt",
  "werent",
  "wont",
  "wouldnt",
]);

/**
 * Phrases that contain a trigger but don't negate what follows: the spec's three (no problem, no
 * doubt, not only) and a few more of the same kind. "no wait" is a correction marker
 * (corrections.ts), not a negation of what comes after it.
 */
export const PSEUDO_TRIGGERS: readonly (readonly string[])[] = [
  ["no", "problem"],
  ["no", "doubt"],
  ["not", "only"],
  ["not", "just"],
  ["no", "worries"],
  ["no", "question"],
  ["no", "matter"],
  ["not", "to", "mention"],
  ["nothing", "but"],
  ["no", "wait"],
];

/** Words that end a scope: the spec's list, plus "though". */
export const SCOPE_TERMINATORS: ReadonlySet<string> = new Set([
  "but",
  "however",
  "although",
  "though",
  "except",
  "still",
]);

/** Punctuation that ends a clause, and with it a scope. */
const CLAUSE_PUNCTUATION: ReadonlySet<string> = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  "-",
  "–",
  "—",
  "(",
  ")",
]);

/** A negation trigger and the words it negates. */
export interface NegationScope {
  /** The trigger as written, such as "won't" or "not going to". */
  readonly trigger: string;
  /** `[start, end)` of the trigger in the text. */
  readonly triggerSpan: readonly [number, number];
  /** `[start, end)` from the first to the last word it negates. */
  readonly scopeSpan: readonly [number, number];
}

function isContraction(token: TextToken): boolean {
  return token.key.endsWith("n't") || BARE_CONTRACTIONS.has(token.key);
}

/** The index just past a trigger at `index`, or -1 when none starts there. */
function triggerEnd(tokens: readonly TextToken[], index: number): number {
  const token = tokens[index];
  if (token?.kind !== "word") return -1;
  for (const phrase of NEGATION_TRIGGERS) {
    const end = matchPhrase(tokens, index, phrase);
    if (end >= 0) return end;
  }
  return isContraction(token) ? index + 1 : -1;
}

function pseudoTriggerEnd(tokens: readonly TextToken[], index: number): number {
  for (const phrase of PSEUDO_TRIGGERS) {
    const end = matchPhrase(tokens, index, phrase);
    if (end >= 0) return end;
  }
  return -1;
}

/**
 * Every negation in a text, in order. A trigger negates the words after it: at most
 * `MAX_SCOPE_TOKENS`, and none past clause punctuation or a terminator. A trigger with nothing
 * after it to negate ("No, they signed") has no scope and isn't listed. Scopes may overlap ("won't
 * consider anything without a warranty").
 */
export function negationScopes(text: string): NegationScope[] {
  const tokens = tokenize(text);
  const scopes: NegationScope[] = [];
  let index = 0;
  while (index < tokens.length) {
    const pseudo = pseudoTriggerEnd(tokens, index);
    if (pseudo >= 0) {
      index = pseudo;
      continue;
    }
    const end = triggerEnd(tokens, index);
    if (end < 0) {
      index += 1;
      continue;
    }
    const first = tokens[index];
    const last = tokens[end - 1];
    let words = 0;
    let scopeStart = -1;
    let scopeEnd = -1;
    for (let k = end; k < tokens.length && words < MAX_SCOPE_TOKENS; k += 1) {
      const token = tokens[k];
      if (!token) break;
      if (token.kind === "punct") {
        if (CLAUSE_PUNCTUATION.has(token.key)) break;
        continue;
      }
      if (SCOPE_TERMINATORS.has(token.key)) break;
      if (scopeStart < 0) scopeStart = token.start;
      scopeEnd = token.end;
      words += 1;
    }
    if (first && last && scopeStart >= 0) {
      scopes.push({
        trigger: text.slice(first.start, last.end),
        triggerSpan: [first.start, last.end],
        scopeSpan: [scopeStart, scopeEnd],
      });
    }
    index = end;
  }
  return scopes;
}

/**
 * The negation a quote sits in: the first whose trigger or scope the quote's `[start, end)` span
 * touches ("Not Pacific Crest": "Pacific Crest" is negated, and so is "Not Pacific Crest"). Null
 * when the quote is outside every scope.
 */
export function negationAt(text: string, span: readonly [number, number]): NegationScope | null {
  return (
    negationScopes(text).find((scope) =>
      overlaps([scope.triggerSpan[0], scope.scopeSpan[1]], span),
    ) ?? null
  );
}

/** Whether a quote sits inside a negation scope (spec WP7 step 3's output). */
export function isNegated(text: string, span: readonly [number, number]): boolean {
  return negationAt(text, span) !== null;
}
