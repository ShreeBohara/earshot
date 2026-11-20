// @earshot/evals/recap: the recap eval (Phase 5 WP10; ADR-0037). All 200 debriefs' recaps on both
// adapters' offline cassettes, built from the ground truth with seeded, labelled bad sentences and
// invented lens quotes; the replay through `runRecap` and the checks in code; the metrics, report,
// and CI's `checks` gate (`pnpm --filter @earshot/evals eval:recap --check`).
//
// A separate entry point, like `@earshot/evals/understanding`: its cassettes are read from disk by
// the Node scripts and tests, never bundled.
export {
  BAD_SENTENCE_KINDS,
  BadLensQuote,
  BadSentence,
  type BadSentenceKind,
  generateRecapCassettes,
  groundTruthLens,
  groundTruthSentences,
  RECAP_ERROR_RATES,
  RECAP_LABELS_VERSION,
  RECAP_LENS_ROTATION,
  RECAP_SEED,
  RecapLabels,
  recapCassetteInput,
  recapLensOf,
  recapScenario,
  recapScriptProposals,
  recapScriptUtterances,
  seedRecapErrors,
  serializeRecapLabels,
} from "./cassettes";
export {
  type Count,
  RECAP_BASELINE_FORMAT,
  RECAP_GATE,
  RecapBaseline,
  type RecapMetrics,
  type RecapRun,
  RecapSummary,
  recapGateFailures,
  recapMetrics,
  runRecapScript,
  summarizeRecap,
} from "./eval";
export { type RecapReportOptions, recapMarkdown } from "./report";
