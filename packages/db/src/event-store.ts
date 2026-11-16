import {
  ConcurrencyError,
  checkExpectedLastSeq,
  checkFromSeq,
  type EventDraft,
  type EventEnvelope,
  type EventRegistry,
  type EventStore,
  EventValidationError,
  NO_EVENTS,
  prepareAppend,
  StreamError,
} from "@earshot/events";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  type SQL,
  sql,
  type TablesRelationalConfig,
} from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { sessionEvents, sessions } from "./schema";
import { type TenantContext, withTenant } from "./tenant";

/**
 * A transaction that `withTenant` pinned to one workspace, on any Postgres driver that runs
 * interactive transactions: `createPoolDb` in production, PGlite in tests.
 */
export type TenantTransaction<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
  TFullSchema extends Record<string, unknown> = Record<string, unknown>,
  TSchema extends TablesRelationalConfig = TablesRelationalConfig,
> = PgTransaction<TQueryResult, TFullSchema, TSchema>;

export interface PgEventStoreOptions {
  /** The registry events are validated against before they're written. Defaults to Earshot's. */
  registry?: EventRegistry;
}

/**
 * The session isn't in the current workspace: it doesn't exist, or another workspace owns it,
 * which row-level security makes indistinguishable. A session's `sessions` row must exist before
 * the session takes events.
 */
export class UnknownSessionError extends Error {
  override readonly name = "UnknownSessionError";
  readonly sessionId: string;

  constructor(sessionId: string, options?: ErrorOptions) {
    super(`session ${sessionId} isn't in this workspace`, options);
    this.sessionId = sessionId;
  }
}

/**
 * The `EventStore` on Postgres: `session_events` under row-level security (docs/adr/0020). Each
 * `append` and `read` runs in its own `withTenant` transaction for `tenant`. It passes the same
 * contract tests as `InMemoryEventStore`, and differs only where Postgres must: a session needs
 * its `sessions` row before it takes events (else `UnknownSessionError`), and the store refuses
 * what Postgres would store differently from how it was written, namely ids with uppercase hex,
 * a `ts` in year 0000, and payload strings that contain U+0000 or an unpaired surrogate.
 *
 * To append and do more in one transaction, call `appendEvents` and `readEvents` inside your own
 * `withTenant` instead.
 */
export class PgEventStore<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> implements EventStore
{
  readonly #db: PgDatabase<TQueryResult, TFullSchema, TSchema>;
  readonly #tenant: TenantContext;
  readonly #registry: EventRegistry | undefined;

  constructor(
    db: PgDatabase<TQueryResult, TFullSchema, TSchema>,
    tenant: TenantContext,
    options: PgEventStoreOptions = {},
  ) {
    this.#db = db;
    this.#tenant = Object.freeze({ ...tenant });
    this.#registry = options.registry;
  }

