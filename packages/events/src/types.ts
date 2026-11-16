import type {
  EventEnvelope,
  ProposalCreatedV1,
  ProposalReviewedV1,
  SessionEndedV1,
  SessionStartedV1,
  TurnCompletedV1,
  TurnMeasuredV1,
  UsageRecordedV1,
  UtteranceFinalV2,
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

export type SessionStartedEvent = TypedEvent<"session.started", 1, SessionStartedV1>;
export type UtteranceFinalEvent = TypedEvent<"utterance.final", 2, UtteranceFinalV2>;
export type ProposalCreatedEvent = TypedEvent<"proposal.created", 1, ProposalCreatedV1>;
export type ProposalReviewedEvent = TypedEvent<"proposal.reviewed", 1, ProposalReviewedV1>;
export type SessionEndedEvent = TypedEvent<"session.ended", 1, SessionEndedV1>;
export type UsageRecordedEvent = TypedEvent<"usage.recorded", 1, UsageRecordedV1>;
export type TurnCompletedEvent = TypedEvent<"turn.completed", 1, TurnCompletedV1>;
export type TurnMeasuredEvent = TypedEvent<"turn.measured", 1, TurnMeasuredV1>;

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
  | TurnMeasuredEvent;

/** The latest schema version of each event type. A test checks it against the default registry. */
export const latestVersions = {
  "session.started": 1,
  "utterance.final": 2,
  "proposal.created": 1,
  "proposal.reviewed": 1,
  "session.ended": 1,
  "usage.recorded": 1,
  "turn.completed": 1,
  "turn.measured": 1,
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
