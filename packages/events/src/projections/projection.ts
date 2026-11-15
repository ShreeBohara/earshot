import type { SessionEvent } from "../types";

/**
 * A pure fold over a session's events: `state = apply(state, event)`, starting from `initial`.
 * `apply` must not mutate `state` or `event`, and must not read the clock or randomness; times
 * come from the events. Replaying the same events therefore always rebuilds the same state.
 * Projections see only validated events at the latest schema version; they return `state`
 * unchanged for event types they don't use.
 */
export interface Projection<S> {
  readonly initial: S;
  apply(state: S, event: SessionEvent): S;
}
