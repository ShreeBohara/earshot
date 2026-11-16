import {
  Evidence,
  ProposalCreatedV1,
  ProposalField,
  ProposalType,
  RiskFlag,
  RiskKind,
} from "./proposal-created";
import { FieldEdit, ProposalReviewedV1, ReviewDecision } from "./proposal-reviewed";
import { SessionEndedV1 } from "./session-ended";
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
import { UsageKind, UsageRecordedV1 } from "./usage-recorded";
import { UtteranceFinalV1, UtteranceFinalV2, Witness, Word } from "./utterance-final";

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
] as const;

export type EventPayloadContract = (typeof eventPayloadContracts)[number];

export {
  CaptureMode,
  Evidence,
  FieldEdit,
  FieldName,
  FieldValue,
  ProposalCreatedV1,
  ProposalField,
  ProposalReviewedV1,
  ProposalType,
  ProviderModel,
  ReviewDecision,
  RiskFlag,
  RiskKind,
  SessionEndedV1,
  SessionMode,
  SessionProviders,
  SessionStartedV1,
  TurnCompletedV1,
  TurnMeasuredV1,
  TurnOutcome,
  UsageKind,
  UsageRecordedV1,
  UtteranceFinalV1,
  UtteranceFinalV2,
  VoiceEngine,
  Witness,
  Word,
};
