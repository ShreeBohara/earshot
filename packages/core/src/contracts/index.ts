import { EntityRef } from "./entity-ref";
import { EventEnvelope } from "./event-envelope";
import {
  ProposalCreatedV1,
  ProposalReviewedV1,
  SessionEndedV1,
  SessionStartedV1,
  TurnCompletedV1,
  TurnMeasuredV1,
  UsageRecordedV1,
  UtteranceFinalV1,
  UtteranceFinalV2,
} from "./events";
import { HealthResponse } from "./health";

/**
 * Every contract that crosses a process or language boundary. Each one is exported
 * to `schemas/<Name>.json` and generated into Pydantic for the lab.
 */
export const contracts = {
  EventEnvelope,
  HealthResponse,
  SessionStartedV1,
  UtteranceFinalV1,
  UtteranceFinalV2,
  ProposalCreatedV1,
  ProposalReviewedV1,
  SessionEndedV1,
  UsageRecordedV1,
  TurnCompletedV1,
  TurnMeasuredV1,
  EntityRef,
} as const;

export type ContractName = keyof typeof contracts;

export { EntityKind } from "./entity-ref";
export {
  CaptureMode,
  type EventPayloadContract,
  Evidence,
  eventPayloadContracts,
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
} from "./events";
export { EntityRef, EventEnvelope, HealthResponse };
