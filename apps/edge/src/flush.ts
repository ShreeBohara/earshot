// The flush consumer (Phase 3 spec WP7 step 2): applies SessionDO's Queue messages to Postgres,
// one message at a time, each in one tenant transaction:
//
//   withTenant(userId, workspaceId) → appendEvents(tx, sessionId, fromSeq - 1, events)
//                                   → rebuildProjections(tx, sessionId)
//                                   → recordReviewAudit(tx, signer, appended, "flush")
//   then confirmFlushed(toSeq) on the session's Durable Object, then ack.
//
// From Phase 5 (WP3, docs/adr/0033) the review events an append writes get their audit rows, in the
// session's user's name, and one signed checkpoint (`request: "flush"`), in the append's own
// transaction and after the rebuild, so the workspace's audit lock is held only for those inserts.
// Only events this delivery appends get rows: a redelivery that finds its events stored writes
// none. Without a usable EARSHOT_AUDIT_SIGNING_KEY a message carrying reviews fails closed: it's
// retried, and nothing of it is stored, until the key is fixed.
//
// Queues deliver at least once and in no particular order, so every message can arrive twice, or
// before the one it follows. `expectedLastSeq` travels in the message (as `fromSeq - 1`), and the
// store's `ConcurrencyError` says which case this is:
//
// | Outcome                          | What the consumer does                                       |
// |----------------------------------|--------------------------------------------------------------|
// | stale, and the stored ids match  | An earlier delivery committed and only its ack was lost: ack |
// | stale, the stored ids a prefix   | Append the rest                                              |
// | stale, the stored ids differ     | A second writer: log an alert, retry until the DLQ           |
// | gap                              | Read the missing range from the DO, append it and this batch |
// | UnknownSessionError              | Retry with a delay, then the DLQ (the web app writes the row first) |
// | reviews, and no signing key      | Retry with a delay, then the DLQ (SessionDO resends later)   |
// | the batch is refused (replay)    | A bug in the batch: straight to the DLQ, no retry            |
//
// Pure TypeScript: no Workers globals, so the Node tests run this exact code against PGlite, and
// the workerd tests run it against a fake store.
import {
  AuditUnavailableError,
  appendEvents,
  readEvents,
  rebuildProjections,
  recordReviewAudit,
  withTenant,
} from "@earshot/db";
import {
  ConcurrencyError,
  EventValidationError,
  ProjectionError,
  StreamError,
  UnknownEventError,
  UpcastError,
} from "@earshot/events";
import type { AuditSigner } from "@earshot/keys/server";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { type FlushEvent, FlushMessage } from "./flush-message";
import type { Logger } from "./log";

/** A Queue message, as the consumer handles it: `Message` in Workers, a fake in Node tests. */
export interface QueueMessageLike {
  readonly id: string;
  readonly body: unknown;
  /** Deliveries so far, this one included. */
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** Whose transaction a message runs in: the session's own user, under row-level security. */
export interface Tenant {
  readonly userId: string;
  readonly workspaceId: string;
}

/** What the consumer asks of a session's Durable Object. */
export interface SessionRpc {
  readRange(fromSeq: number, toSeq: number): Promise<readonly FlushEvent[]>;
  confirmFlushed(seq: number): Promise<void>;
}

/** Postgres, as the consumer uses it. `postgresFlushStore` is the real one. */
export interface FlushStore {
  /**
   * `appendEvents`, then `rebuildProjections`, then the audit rows and checkpoint for the review
   * events it appended, in one `withTenant` transaction. Throws `AuditUnavailableError`, storing
   * nothing, for review events with no signer.
   */
  append(
    tenant: Tenant,
    sessionId: string,
    expectedLastSeq: number,
    events: readonly FlushEvent[],
  ): Promise<void>;
  /** The ids of the session's events from `fromSeq` on, in seq order. */
  storedIds(tenant: Tenant, sessionId: string, fromSeq: number): Promise<readonly string[]>;
}

export interface FlushDeps {
  readonly store: FlushStore;
  readonly session: (sessionId: string) => SessionRpc;
  /** Sends a message's body to the dead-letter queue, for a batch that must never be retried. */
  readonly deadLetter: (body: unknown) => Promise<void>;
  readonly log: Logger;
}

/**
 * The store on any Postgres Drizzle database that runs interactive transactions. `signer` signs
 * the checkpoint for review events: the edge Worker's EARSHOT_AUDIT_SIGNING_KEY, or null when it
 * has no usable one, and then every message carrying reviews fails closed.
 */
export function postgresFlushStore<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TQueryResult, TFullSchema, TSchema>,
  options: { readonly signer: AuditSigner | null; readonly now?: () => Date },
): FlushStore {
  return {
    append: (tenant, sessionId, expectedLastSeq, events) =>
      withTenant(db, tenant, async (tx) => {
        const appended = await appendEvents(tx, sessionId, expectedLastSeq, events);
        // Same transaction: the projections never lag the log.
        await rebuildProjections(tx, sessionId);
        // Last, after the session's lock and the rebuild: the audit lock lasts until commit.
        await recordReviewAudit(tx, options.signer, appended, "flush", options.now?.());
      }),
    storedIds: (tenant, sessionId, fromSeq) =>
      withTenant(db, tenant, async (tx) =>
        (await readEvents(tx, sessionId, fromSeq)).map((event) => event.id),
      ),
  };
}

