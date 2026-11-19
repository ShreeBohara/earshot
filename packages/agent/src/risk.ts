// Risk flags with simple patterns (Phase 3 spec, WP5 step 5). Dates, numbers, and negations are
// the costliest values to get wrong, so a reviewer should look twice at any field that holds one.
// Phase 4's normalizers replace these patterns.
import type { RiskFlag } from "@earshot/core";
import { DATE_FIELDS } from "./schema";

/**
 * Evidence below this confidence gets `low_confidence` (target). With word timings it's the
 * lowest word's confidence, so one shaky word in a quote is enough.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

/** How many words before a quote are searched for a negation the quote may have left out. */
export const NEGATION_LOOKBEHIND_WORDS = 3;

const WEEKDAY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
// "May" alone is far more often the verb than the month, so it counts only next to a day number.
const MONTH = "january|february|march|april|june|july|august|september|october|november|december";
const PERIOD = "day|week|month|quarter|year|weekend";

const DATE_PATTERN = new RegExp(
  [
    `\\b(?:${WEEKDAY})\\b`,
    `\\b(?:${MONTH})\\b`,
    String.raw`\bmay\s+\d{1,2}(?:st|nd|rd|th)?\b`,
    String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+of\s+may\b`,
    String.raw`\b(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?\s+\d{1,2}\b`,
    String.raw`\b(?:today|tonight|tomorrow|yesterday)\b`,
    `\\b(?:next|this|last|coming)\\s+(?:${PERIOD}|${WEEKDAY})\\b`,
    `\\bend\\s+of\\s+(?:the\\s+)?(?:${PERIOD})\\b`,
    String.raw`\b(?:eod|eow|eom|eoq|eoy)\b`,
    String.raw`\bq[1-4]\b`,
    String.raw`\bin\s+(?:a|an|one|two|three|four|five|six|\d+)\s+(?:days?|weeks?|months?)\b`,
    String.raw`\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b`,
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
    String.raw`\b\d{1,2}(?:st|nd|rd|th)\b`,
  ].join("|"),
  "iu",
);

// "One" is left out: "one of them" and "the one" are too common to flag.
const NUMBER_PATTERN =
  /\d|\b(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|half|percent)\b/iu;

const NEGATION_PATTERN =
  /\b(?:not|no|never|none|nobody|nothing|neither|nor|without|cannot|\w+n't)\b/iu;

/** Straight apostrophes, so "won’t" reads like "won't". */
function straighten(text: string): string {
  return text.replace(/[‘’ʼ]/gu, "'");
}

export interface FieldRiskInput {
  readonly field: string;
  readonly value: string | number;
  /** The utterance text the evidence span covers. */
  readonly spanText: string;
  /** A few words before the span, from the same utterance. */
  readonly before: string;
  readonly confidence: number;
}

/**
 * The flags for one supported field, in a fixed order: `date`, `number`, `negation`,
 * `low_confidence`.
 * - `date`: a date field, or a quote that names a day, a month, or a relative date.
 * - `number`: a numeric value, or a quote with a digit or a number word. A field already flagged
 *   as a date isn't flagged again for the digits in it.
 * - `negation`: a negation in the quote or in the few words before it, where a quote that starts
 *   after "not" would hide it.
 * - `low_confidence`: evidence below `LOW_CONFIDENCE_THRESHOLD`.
 */
export function fieldRiskFlags(input: FieldRiskInput): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const quote = straighten(input.spanText);
  const isDate = DATE_FIELDS.has(input.field) || DATE_PATTERN.test(quote);
  if (isDate) flags.push({ kind: "date", field: input.field });
  if (!isDate && (typeof input.value === "number" || NUMBER_PATTERN.test(quote))) {
    flags.push({ kind: "number", field: input.field });
  }
  if (NEGATION_PATTERN.test(`${straighten(input.before)} ${quote}`)) {
    flags.push({ kind: "negation", field: input.field });
  }
  if (input.confidence < LOW_CONFIDENCE_THRESHOLD) {
    flags.push({ kind: "low_confidence", field: input.field });
  }
  return flags;
}