  async append(
    sessionId: string,
    expectedLastSeq: number,
    events: readonly EventDraft[],
  ): Promise<readonly EventEnvelope[]> {
    checkExpectedLastSeq(expectedLastSeq);
    return withTenant(this.#db, this.#tenant, (tx) =>
      appendEvents(tx, sessionId, expectedLastSeq, events, { registry: this.#registry }),
    );
  }

  async read(sessionId: string, fromSeq = 0): Promise<readonly EventEnvelope[]> {
    checkFromSeq(fromSeq);
    return withTenant(this.#db, this.#tenant, (tx) => readEvents(tx, sessionId, fromSeq));
  }
}

/**
 * `EventStore.append` inside a transaction from `withTenant`, so the caller can do more in the
 * same transaction, such as rebuilding projections. It locks the session (`lockSession`), reads the
 * session's last seq, runs the checks `InMemoryEventStore` runs (`prepareAppend`), and inserts
 * the batch into the transaction's workspace. The lock lasts until the transaction ends.
 *
 * Errors match `InMemoryEventStore`'s. In addition, a non-empty batch for a session that has no
 * `sessions` row in the workspace gives `UnknownSessionError`, raised before the insert so that
 * no unique key can hint at another workspace's events. Writers that bypass the lock can still
 * race; the unique keys catch them, and a clash on `(session_id, seq)` becomes a stale
 * `ConcurrencyError`, one on `(session_id, id)` a `StreamError`. If the insert itself fails,
 * Postgres has aborted the transaction, so let it roll back.
 */
export async function appendEvents<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: PgTransaction<TQueryResult, TFullSchema, TSchema>,
  sessionId: string,
  expectedLastSeq: number,
  events: readonly EventDraft[],
  options: PgEventStoreOptions = {},
): Promise<readonly EventEnvelope[]> {
  checkExpectedLastSeq(expectedLastSeq);
  // A session id that Postgres wouldn't return as given can't have rows: its log is empty, and
  // prepareAppend or checkStorable refuses any event for it.
  const stored = isStoredUuid(sessionId);
  if (stored) await lockSession(tx, sessionId);
  const lastSeq = stored ? await lastSeqInWorkspace(tx, sessionId) : undefined;
  const actualLastSeq = lastSeq ?? NO_EVENTS;
  const existingIds =
    lastSeq !== undefined && lastSeq === expectedLastSeq
      ? await idsInSession(tx, sessionId, events)
      : new Set<string>();

  const prepared = prepareAppend({
    sessionId,
    expectedLastSeq,
    actualLastSeq,
    events,
    existingIds,
    registry: options.registry,
  });
  prepared.forEach(checkStorable);
  if (prepared.length === 0) return prepared;
  // Not left to the foreign key: the primary key is checked first, and its clash with another
  // workspace's event at the same seq would tell this tenant that the session exists.
  if (lastSeq === undefined) throw new UnknownSessionError(sessionId);

  try {
    await tx.insert(sessionEvents).values(prepared.map(toRow));
  } catch (error) {
    throw mapAppendError(error, sessionId, expectedLastSeq);
  }
  return prepared;
}

/**
 * `EventStore.read` inside a transaction from `withTenant`: the session's events in seq order
 * from `fromSeq`, exactly as they were appended. Row-level security limits it to the
 * transaction's workspace, so another workspace's session reads as empty, like an unknown one.
 */
export async function readEvents<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: PgTransaction<TQueryResult, TFullSchema, TSchema>,
  sessionId: string,
  fromSeq = 0,
): Promise<readonly EventEnvelope[]> {
  checkFromSeq(fromSeq);
  if (!isStoredUuid(sessionId) || fromSeq > MAX_SEQ) return [];
  const rows = await tx
    .select({
      id: sessionEvents.id,
      sessionId: sessionEvents.sessionId,
      seq: sessionEvents.seq,
      type: sessionEvents.type,
      schemaVersion: sessionEvents.schemaVersion,
      ts: writtenTs,
      payload: sessionEvents.payload,
    })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, sessionId), gte(sessionEvents.seq, fromSeq)))
    .orderBy(asc(sessionEvents.seq));
  return rows.map(deepFreeze);
}

/**
 * Takes a transaction-scoped advisory lock on the session. Appends and projection rebuilds of
 * one session then run one at a time, and each reads the log only after the previous one has
 * committed, so checking `expectedLastSeq` and inserting act as one step, as they do in memory.
 * Locks of different sessions don't conflict. Any role may take advisory locks.
 */
export async function lockSession(tx: TenantTransaction, sessionId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`earshot.session:${sessionId}`}, 0))`,
  );
}

/** The workspace `withTenant` pinned the transaction to; null outside one, which fails closed. */
export const currentWorkspace: SQL = sql`nullif(current_setting('app.workspace_id', true), '')::uuid`;

/** A timestamp string parsed by Postgres, which keeps microseconds that a JS Date drops. */
export function timestamptz(text: string): SQL {
  return sql`${text}::timestamptz`;
}

/** Whether a uuid column would return `id` as given: a UUID in lowercase hex. */
export function isStoredUuid(id: unknown): id is string {
  return typeof id === "string" && STORED_UUID.test(id);
}

const STORED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The form `writtenTs` gives back for a null `ts_text`. */
const CANONICAL_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The largest seq an `integer` column holds. */
const MAX_SEQ = 2_147_483_647;

/** The envelope's `ts` as written: `ts_text` if set, else `ts` in the canonical form. */
const writtenTs = sql<string>`coalesce(${sessionEvents.tsText}, to_char(${sessionEvents.ts} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;

// Constraint names from migrations 0003 and 0005. The tests that force each violation fail if
// one of them changes.
const SEQ_KEY = "session_events_session_id_seq_pk";
const ID_KEY = "session_events_session_id_id_unique";
const SESSION_KEY = "session_events_session_fk";

/**
 * The session's last seq (`NO_EVENTS` for an empty log), or `undefined` when the session isn't
 * in the transaction's workspace. Row-level security filters both tables, and a session's events
 * share its workspace, so another workspace's session looks like no session at all.
 */
export async function lastSeqInWorkspace(
  tx: TenantTransaction,
  sessionId: string,
): Promise<number | undefined> {
  // Drizzle leaves columns unqualified in a one-table select, so the subquery takes the id as
  // a parameter rather than correlating with sessions.id.
  const [session] = await tx
    .select({
      lastSeq: sql<number | null>`(select max(${sessionEvents.seq}) from ${sessionEvents}
        where ${sessionEvents.sessionId} = ${sessionId})`,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return session === undefined ? undefined : (session.lastSeq ?? NO_EVENTS);
}

/** Which of the batch's ids the session already has. */
async function idsInSession(
  tx: TenantTransaction,
  sessionId: string,
  events: readonly EventDraft[],
): Promise<Set<string>> {
  const ids = [...new Set(events.map((event) => event.id).filter(isStoredUuid))];
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: sessionEvents.id })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, sessionId), inArray(sessionEvents.id, ids)));
  return new Set(rows.map((row) => row.id));
}

