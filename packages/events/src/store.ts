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

/** Throws a `RangeError` unless `expectedLastSeq` is an integer >= `NO_EVENTS`. */
export function checkExpectedLastSeq(expectedLastSeq: number): void {
  if (!Number.isInteger(expectedLastSeq) || expectedLastSeq < NO_EVENTS) {
    throw new RangeError(
      `expectedLastSeq must be an integer >= ${NO_EVENTS}, got ${expectedLastSeq}`,
    );
  }
}

/** Throws a `RangeError` unless `fromSeq` is a non-negative integer. */
export function checkFromSeq(fromSeq: number): void {
  if (!Number.isInteger(fromSeq) || fromSeq < 0) {
    throw new RangeError(`fromSeq must be a non-negative integer, got ${fromSeq}`);
  }
}

/** A batch for `prepareAppend`, and what the store knows about the session's log. */
export interface AppendBatch {
  sessionId: string;
  expectedLastSeq: number;
  /** The seq of the last event in the log, or `NO_EVENTS` when the log is empty. */
  actualLastSeq: number;
  events: readonly EventDraft[];
  /** Ids already in the log. Only ids that appear in `events` need to be in it. */
  existingIds: ReadonlySet<string>;
  registry?: EventRegistry;
}

/**
 * The checks `append` makes, shared by every store so that they refuse the same batches with the
 * same errors, in the same order. First the log must end at `expectedLastSeq`
 * (`ConcurrencyError`). Then, event by event: a writer-chosen `seq` must be the next one
 * (`ConcurrencyError`), the envelope and the payload must be valid (`EventValidationError`,
 * `UnknownEventError`), and the id must not be in the session yet (`StreamError`). Returns the
 * events to store, numbered from `actualLastSeq + 1`, as frozen copies. It has no side effects,
 * so a store writes all of the result or nothing.
 */
export function prepareAppend(batch: AppendBatch): readonly EventEnvelope[] {
  const { sessionId, expectedLastSeq, actualLastSeq, events } = batch;
  const registry = batch.registry ?? defaultRegistry;
  if (expectedLastSeq !== actualLastSeq) {
    const reason = expectedLastSeq < actualLastSeq ? "stale" : "gap";
    throw new ConcurrencyError(sessionId, expectedLastSeq, actualLastSeq, reason);
  }

  const ids = new Set(batch.existingIds);
  return events.map((draft, index) => {
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
    registry.validate(event);
    if (ids.has(event.id)) {
      throw new StreamError(`event id ${event.id} is already in session ${sessionId}`);
    }
    ids.add(event.id);
    return deepFreeze(structuredClone(event));
  });
}

/**
 * An `EventStore` in memory, for tests, the replay demo, and local sessions. Stored events are
 * frozen copies, so neither the writer nor a reader can change the log after the fact. It is the
 * reference implementation: `describeEventStoreContract` in `@earshot/events/testing` holds every
 * store to its behavior.
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
    checkExpectedLastSeq(expectedLastSeq);
    // Everything below runs synchronously, so concurrent appends can't interleave.
    const log = this.#logs.get(sessionId) ?? [];
    const stored = prepareAppend({
      sessionId,
      expectedLastSeq,
      actualLastSeq: log.length - 1,
      events,
      existingIds: new Set(log.map((event) => event.id)),
      registry: this.#registry,
    });
    this.#logs.set(sessionId, [...log, ...stored]);
    return stored;
  }

  async read(sessionId: string, fromSeq = 0): Promise<readonly EventEnvelope[]> {
    checkFromSeq(fromSeq);
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