/** The longest a retry waits, and the first wait; it doubles each delivery. */
const MAX_RETRY_DELAY_SECONDS = 300;
const FIRST_RETRY_DELAY_SECONDS = 10;

/** The wait before a message's next delivery: 10 s, then 20, 40, 80, 160, at most 300. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(
    MAX_RETRY_DELAY_SECONDS,
    FIRST_RETRY_DELAY_SECONDS * 2 ** Math.max(0, attempts - 1),
  );
}

type Outcome =
  | { readonly kind: "ack" }
  | { readonly kind: "retry"; readonly reason: string; readonly delaySeconds: number }
  | { readonly kind: "dead_letter"; readonly reason: string };

/** Two writers disagree about the session's log: not something a retry fixes. */
class FlushConflictError extends Error {
  override readonly name = "FlushConflictError";
}

/** The Durable Object couldn't supply a range the consumer needed. */
class RangeUnavailableError extends Error {
  override readonly name = "RangeUnavailableError";
}

/** Errors that mean the batch itself is wrong (ADR-0020): retrying it would fail the same way. */
function isRefusedBatch(error: unknown): boolean {
  return (
    error instanceof ProjectionError ||
    error instanceof StreamError ||
    error instanceof UnknownEventError ||
    error instanceof EventValidationError ||
    error instanceof UpcastError
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** True if `events` are exactly `fromSeq..toSeq`, in order. */
function covers(events: readonly FlushEvent[], fromSeq: number, toSeq: number): boolean {
  return (
    events.length === toSeq - fromSeq + 1 &&
    events.every((event, index) => event.seq === fromSeq + index)
  );
}

/**
 * Applies a batch, acking or retrying each message on its own: one session's failure never holds
 * back another's. Messages are applied in session and seq order, so ranges of one session that
 * arrive together out of order need no repair.
 */
export async function flushBatch(
  batch: { readonly messages: readonly QueueMessageLike[] },
  deps: FlushDeps,
): Promise<void> {
  const ordered = [...batch.messages].sort((a, b) => {
    const left = sortKey(a.body);
    const right = sortKey(b.body);
    return left.sessionId === right.sessionId
      ? left.fromSeq - right.fromSeq
      : left.sessionId < right.sessionId
        ? -1
        : 1;
  });
  for (const message of ordered) {
    let outcome: Outcome;
    try {
      outcome = await flushMessage(message, deps);
    } catch (error) {
      deps.log.error("flush failed", { cause: errorName(error) });
      outcome = {
        kind: "retry",
        reason: "unexpected",
        delaySeconds: retryDelaySeconds(message.attempts),
      };
    }
    await settle(message, outcome, deps);
  }
}

function sortKey(body: unknown): { sessionId: string; fromSeq: number } {
  const value = body as { sessionId?: unknown; fromSeq?: unknown } | null;
  return {
    sessionId: typeof value?.sessionId === "string" ? value.sessionId : "",
    fromSeq: typeof value?.fromSeq === "number" ? value.fromSeq : 0,
  };
}

async function settle(message: QueueMessageLike, outcome: Outcome, deps: FlushDeps): Promise<void> {
  switch (outcome.kind) {
    case "ack":
      message.ack();
      return;
    case "retry":
      deps.log.warn("flush retry", {
        reason: outcome.reason,
        attempts: message.attempts,
        delaySeconds: outcome.delaySeconds,
      });
      message.retry({ delaySeconds: outcome.delaySeconds });
      return;
    case "dead_letter":
      try {
        await deps.deadLetter(message.body);
      } catch (error) {
        // The DLQ is unreachable: retry, and the queue's own max_retries sends it there later.
        deps.log.error("flush dead-letter failed", { cause: errorName(error) });
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        return;
      }
      deps.log.error("flush dead-lettered", { reason: outcome.reason, queueMessage: message.id });
      message.ack();
  }
}

async function flushMessage(message: QueueMessageLike, deps: FlushDeps): Promise<Outcome> {
  const parsed = FlushMessage.safeParse(message.body);
  if (!parsed.success) return { kind: "dead_letter", reason: "bad_message" };
  const flush = parsed.data;
  const tenant: Tenant = { userId: flush.userId, workspaceId: flush.workspaceId };
  const session = deps.session(flush.sessionId);
  const retry = (reason: string): Outcome => ({
    kind: "retry",
    reason,
    delaySeconds: retryDelaySeconds(message.attempts),
  });

  let events: readonly FlushEvent[] | undefined = flush.events;
  if (!events) {
    // An event too big for a Queue message: SessionDO's copy is the source.
    try {
      events = await session.readRange(flush.fromSeq, flush.toSeq);
    } catch {
      return retry("session_unreachable");
    }
    if (!covers(events, flush.fromSeq, flush.toSeq)) return retry("range_unavailable");
  }

  try {
    await appendWithRepair(deps.store, session, tenant, flush.sessionId, flush.fromSeq, events);
  } catch (error) {
    if (error instanceof FlushConflictError) {
      // Another writer's events sit where this session's should. Don't ack: after max_retries the
      // message lands in the DLQ, and this line is the alert.
      deps.log.error("flush conflict", { sessionId: flush.sessionId, fromSeq: flush.fromSeq });
      return retry("conflict");
    }
    if (isRefusedBatch(error)) return { kind: "dead_letter", reason: errorName(error) };
    if (error instanceof AuditUnavailableError) {
      // Fail closed: the reviews wait in SessionDO until the edge Worker has a usable key.
      deps.log.error("flush refused: reviews need an audit checkpoint and no signing key works", {
        sessionId: flush.sessionId,
        fromSeq: flush.fromSeq,
      });
      return retry("audit_unavailable");
    }
    if (error instanceof RangeUnavailableError) return retry("range_unavailable");
    if (errorName(error) === "UnknownSessionError") return retry("unknown_session");
    if (error instanceof ConcurrencyError) return retry(`concurrency_${error.reason}`);
    return retry(`store:${errorName(error)}`);
  }

  try {
    await session.confirmFlushed(flush.toSeq);
  } catch {
    // Postgres has the events; the DO just doesn't know yet. The next delivery finds them stored
    // (stale, ids match) and confirms again.
    return retry("confirm_failed");
  }
  return { kind: "ack" };
}

/**
 * Appends `events` (seq `fromSeq` onward) after `fromSeq - 1`, repairing a stale or gapped log as
 * the table above says. Returns once Postgres holds every event in the batch.
 */
async function appendWithRepair(
  store: FlushStore,
  session: SessionRpc,
  tenant: Tenant,
  sessionId: string,
  fromSeq: number,
  events: readonly FlushEvent[],
): Promise<void> {
  try {
    await store.append(tenant, sessionId, fromSeq - 1, events);
    return;
  } catch (error) {
    if (!(error instanceof ConcurrencyError)) throw error;
    if (error.reason === "stale") {
      const stored = await store.storedIds(tenant, sessionId, fromSeq);
      const overlap = Math.min(stored.length, events.length);
      for (let index = 0; index < overlap; index++) {
        if (stored[index] !== events[index]?.id) throw new FlushConflictError();
      }
      // Everything is there: an earlier delivery committed, and only its ack was lost.
      if (stored.length >= events.length) return;
      await store.append(
        tenant,
        sessionId,
        fromSeq - 1 + stored.length,
        events.slice(stored.length),
      );
      return;
    }
    // A gap: Postgres's log ends before this batch starts. SessionDO has the missing events.
    const missingFrom = error.actualLastSeq + 1;
    let missing: readonly FlushEvent[];
    try {
      missing = await session.readRange(missingFrom, fromSeq - 1);
    } catch {
      throw new RangeUnavailableError();
    }
    if (!covers(missing, missingFrom, fromSeq - 1)) throw new RangeUnavailableError();
    await store.append(tenant, sessionId, error.actualLastSeq, [...missing, ...events]);
  }
}
