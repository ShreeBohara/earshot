// @earshot/evals: eval harness v0 (Phase 3 spec, WP11). The 30 debrief scripts and their ground
// truth, the schema and coverage rules they meet, the session context their cassettes are keyed
// on, and the contract for what the Kokoro renderer (lab/scripts/render_debriefs.py) writes.
// Then what the fake-microphone e2e test (apps/web/e2e/eval) checks and reports: each turn
// against its script, latency p50 and p95, the baselines, and the live run's budget guard.
// The cassettes themselves are in `@earshot/evals/cassettes`.
export {
  type ActualProposal,
  type ActualTurn,
  datasetIdsFor,
  type TurnCheckOptions,
  type TurnLatency,
  turnProblems,
  turnsFromEvents,
} from "./check";
export { COVERAGE_MINIMUMS, type Coverage, confusableTargets, coverageOf } from "./coverage";
export { DEBRIEF_FILES, DEBRIEFS, debrief, debriefAt } from "./debriefs";
export {
  ASSEMBLYAI_STREAMS_PER_MINUTE,
  estimateLiveSpend,
  LIVE_ESTIMATE,
  LIVE_PAIRS,
  type LiveFixture,
  type LivePair,
  type PairEstimate,
  type ProviderModel,
  pairName,
  parseBudget,
  parsePairs,
  type SpendEstimate,
  streamDelayMs,
} from "./live";
export {
  BASELINE_VERSION,
  type BaselineSource,
  baselineFrom,
  EVAL_REPORT_VERSION,
  EvalBaseline,
  EvalReport,
  EvalScriptResult,
  EvalTurnResult,
  LATENCY_STAGES,
  type LatencyStage,
  type LatencyStats,
  latencyStats,
  mergeReports,
  pairOf,
  percentile,
  type ReportMarkdownOptions,
  reportMarkdown,
  STAGE_LABELS,
  type StageStats,
  scriptPassed,
} from "./report";
export {
  DEBRIEF_FORMAT_VERSION,
  DebriefScript,
  DebriefTurn,
  DemoEntityId,
  type ExpectedField,
  ExpectedProposal,
  expectedDecision,
  expectedFields,
  isNormalizedText,
  KEY_FIELDS,
  KOKORO_VOICES,
  KokoroVoice,
  MAX_PAUSE_MS,
  MAX_PROPOSALS_PER_TURN,
  MAX_TURN_CHARS,
  MAX_TURNS,
  MIN_LEAD_IN_MS,
  MIN_PAUSE_MS,
  MIN_TURNS,
  type Named,
  namedOf,
  TURN_TAGS,
  TurnTag,
} from "./schema";
export {
  DEMO_SESSION_ENTITIES,
  demoCompanyOf,
  demoEntity,
  type SessionContext,
  sessionContext,
  turnTranscript,
} from "./session";
export {
  DebriefTiming,
  isStubRender,
  RENDER_SAMPLE_RATE,
  RENDER_TAIL_MS,
  RenderManifest,
  STUB_RENDER_MODEL,
  TimedTurn,
  TimedWord,
} from "./timing";
export {
  CORRECTION_MARKER,
  localDate,
  NEGATION_PATTERN,
  NUMBER_PATTERN,
  parseUsd,
  type ResolvedDate,
  resolveDatePhrase,
} from "./verify";
