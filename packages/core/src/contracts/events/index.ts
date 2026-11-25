import { FollowupAskedV1, FollowupRule, MAX_FOLLOWUP_TEXT_CHARS } from "./followup-asked";
import { FollowupClosedV1, FollowupOutcome } from "./followup-closed";
import {
  Evidence,
  FieldNorm,
  MAX_TARGET_CANDIDATES,
  ProposalCreatedV1,
  ProposalCreatedV2,
  ProposalField,
  ProposalFieldV2,
  ProposalType,
  ProposalTypeV2,
  RiskFlag,
  RiskFlagV2,
  RiskKind,
  RiskKindV2,
  TARGET_FIELD,
  TargetBasis,
  TargetCandidate,
  TargetDecision,
  TargetV2,
} from "./proposal-created";
import {
  FlagSource,
  ProposalFlaggedV1,
  TargetDowngrade,
  WitnessConflict,
} from "./proposal-flagged";
import {
  FieldEdit,
  LikelyEditTier,
  ProposalReviewedV1,
  ProposalReviewedV2,
  ReopenReason,
  ReviewDecision,
  ReviewDecisionV2,
  Reviewer,
  ReviewInputKind,
  ReviewMode,
  ReviewPolicy,
  ReviewSeen,
  ReviewSurface,
  ReviewTarget,
  ReviewTiming,
  SeenField,
  SeenTarget,
  SignInMethod,
  UNDO_WINDOW_MS,
} from "./proposal-reviewed";
import { ProposalSnoozedV1 } from "./proposal-snoozed";
import {
  MAX_RECAP_EVIDENCE,
  MAX_RECAP_LENS_FIELDS,
  MAX_RECAP_QUOTE_CHARS,
  MAX_RECAP_SENTENCE_CHARS,
  MAX_RECAP_SENTENCES,
  RecapCreatedV1,
  RecapLens,
  RecapLensField,
  RecapLensFieldId,
  RecapLensId,
  RecapOutcome,
  RecapReason,
  RecapSentence,
  RecapSentenceKind,
} from "./recap-created";
import { SessionEndedV1 } from "./session-ended";
import { SealedBy, SessionSealedV1 } from "./session-sealed";
import {
  ProviderModel,
  SessionMode,
  SessionProviders,
  SessionStartedV1,
  VoiceEngine,
} from "./session-started";
import { FieldName, FieldValue } from "./shared";
import { TurnCompletedV1, TurnOutcome } from "./turn-completed";
import { CaptureMode, TurnMeasuredV1 } from "./turn-measured";
import { TurnWitnessedV1, WitnessOutcome, WitnessReason } from "./turn-witnessed";
import { UsageKind, UsageRecordedV1 } from "./usage-recorded";
import {
  UtteranceFinalV1,
  UtteranceFinalV2,
  UtteranceFinalV3,
  UtteranceInput,
  Witness,
  Word,
} from "./utterance-final";

/**
 * Every event payload schema, keyed by the event `type` and `schemaVersion` it belongs to. The
 * payload itself doesn't repeat them: the envelope carries both. `@earshot/events` builds its
 * registry from this list, and the same pair is in each schema's JSON Schema export as
 * `x-event-type` and `x-schema-version`.
 */
