// The Workers side of the flush (spec WP7): the producer sink SessionDO sends through, the Queue
// consumer's glue around `flushBatch`, and the purge fan-out for deletion.
import { createPoolDb } from "@earshot/db";
import { type FlushStore, flushBatch, postgresFlushStore, type SessionRpc } from "./flush";
import { type FlushMessage, type FlushSink, parseRange, sendBatches } from "./flush-message";
import { createLogger } from "./log";

/** SessionDO's sink in production: the `FLUSH` producer, as JSON, within `sendBatch`'s limits. */
export function queueSink(queue: Queue<FlushMessage>): FlushSink {
  return {
    async send(messages) {
      for (const chunk of sendBatches(messages)) {
        await queue.sendBatch(chunk.map((body) => ({ body, contentType: "json" as const })));
      }
    },
  };
}

/** The consumer's view of a session's Durable Object. */
export function sessionRpc(env: Env, sessionId: string): SessionRpc {
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  return {
    readRange: async (fromSeq, toSeq) => parseRange(await stub.readRange(fromSeq, toSeq)),
    confirmFlushed: async (seq) => {
      await stub.confirmFlushed(seq);
    },
  };
}

/**
 * The `queue()` handler for `earshot-flush` (and each preview's `earshot-flush-pr-N`). One pool
 * per batch, closed after it (docs/adr/0018). With no `DATABASE_URL` (zero-setup development) it
 * acks each batch and logs that the flush was skipped: the events stay in SessionDO.
 */
export async function handleFlushQueue(
  batch: MessageBatch,
  env: Env,
  ctx: ExecutionContext,
  options: {
    /** Seams for the workerd tests: a fake Postgres, and fake session RPCs. */
    readonly store?: (url: string) => { store: FlushStore; close(): Promise<void> };
    readonly session?: (sessionId: string) => SessionRpc;
  } = {},
): Promise<void> {
  const url = env.DATABASE_URL?.trim();
  const log = createLogger(url ? [url] : []);
  if (!url) {
    log.info("flush skipped", { messages: batch.messages.length, reason: "no_database_url" });
    batch.ackAll();
    return;
  }
  const opened = options.store?.(url) ?? openPostgres(url);
  try {
    await flushBatch(batch, {
      store: opened.store,
      session: options.session ?? ((sessionId) => sessionRpc(env, sessionId)),
      deadLetter: async (body) => {
        await env.FLUSH_DLQ.send(body, { contentType: "json" });
      },
      log,
    });
  } finally {
    ctx.waitUntil(opened.close());
  }
}

function openPostgres(url: string): { store: FlushStore; close(): Promise<void> } {
  const db = createPoolDb(url);
  return { store: postgresFlushStore(db), close: () => db.$client.end() };
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The most sessions one `purgeSessions` call takes. */
export const MAX_PURGE_SESSIONS = 500;
/** How many Durable Objects are purged at once. */
const PURGE_CONCURRENCY = 10;

export type PurgeResult =
  | { readonly ok: true; readonly purged: number }
  | { readonly ok: false; readonly reason: "too_many" | "invalid_session_id" };

/**
 * Purges the Durable Objects of the given sessions (spec decision 16): the web app calls this
 * through its `EDGE` service binding, after checking the sessions are the user's, when it deletes
 * a session or an account. Only bound Workers can call it; it isn't reachable over HTTP. A bad
 * argument is answered, not thrown, so nothing is purged and the caller can tell why.
 */
export async function purgeSessions(env: Env, sessionIds: readonly string[]): Promise<PurgeResult> {
  if (!Array.isArray(sessionIds) || sessionIds.length > MAX_PURGE_SESSIONS) {
    return { ok: false, reason: "too_many" };
  }
  const ids = [...new Set(sessionIds)];
  if (!ids.every((id) => typeof id === "string" && SESSION_ID.test(id))) {
    return { ok: false, reason: "invalid_session_id" };
  }
  for (let start = 0; start < ids.length; start += PURGE_CONCURRENCY) {
    await Promise.all(
      ids
        .slice(start, start + PURGE_CONCURRENCY)
        .map((id) => env.SESSION.get(env.SESSION.idFromName(id)).purge()),
    );
  }
  createLogger().info("sessions purged", { count: ids.length });
  return { ok: true, purged: ids.length };
}
