// @earshot/evals/linking: the confusable-name set and its harness (Phase 4 spec, WP3). The set's
// items and their schema, the generator that writes linking/confusable.v1.jsonl, the ground truth
// it labels with, the decoys, the metrics and report, gate G1, linker v0 (Phase 3's matcher), and
// linker v1 (WP4) with its fit on the calibration split and its ablations.
export { type AblationRow, ablationTable } from "./ablations";
export { ALIKE_HEAD_DISTANCE, alikeTo, DECOYS, type Decoy, inDemoCrm } from "./decoys";
export {
  companyOf,
  dealTail,
  entitiesOfKind,
  groupMembers,
  groupOf,
  hasLinkingEntity,
  LINKING_ENTITIES,
  LOOKALIKE_FREE_COMPANIES,
  linkingEntity,
  spokenForms,
} from "./entities";
export {
  ABLATIONS,
  type Ablation,
  FIT_LIMITS,
  type FitConfig,
  type FittedLinker,
  FOLDS,
  FULL_FIT,
  fitLinker,
  gridItemFor,
  LAMBDA,
  WITNESS_ONLY_CLASSES,
} from "./fit";
export {
  BASELINE_FORMAT,
  G1,
  gateFailures,
  LinkingBaseline,
  LinkingMetricsSchema,
  REGRESSION,
  regressionFailures,
  roundMetrics,
  type SplitSummary,
  splitSummary,
} from "./gate";
export { type ConfusableDraft, generateConfusableSet, POOLS, SET_SEED } from "./generate";
export {
  asLinkDecision,
  type CaseReading,
  downgradedDecision,
  LINKER_ORACLE,
  LINKER_V0,
  LINKER_V1,
  LINKERS,
  type LinkDecision,
  type Linker,
  type LinkerInput,
  type LinkingCase,
  type LinkPrediction,
  linkerInput,
  linkerV1,
  linkingCase,
  SEES_ALL,
  type Sees,
  shown,
  unbiasedMention,
  witnessedDecision,
} from "./linkers";
export {
  asExpected,
  binomialCdf,
  clopperPearsonUpper,
  isCorrect,
  isDecided,
  isNewWhenExisting,
  isWrongLink,
  type LinkingMetrics,
  type LinkingReport,
  linkingMetrics,
  linkingReport,
  type Mode,
  type ReliabilityBin,
  RISK_THRESHOLDS,
  type RiskPoint,
  reliability,
  riskCoverage,
  type Scored,
  score,
} from "./metrics";
export {
  type Cue as OracleCue,
  type Observation,
  type Resolution,
  resolve,
  soundMatches,
  TYPE_KINDS,
} from "./oracle";
export { ablationMarkdown, type LinkingMarkdownOptions, linkingMarkdown } from "./report";
export {
  CALIBRATION_SHARE,
  CLASS_COUNTS,
  CLASS_EXPECT,
  CLASS_LABELS,
  CLASS_SHARES,
  CONFUSABLE_SET_FILE,
  CONFUSABLE_SET_VERSION,
  ConfusableItem,
  Cue,
  Expect,
  GoldId,
  ITEM_CLASSES,
  ItemClass,
  itemProblems,
  parseConfusableSet,
  Reading,
  SET_SIZE,
  Span,
  Split,
  serializeConfusableSet,
} from "./schema";
export { fillTemplate, pickTemplate, TEMPLATES, type Template } from "./templates";
