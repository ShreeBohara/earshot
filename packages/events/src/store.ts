import type { EventEnvelope } from "@earshot/core";
import { ConcurrencyError, StreamError } from "./errors";
import { defaultRegistry, type EventRegistry, parseEnvelope } from "./registry";

/** Pass as `expectedLastSeq` when appending to a session that has no events yet. */
export const NO_EVENTS = -1;

/** An event as a writer hands it to `append`. The store fills in `sessionId` and `seq`. */
export interface EventDraft {
  /** UUIDv7, chosen by the writer so the same event keeps one id across retries and transports. */
  id: string;
  type: string;
  schemaVersion: number;
  /** When the event happened, by the writer's clock. The store never reads a clock. */
  ts: string;
  payload: Record<string, unknown>;
  /**
   * Set only when the writer has numbered the event already, as `SessionDO` does before it
   * flushes a batch to Postgres. It must then be the next seq in the session.
   */
  seq?: number;
}

/**
 * One append-only log per session. `seq` is contiguous per session and starts at 0. The interface
 * maps onto the `session_events` table (primary key `session_id, seq`): `append` is one
 * transaction that checks the last seq and inserts the rows, and `read` is an ordered range scan.
 */
export interface EventStore {
  /**
   * Appends events to a session's log, all or nothing. `expectedLastSeq` is the seq of the last
   * event the writer has seen, or `NO_EVENTS`. If the log ends anywhere else, nothing is written
   * and a `ConcurrencyError` is thrown. Events are validated against the payload schema for their
   * type and version, and stored as written: upcasting happens on read, never in the log.
   * Returns the stored events.
   */
  append(
    sessionId: string,
    expectedLastSeq: number,
    events: readonly EventDraft[],
  ): Promise<readonly EventEnvelope[]>;
  /** Reads a session's events in seq order from `fromSeq` (default 0). Unknown sessions are empty. */
  read(sessionId: string, fromSeq?: number): Promise<readonly EventEnvelope[]>;
}

/**
 * An `EventStore` in memory, for tests, the replay demo, and local sessions. Stored events are
 * frozen copies, so neither the writer nor a reader can change the log after the fact.
 */
export class InMemoryEventStore implements EventStore {
  readonly #registry: EventRegistry;
  readonly #logs = new Map<string, readonly EventEnvelope[]>();

  constructor(options: { registry?: EventRegistry } = {}) {
    this.#registry = options.registry ?? defaultRegistry;
  }

  async append(
    sessionId: string,
    expectedLastSeq: number,
    events: readonly EventDraft[],
  ): Promise<readonly EventEnvelope[]> {
    if (!Number.isInteger(expectedLastSeq) || expectedLastSeq < NO_EVENTS) {
      throw new RangeError(
        `expectedLastSeq must be an integer >= ${NO_EVENTS}, got ${expectedLastSeq}`,
      );
    }
    // Everything below runs synchronously, so concurrent appends can't interleave.
    const log = this.#logs.get(sessionId) ?? [];
    const actualLastSeq = log.length - 1;
    if (expectedLastSeq !== actualLastSeq) {
      const reason = expectedLastSeq < actualLastSeq ? "stale" : "gap";
      throw new ConcurrencyError(sessionId, expectedLastSeq, actualLastSeq, reason);
    }

    const ids = new Set(log.map((event) => event.id));
    const stored = events.map((draft, index) => {
      const seq = actualLastSeq + 1 + index;
      if (draft.seq !== undefined && draft.seq !== seq) {
        const reason = draft.seq < seq ? "stale" : "gap";
        throw new ConcurrencyError(
          sessionId,
          expectedLastSeq,
          actualLastSeq,
          reason,
          `session ${sessionId}: event ${index} of the batch is numbered ${draft.seq}, but the next seq is ${seq} (${reason})`,
        );
      }
      const event = parseEnvelope(
        {
          id: draft.id,
          sessionId,
          seq,
          type: draft.type,
          schemaVersion: draft.schemaVersion,
          ts: draft.ts,
          payload: draft.payload,
        },
        `event ${index} of the batch`,
      );
      this.#registry.validate(event);
      if (ids.has(event.id)) {
        throw new StreamError(`event id ${event.id} is already in session ${sessionId}`);
      }
      ids.add(event.id);
      return deepFreeze(structuredClone(event));
    });

    this.#logs.set(sessionId, [...log, ...stored]);
    return stored;
  }

  async read(sessionId: string, fromSeq = 0): Promise<readonly EventEnvelope[]> {
    if (!Number.isInteger(fromSeq) || fromSeq < 0) {
      throw new RangeError(`fromSeq must be a non-negative integer, got ${fromSeq}`);
    }
    return (this.#logs.get(sessionId) ?? []).slice(fromSeq);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
