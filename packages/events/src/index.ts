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
  anyFlagTier,
  checkReview,
  checkReviews,
  checkSnooze,
  type ReviewCheck,
  type ReviewRefusal,
  type ReviewRuleContext,
  type ReviewsCheck,
  type TierOf,
} from "./review-rules";
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
  type ProposalFlaggedEvent,
  type ProposalReviewedEvent,
  type ProposalSnoozedEvent,
  type SessionEndedEvent,
  type SessionEvent,
  type SessionSealedEvent,
  type SessionStartedEvent,
  type TurnCompletedEvent,
  type TurnMeasuredEvent,
  type TurnWitnessedEvent,
  type TypedEvent,
  type Upcaster,
  type UsageRecordedEvent,
  type UtteranceFinalEvent,
} from "./types";
export {
  proposalCreatedV1ToV2,
  proposalReviewedV1ToV2,
  upcasters,
  utteranceFinalV1ToV2,
} from "./upcasters";
