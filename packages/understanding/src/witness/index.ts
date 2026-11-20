// Comparing the two witnesses (spec §4.6, WP5). Pure: SessionDO runs it once the turn's proposals
// and the unbiased transcript both exist (WP9).
//
// 1. `readUnbiased` (read.ts): the unbiased witness's words where a proposal quotes the biased
//    transcript, by word timings or, without them, by `alignTokens`.
// 2. `compareWitnesses` (compare.ts): links that reading with the same index and context, and
//    applies the rule: readings that sound different (code distance ≥ θ_d) and reach different
//    outcomes conflict. A conflict downgrades a decided target to "ask", or flags the field.
export {
  compareWitnesses,
  MAX_DOWNGRADE_RECORDS,
  mergeCandidates,
  readingDistance,
  TARGET_FIELD,
  type TargetDowngrade,
  type UnbiasedMention,
  type WitnessComparison,
  type WitnessFlag,
  type WitnessInput,
  type WitnessOutcome,
} from "./compare";
export {
  type BiasedQuote,
  coveredRange,
  FILLERS,
  MAX_EDGE_WORDS,
  READING_PAD_MS,
  type ReadingMethod,
  readUnbiased,
  type TimedWord,
  type TranscriptToken,
  transcriptTokens,
  type UnbiasedReading,
  type WitnessUtterance,
} from "./read";
