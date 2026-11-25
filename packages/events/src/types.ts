import type {
  EventEnvelope,
  FollowupAskedV1,
  FollowupClosedV1,
  ProposalCreatedV2,
  ProposalFlaggedV1,
  ProposalReviewedV2,
  ProposalSnoozedV1,
  RecapCreatedV1,
  SessionEndedV1,
  SessionSealedV1,
  SessionStartedV2,
  TurnCompletedV1,
  TurnMeasuredV1,
  TurnWitnessedV1,
  UsageRecordedV1,
  UtteranceFinalV3,
} from "@earshot/core";
import type { z } from "zod";

/** An envelope pinned to one event type, schema version, and payload shape. */
export type TypedEvent<T extends string, V extends number, P> = Omit<
  EventEnvelope,
  "type" | "schemaVersion" | "payload"
> & {
  type: T;
  schemaVersion: V;
  payload: P;
};

export type SessionStartedEvent = TypedEvent<"session.started", 2, SessionStartedV2>;
export type UtteranceFinalEvent = TypedEvent<"utterance.final", 3, UtteranceFinalV3>;
export type ProposalCreatedEvent = TypedEvent<"proposal.created", 2, ProposalCreatedV2>;
export type ProposalReviewedEvent = TypedEvent<"proposal.reviewed", 2, ProposalReviewedV2>;
export type SessionEndedEvent = TypedEvent<"session.ended", 1, SessionEndedV1>;
export type UsageRecordedEvent = TypedEvent<"usage.recorded", 1, UsageRecordedV1>;
export type TurnCompletedEvent = TypedEvent<"turn.completed", 1, TurnCompletedV1>;
export type TurnMeasuredEvent = TypedEvent<"turn.measured", 1, TurnMeasuredV1>;
export type ProposalFlaggedEvent = TypedEvent<"proposal.flagged", 1, ProposalFlaggedV1>;
export type TurnWitnessedEvent = TypedEvent<"turn.witnessed", 1, TurnWitnessedV1>;
export type ProposalSnoozedEvent = TypedEvent<"proposal.snoozed", 1, ProposalSnoozedV1>;
export type SessionSealedEvent = TypedEvent<"session.sealed", 1, SessionSealedV1>;
export type RecapCreatedEvent = TypedEvent<"recap.created", 1, RecapCreatedV1>;
export type FollowupAskedEvent = TypedEvent<"followup.asked", 1, FollowupAskedV1>;
export type FollowupClosedEvent = TypedEvent<"followup.closed", 1, FollowupClosedV1>;

/**
 * A validated event at the latest schema version of its type. Replay upcasts every stored event
 * to one of these before projections see it, so projections handle only the latest versions.
 */
export type SessionEvent =
  | SessionStartedEvent
  | UtteranceFinalEvent
  | ProposalCreatedEvent
  | ProposalReviewedEvent
  | SessionEndedEvent
  | UsageRecordedEvent
  | TurnCompletedEvent
  | TurnMeasuredEvent
  | ProposalFlaggedEvent
  | TurnWitnessedEvent
  | ProposalSnoozedEvent
  | SessionSealedEvent
  | RecapCreatedEvent
  | FollowupAskedEvent
  | FollowupClosedEvent;

/** The latest schema version of each event type. A test checks it against the default registry. */
export const latestVersions = {
  "session.started": 2,
  "utterance.final": 3,
  "proposal.created": 2,
  "proposal.reviewed": 2,
  "session.ended": 1,
  "usage.recorded": 1,
  "turn.completed": 1,
  "turn.measured": 1,
  "proposal.flagged": 1,
  "turn.witnessed": 1,
  "proposal.snoozed": 1,
  "session.sealed": 1,
  "recap.created": 1,
  "followup.asked": 1,
  "followup.closed": 1,
} as const satisfies { [E in SessionEvent as E["type"]]: E["schemaVersion"] };

/** A payload schema and the event type and schema version it belongs to. */
export interface PayloadDefinition {
  readonly type: string;
  readonly schemaVersion: number;
  readonly schema: z.ZodType;
}

/**
 * Moves an event of `type` from `fromVersion` to `fromVersion + 1`. It may change only
 * `schemaVersion` and `payload`, and must not mutate its input. The registry chains upcasters
 * until an event reaches the latest version, so each one only needs to know its neighbor.
 */
export interface Upcaster {
  readonly type: string;
  readonly fromVersion: number;
  readonly up: (event: EventEnvelope) => EventEnvelope;
}
