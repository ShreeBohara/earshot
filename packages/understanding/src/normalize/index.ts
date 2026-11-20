// The value normalizers (spec §4.3 step 3, WP7). Not to be confused with name normalization,
// which is `normalizeName` in `@earshot/understanding/names`.
//
// - Dates (dates.ts): `resolveDate`, a quote resolved against the call time in the rep's time
//   zone with chrono-node and Earshot's weekday and end-of-period rules; `resolveTime` for a
//   meeting's time.
// - Amounts (amounts.ts): `parseAmount`, digits, words, shorthand, ranges, and currencies.
// - Negation (negation.ts): `isNegated`, NegEx-style scopes.
// - Corrections (corrections.ts): `findCorrection`, a value the rep took back.
//
// The faithfulness check (`@earshot/understanding/faithfulness`) runs them on each field.
export {
  type AmountExpression,
  type AmountReading,
  type CurrencyCode,
  findAmounts,
  parseAmount,
} from "./amounts";
export {
  CORRECTION_FILLERS,
  CORRECTION_MARKERS,
  type Correction,
  findCorrection,
  findCorrections,
  MAX_FILLERS_BEFORE_MARKER,
  MAX_WORDS_BEFORE_REPLACEMENT,
  type QuoteCorrection,
  type ValueFinder,
  type ValueSpan,
} from "./corrections";
export {
  callDate,
  type DateExpression,
  type DateResolution,
  findDates,
  offsetChangesOn,
  resolveDate,
  resolveTime,
  type TimeResolution,
  timeZoneOffset,
} from "./dates";
export {
  isNegated,
  MAX_SCOPE_TOKENS,
  NEGATION_TRIGGERS,
  type NegationScope,
  negationAt,
  negationScopes,
  PSEUDO_TRIGGERS,
  SCOPE_TERMINATORS,
} from "./negation";
export { overlaps, type TextToken, tokenize } from "./text";
