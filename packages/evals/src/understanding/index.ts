// @earshot/evals/understanding: eval harness v1's understanding eval (Phase 4 WP10; ADR-0031). All
// 200 debriefs, their extended ground-truth checks, the offline cassettes with seeded and
// labelled model-like errors, the runner, the metrics and report, the likely-edit tiers' metrics
// (Phase 5 WP4), and the $0 gate in CI's `checks` job
// (`pnpm --filter @earshot/evals eval:understanding --check`).
//
// A separate entry point from `@earshot/evals`: it holds the 170 generated scripts, and its
// cassettes are read from disk by the Node scripts and tests, never bundled.
export {
  ERROR_KINDS,
  ERROR_RATES,
  ERROR_SEED,
  ERRORS_VERSION,
  type ErrorKind,
  ErrorLabels,
  errorsAt,
  generateUnderstandingCassettes,
  SeededError,
  seedErrors,
  serializeCassetteFile,
  serializeErrorLabels,
  understandingDrafts,
  understandingUtterances,
} from "./cassettes";
export { ALL_DEBRIEFS, anyDebrief, GENERATED_DEBRIEFS, GENERATED_FILES } from "./debriefs";
export {
  KEY_METRICS,
  type KeyMetric,
  summarize,
  UNDERSTANDING_BASELINE_FORMAT,
  UNDERSTANDING_GATE,
  UnderstandingBaseline,
  UnderstandingSummary,
  understandingGateFailures,
} from "./gate";
export {
  matchTurn,
  type Ratio,
  type TypeCounts,
  targetMatches,
  type UnderstandingMetrics,
  understandingMetrics,
} from "./metrics";
export { type ReportOptions, understandingMarkdown } from "./report";
export {
  applyFlagged,
  type FinalProposal,
  type RunOptions,
  runScript,
  runScriptWith,
  type ScriptRun,
  type TurnRun,
  type TurnUtterances,
} from "./run";
export {
  LOUD_FLOOR_KINDS,
  LOUD_SHARE_INTERIM_CEILING,
  LOUD_SHARE_TARGET,
  MARKED_SHARE_BUDGET,
  needsChange,
  SURFACING_RECALL_BUDGET,
  type TierItem,
  type TierMetrics,
  tierMetrics,
} from "./tiers";
export { groundTruthProblems, unbiasedReadingOf } from "./verify";