export const eventPayloadContracts = [
  { type: "session.started", schemaVersion: 1, schema: SessionStartedV1 },
  { type: "utterance.final", schemaVersion: 1, schema: UtteranceFinalV1 },
  { type: "utterance.final", schemaVersion: 2, schema: UtteranceFinalV2 },
  { type: "proposal.created", schemaVersion: 1, schema: ProposalCreatedV1 },
  { type: "proposal.reviewed", schemaVersion: 1, schema: ProposalReviewedV1 },
  { type: "session.ended", schemaVersion: 1, schema: SessionEndedV1 },
  // Phase 3: the cost meter and the latency gate's records. The projections ignore them.
  { type: "usage.recorded", schemaVersion: 1, schema: UsageRecordedV1 },
  { type: "turn.completed", schemaVersion: 1, schema: TurnCompletedV1 },
  { type: "turn.measured", schemaVersion: 1, schema: TurnMeasuredV1 },
  // Phase 4: proposals whose target the entity linker resolved (v1 upcasts), and the second
  // witness's records. `proposalsProjection` folds `proposal.flagged`; the rest ignore both.
  { type: "proposal.created", schemaVersion: 2, schema: ProposalCreatedV2 },
  { type: "proposal.flagged", schemaVersion: 1, schema: ProposalFlaggedV1 },
  { type: "turn.witnessed", schemaVersion: 1, schema: TurnWitnessedV1 },
  // Phase 5: reviews that say how they were made (v1 upcasts), snoozes, and the seal, after
  // which the web Worker writes the session's reviews. `proposalsProjection` folds reviews and
  // snoozes, and `sessionProjection` the seal.
  { type: "proposal.reviewed", schemaVersion: 2, schema: ProposalReviewedV2 },
  { type: "proposal.snoozed", schemaVersion: 1, schema: ProposalSnoozedV1 },
  { type: "session.sealed", schemaVersion: 1, schema: SessionSealedV1 },
  // Phase 5 WP10: the debrief's recap, written by SessionDO after `session.ended` and before the
  // seal. `sessionProjection` keeps it as the session's `recap`.
  { type: "recap.created", schemaVersion: 1, schema: RecapCreatedV1 },
  // Phase 5 WP13: corrections and follow-up questions. A typed correction is an utterance too, so
  // utterances say how their words arrived (v2 upcasts with `speech`); SessionDO asks follow-up
  // questions after a turn's proposals, and a correction or a skip closes them.
  // `utterancesProjection` folds v3; `proposalsProjection` folds the questions onto their proposals.
  { type: "utterance.final", schemaVersion: 3, schema: UtteranceFinalV3 },
  { type: "followup.asked", schemaVersion: 1, schema: FollowupAskedV1 },
  { type: "followup.closed", schemaVersion: 1, schema: FollowupClosedV1 },
] as const;

export type EventPayloadContract = (typeof eventPayloadContracts)[number];

export {
  CaptureMode,
  Evidence,
  FieldEdit,
  FieldName,
  FieldNorm,
  FieldValue,
  FlagSource,
  FollowupAskedV1,
  FollowupClosedV1,
  FollowupOutcome,
  FollowupRule,
  LikelyEditTier,
  MAX_FOLLOWUP_TEXT_CHARS,
  MAX_RECAP_EVIDENCE,
  MAX_RECAP_LENS_FIELDS,
  MAX_RECAP_QUOTE_CHARS,
  MAX_RECAP_SENTENCE_CHARS,
  MAX_RECAP_SENTENCES,
  MAX_TARGET_CANDIDATES,
  ProposalCreatedV1,
  ProposalCreatedV2,
  ProposalField,
  ProposalFieldV2,
  ProposalFlaggedV1,
  ProposalReviewedV1,
  ProposalReviewedV2,
  ProposalSnoozedV1,
  ProposalType,
  ProposalTypeV2,
  ProviderModel,
  RecapCreatedV1,
  RecapLens,
  RecapLensField,
  RecapLensFieldId,
  RecapLensId,
  RecapOutcome,
  RecapReason,
  RecapSentence,
  RecapSentenceKind,
  ReopenReason,
  ReviewDecision,
  ReviewDecisionV2,
  Reviewer,
  ReviewInputKind,
  ReviewMode,
  ReviewPolicy,
  ReviewSeen,
  ReviewSurface,
  ReviewTarget,
  ReviewTiming,
  RiskFlag,
  RiskFlagV2,
  RiskKind,
  RiskKindV2,
  SealedBy,
  SeenField,
  SeenTarget,
  SessionEndedV1,
  SessionMode,
  SessionProviders,
  SessionSealedV1,
  SessionStartedV1,
  SignInMethod,
  TARGET_FIELD,
  TargetBasis,
  TargetCandidate,
  TargetDecision,
  TargetDowngrade,
  TargetV2,
  TurnCompletedV1,
  TurnMeasuredV1,
  TurnOutcome,
  TurnWitnessedV1,
  UNDO_WINDOW_MS,
  UsageKind,
  UsageRecordedV1,
  UtteranceFinalV1,
  UtteranceFinalV2,
  UtteranceFinalV3,
  UtteranceInput,
  VoiceEngine,
  Witness,
  WitnessConflict,
  WitnessOutcome,
  WitnessReason,
  Word,
};
