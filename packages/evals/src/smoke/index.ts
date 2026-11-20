// The live smoke eval (Phase 4 WP11; ADR-0031): eval harness v1's opt-in tier (c). 30 of the 200
// debriefs (smoke.json) as text through a live model, the understanding pipeline, and the second
// witness, scored by the understanding eval's metrics and gated against a three-run baseline with
// a noise band. Budget-guarded before and during each run, paced at 60 requests a minute after a
// slow start, and off in CI until the user turns it on (.github/workflows/eval-smoke.yml).
//
// Nothing here calls a provider by itself: the runner takes the `fetch` it sends through, and
// tests and `--offline` runs hand it cassettes or stubs.
export {
  type BudgetMeter,
  createBudgetMeter,
  estimateSmokeSpend,
  parseSmokeBudget,
  SMOKE_ESTIMATE,
  SMOKE_MAX_BUDGET_USD,
  type SmokeEstimate,
  type TurnTokens,
  turnTokens,
} from "./budget";
export {
  recordSmokeBaseline,
  type SmokeBaselineOptions,
  type SmokeEvalOptions,
  type SmokeEvalResult,
  smokeEval,
} from "./eval";
export {
  allowedDrop,
  baselineMismatch,
  baselineRates,
  SMOKE_BASELINE_FORMAT,
  SMOKE_BASELINE_RUNS,
  SMOKE_GATE,
  SMOKE_GATED,
  SMOKE_GATED_METRICS,
  SmokeBaseline,
  type SmokeFailure,
  type SmokeFailureKind,
  type SmokeGatedMetric,
  type SmokeGateInput,
  type SmokeIdentity,
  type SmokeRates,
  SmokeSummary,
  shouldRerun,
  smokeGateFailures,
  smokeSummary,
} from "./gate";
export {
  createPacer,
  type Pacer,
  type PacerOptions,
  pacedFetch,
  paceGapMs,
  SMOKE_PACE,
} from "./pace";
export {
  SMOKE_REPORT_VERSION,
  type SmokeAttempt,
  SmokeReport,
  smokeAttempt,
  smokeDetailsMarkdown,
  smokeEstimateMarkdown,
  smokeMarkdown,
} from "./report";
export {
  LIVE_LABELS,
  runSmoke,
  SMOKE_RETRY_POLICY,
  type SmokeProgress,
  type SmokeRun,
  type SmokeRunOptions,
  type SmokeStop,
  scoredRuns,
  smokeUtterances,
  spreadWords,
} from "./run";
export {
  buildSmokeSet,
  SMOKE_EXCLUDED,
  SMOKE_MAX_TURNS,
  SMOKE_MINIMUMS,
  SMOKE_SEED,
  SMOKE_SET_VERSION,
  SMOKE_SIZE,
  SmokeSet,
  type SmokeStrata,
  type SmokeStratum,
  selectSmokeSet,
  serializeSmokeSet,
  smokeScripts,
  smokeShortfalls,
  smokeStrata,
  stratumCount,
} from "./select";
