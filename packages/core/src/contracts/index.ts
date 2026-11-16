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
 *
 * The session socket protocol (`session-protocol.ts`) and session tickets are the exceptions:
 * only TypeScript speaks them, and their key-shape and signature checks have no JSON Schema form,
 * so an export would accept data that Zod refuses.
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
export {
  ClientMessage,
  type ClientMessageOf,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  isIanaTimeZone,
  isSessionCloseCode,
  LlmProvider,
  MAX_ENTITY_ALIASES,
  MAX_ENTITY_NAME_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_SESSION_ENTITIES,
  MAX_TIME_ZONE_CHARS,
  MAX_UTTERANCE_TEXT_CHARS,
  type MessageParseFailure,
  type MessageParseResult,
  parseClientMessage,
  parseServerMessage,
  SESSION_CLOSE_CODES,
  SESSION_PROTOCOL_VERSION,
  SESSION_SUBPROTOCOL,
  ServerMessage,
  type ServerMessageOf,
  type SessionClose,
  type SessionCloseCode,
  type SessionCloseName,
  SessionErrorCode,
  sessionCloseFor,
  TURN_KEY_MAX_LENGTH,
  TURN_KEY_MIN_LENGTH,
  TurnKey,
  TurnMarks,
  TurnTrigger,
} from "./session-protocol";
export { EntityRef, EventEnvelope, HealthResponse };
