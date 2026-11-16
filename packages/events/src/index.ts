// The envelope every store reads and writes, so a store's users need not depend on @earshot/core.
export type { EventEnvelope } from "@earshot/core";
export {
  ConcurrencyError,
  EventValidationError,
  JsonlError,
  ProjectionError,
  StreamError,
  UnknownEventError,
  UpcastError,
} from "./errors";
export { type FromJsonlOptions, fromJsonl, toJsonl } from "./jsonl";
export {
  defaultProjections,
  type Projection,
  type ProposalStatus,
  type ProposalView,
  proposalsProjection,
  type ReviewView,
  type SessionView,
  sessionProjection,
  type UtteranceView,
  utterancesProjection,
} from "./projections";
export {
  createEventRegistry,
  defaultRegistry,
  type EventRegistry,
  parseEnvelope,
} from "./registry";
export { type ProjectionStates, type ReplayOptions, replay } from "./replay";
export {
  type AppendBatch,
  checkExpectedLastSeq,
  checkFromSeq,
  type EventDraft,
  type EventStore,
  InMemoryEventStore,
  NO_EVENTS,
  prepareAppend,
} from "./store";
export {
  latestVersions,
  type PayloadDefinition,
  type ProposalCreatedEvent,
  type ProposalReviewedEvent,
  type SessionEndedEvent,
  type SessionEvent,
  type SessionStartedEvent,
  type TurnCompletedEvent,
  type TurnMeasuredEvent,
  type TypedEvent,
  type Upcaster,
  type UsageRecordedEvent,
  type UtteranceFinalEvent,
} from "./types";
export { upcasters, utteranceFinalV1ToV2 } from "./upcasters";
