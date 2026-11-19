// @earshot/evals: eval harness v0 (Phase 3 spec, WP11). The 30 debrief scripts and their ground
// truth, the schema and coverage rules they meet, the session context their cassettes are keyed
// on, and the contract for what the Kokoro renderer (lab/scripts/render_debriefs.py) writes.
// The cassettes themselves are in `@earshot/evals/cassettes`.
export { COVERAGE_MINIMUMS, type Coverage, confusableTargets, coverageOf } from "./coverage";
export { DEBRIEF_FILES, DEBRIEFS, debrief } from "./debriefs";
export {
  DEBRIEF_FORMAT_VERSION,
  DebriefScript,
  DebriefTurn,
  DemoEntityId,
  type ExpectedField,
  ExpectedProposal,
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
  RENDER_SAMPLE_RATE,
  RENDER_TAIL_MS,
  RenderManifest,
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
