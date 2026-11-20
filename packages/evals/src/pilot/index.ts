// @earshot/evals/pilot: the pilot kit's pure parts (Phase 5 spec WP7; ADR-0039): the set's name,
// seed, manifest, and results-file shapes, the participants' orders, the statistics, and the
// pre-registered analysis. The builder (build.ts) runs the 200 debriefs through the agent, so it
// isn't exported here: scripts/gen-pilot.ts and the tests import it directly.
export {
  analyzeParticipant,
  analyzePilot,
  CATCH_THRESHOLD,
  type Catch,
  MEDIAN_THRESHOLD_MS,
  MIN_DECISIONS,
  type ParticipantAnalysis,
  type PilotAnalysis,
  POOLED_QUANTILE,
  pilotAnalysisMarkdown,
  type ResultsFile,
  readResultsFile,
} from "./analyze";
export { pilotSetMarkdown, recordWords } from "./describe";
export { balancedLatinRectangle, williamsRow } from "./latin";
export {
  CI_PARTICIPANT,
  MANIFEST_FORMAT,
  type ManifestSession,
  manifestText,
  orderKey,
  ParticipantLabel,
  PILOT_FLAGGED,
  PILOT_PARTICIPANTS,
  PILOT_PRACTICE_COUNT,
  PILOT_PROPOSAL_COUNT,
  PILOT_PROVIDER,
  PILOT_SEED,
  PILOT_SESSION_COUNT,
  PILOT_SET,
  PILOT_SILENT,
  PilotBrowser,
  PilotManifest,
  PilotResults,
  PilotSessionId,
  type ProposalTier,
  participantLabel,
  RESULTS_FORMAT,
  SeededError,
  SILENT_P_RANGE,
  setSha256,
  sha256Hex,
  TierCounts,
} from "./set";
export { clopperPearson, median, nearestRank } from "./stats";
