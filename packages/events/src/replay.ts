import type { EventEnvelope } from "@earshot/core";
import { StreamError, UnknownEventError } from "./errors";
import type { Projection } from "./projections/projection";
import { defaultRegistry, type EventRegistry, parseEnvelope } from "./registry";
import type { SessionEvent } from "./types";

export interface ReplayOptions {
  registry?: EventRegistry<SessionEvent>;
  /**
   * Skip events whose type the registry doesn't know instead of failing. Off by default, because
   * a reader that doesn't know an event usually can't build correct projections. A newer schema
   * version of a known type is always an error: skipping it would silently drop data.
   */
  allowUnknownTypes?: boolean;
}

/** The state each named projection ends in. */
export type ProjectionStates<P> = {
  [K in keyof P]: P[K] extends Projection<infer S> ? S : never;
};

/**
 * Rebuilds projections from one session's log. Every event's envelope is validated and the log
 * must be one session with seq 0, 1, 2, … and unique ids. Each event is then upcast to the latest
 * version of its type and validated, and only then folded into every projection, in seq order.
 * Replay is deterministic: it never reads the clock or randomness, never mutates `events`, and
 * returns state that shares no objects with them.
 */
export function replay<P extends Record<string, Projection<unknown>>>(
  events: readonly unknown[],
  projections: P,
  options: ReplayOptions = {},
): ProjectionStates<P> {
  const registry = options.registry ?? defaultRegistry;
  const envelopes = events.map((event, index) => parseEnvelope(event, `event ${index}`));
  checkStream(envelopes);

  const current: SessionEvent[] = [];
  for (const envelope of envelopes) {
    if (registry.latestVersion(envelope.type) === undefined) {
      if (options.allowUnknownTypes) continue;
      throw new UnknownEventError(
        envelope,
        "unknown event type (pass allowUnknownTypes to skip events this reader doesn't know)",
      );
    }
    current.push(structuredClone(registry.toLatest(envelope)));
  }

  // Event by event, so the first impossible event is the one a ProjectionError reports.
  const folds = Object.entries(projections).map(([name, projection]) => ({
    name,
    projection,
    state: projection.initial,
  }));
  for (const event of current) {
    for (const fold of folds) fold.state = fold.projection.apply(fold.state, event);
  }
  return Object.fromEntries(folds.map(({ name, state }) => [name, state])) as ProjectionStates<P>;
}

function checkStream(events: readonly EventEnvelope[]): void {
  const sessionId = events[0]?.sessionId;
  const ids = new Set<string>();
  events.forEach((event, index) => {
    if (event.sessionId !== sessionId) {
      throw new StreamError(
        `event ${index} belongs to session ${event.sessionId}, not ${sessionId}: replay one session at a time`,
      );
    }
    if (event.seq !== index) {
      throw new StreamError(
        `event ${index} has seq ${event.seq}: a session's log runs 0, 1, 2, and so on, without gaps`,
      );
    }
    if (ids.has(event.id)) throw new StreamError(`event id ${event.id} appears twice`);
    ids.add(event.id);
  });
}