type Issue = ConstructorParameters<typeof EventValidationError>[1][number];

/**
 * Refuses what Postgres would store differently from how it was written, after `prepareAppend`
 * has passed the event, so that any batch `InMemoryEventStore` refuses fails here the same way.
 */
function checkStorable(event: EventEnvelope, index: number): void {
  const issues: Issue[] = [];
  for (const key of ["id", "sessionId"] as const) {
    if (!isStoredUuid(event[key])) {
      issues.push({
        code: "custom",
        path: [key],
        message: "must be lowercase, the only form Postgres returns",
        input: event[key],
      });
    }
  }
  if (event.ts.startsWith("0000-")) {
    issues.push({
      code: "custom",
      path: ["ts"],
      message: "year 0000 is outside Postgres's calendar",
      input: event.ts,
    });
  }
  if (issues.length > 0) {
    throw new EventValidationError(`event ${index} of the batch: invalid event envelope`, issues);
  }

  const problem = findJsonbProblem(event.payload);
  if (problem) {
    throw new EventValidationError(
      `${event.type} v${event.schemaVersion} at seq ${event.seq}: invalid payload`,
      [{ code: "custom", path: problem.path, message: problem.message }],
    );
  }
}

/** The first string in `value`, key or value, that jsonb can't store, and where it is. */
function findJsonbProblem(
  value: unknown,
  path: (string | number)[] = [],
): { path: (string | number)[]; message: string } | undefined {
  if (typeof value === "string") {
    const message = jsonbProblem(value);
    return message ? { path, message } : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findJsonbProblem(item, [...path, index]);
      if (found) return found;
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const keyProblem = jsonbProblem(key);
      if (keyProblem) return { path: [...path, key], message: `the key ${keyProblem}` };
      const found = findJsonbProblem(item, [...path, key]);
      if (found) return found;
    }
  }
  return undefined;
}

function jsonbProblem(text: string): string | undefined {
  if (text.includes("\u0000")) return "contains U+0000, which jsonb can't store";
  if (/\p{Cs}/u.test(text)) return "contains an unpaired surrogate, which jsonb can't store";
  return undefined;
}

function toRow(event: EventEnvelope) {
  return {
    id: event.id,
    workspaceId: currentWorkspace,
    sessionId: event.sessionId,
    seq: event.seq,
    type: event.type,
    schemaVersion: event.schemaVersion,
    payload: event.payload,
    ts: timestamptz(event.ts),
    tsText: CANONICAL_TS.test(event.ts) ? null : event.ts,
  };
}

/** Turns a constraint violation from the insert into the error the store promises. */
function mapAppendError(error: unknown, sessionId: string, expectedLastSeq: number): unknown {
  const violation = postgresError(error);
  if (violation?.code === "23505" && violation.constraint === SEQ_KEY) {
    // A writer that skipped the lock committed first. The log has reached at least our first
    // seq, and the transaction is aborted, so it can't be read again here.
    const taken = expectedLastSeq + 1;
    const conflict = new ConcurrencyError(
      sessionId,
      expectedLastSeq,
      taken,
      "stale",
      `session ${sessionId}: another writer appended seq ${taken} first (stale)`,
    );
    conflict.cause = error;
    return conflict;
  }
  if (violation?.code === "23505" && violation.constraint === ID_KEY) {
    return new StreamError(`an event id in the batch is already in session ${sessionId}`, {
      cause: error,
    });
  }
  if (violation?.code === "23503" && violation.constraint === SESSION_KEY) {
    return new UnknownSessionError(sessionId, { cause: error });
  }
  return error;
}

/** The driver's Postgres error behind `error`: Drizzle wraps it as the cause. */
function postgresError(error: unknown): { code: string; constraint?: string } | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Object; depth++) {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      return { code, constraint: typeof constraint === "string" ? constraint : undefined };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
