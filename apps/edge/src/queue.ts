// The Workers side of the flush (spec WP7): the producer sink SessionDO sends through, the Queue
// consumer's glue around `flushBatch`, and the purge fan-out for deletion.
import { createPoolDb } from "@earshot/db";
import type { AuditSigner } from "@earshot/keys/server";
import { auditSecrets, readAuditSigning } from "./config";
import { type FlushStore, flushBatch, postgresFlushStore, type SessionRpc } from "./flush";
import { type FlushMessage, type FlushSink, parseRange, sendBatches } from "./flush-message";
import { createLogger } from "./log";
import type { SealAnswer } from "./session-do";

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
 * acks each batch and logs that the flush was skipped: the events stay in SessionDO. The audit
 * signing key signs each flush's checkpoint for its review events; without a usable one, messages
 * carrying reviews are retried, never stored without their audit rows (src/config.ts).
 */
export async function handleFlushQueue(
  batch: MessageBatch,
  env: Env,
  ctx: ExecutionContext,
  options: {
    /** Seams for the workerd tests: a fake Postgres, and fake session RPCs. */
    readonly store?: (
      url: string,
      signer: AuditSigner | null,
    ) => { store: FlushStore; close(): Promise<void> };
    readonly session?: (sessionId: string) => SessionRpc;
  } = {},
): Promise<void> {
  const url = env.DATABASE_URL?.trim();
  const log = createLogger([...(url ? [url] : []), ...auditSecrets(env)]);
  if (!url) {
    log.info("flush skipped", { messages: batch.messages.length, reason: "no_database_url" });
    batch.ackAll();
    return;
  }
  const signing = await readAuditSigning(env);
  if (signing.status === "missing" || signing.status === "invalid") {
    // Fixed text naming the variable; each message carrying reviews says so again as it's retried.
    log.warn("flush can't sign audit checkpoints", { signingKey: signing.status });
  }
  const signer =
    signing.status === "configured" || signing.status === "development" ? signing.signer : null;
  const opened = options.store?.(url, signer) ?? openPostgres(url, signer);
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

function openPostgres(
  url: string,
  signer: AuditSigner | null,
): { store: FlushStore; close(): Promise<void> } {
  const db = createPoolDb(url);
  return { store: postgresFlushStore(db, { signer }), close: () => db.$client.end() };
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The most sessions one `purgeSessions` or `sealSessions` call takes. */
export const MAX_PURGE_SESSIONS = 500;
export const MAX_SEAL_SESSIONS = 500;
/** How many Durable Objects are purged, or asked to seal, at once. */
const PURGE_CONCURRENCY = 10;

/** Why a fan-out RPC refused its argument, answered rather than thrown. */
type IdsRefusal = { readonly ok: false; readonly reason: "too_many" | "invalid_session_id" };

/** The distinct session ids, or why the list is refused: too long, or not lowercase UUIDs. */
function sessionIdsOf(sessionIds: readonly string[], max: number): string[] | IdsRefusal {
  if (!Array.isArray(sessionIds) || sessionIds.length > max) {
    return { ok: false, reason: "too_many" };
  }
  const ids = [...new Set(sessionIds)];
  if (!ids.every((id) => typeof id === "string" && SESSION_ID.test(id))) {
    return { ok: false, reason: "invalid_session_id" };
  }
  return ids;
}

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
  const ids = sessionIdsOf(sessionIds, MAX_PURGE_SESSIONS);
  if (!Array.isArray(ids)) return ids;
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

/** What each session's Durable Object answered `sealNow()` with (see `SealAnswer`). */
export type SealResult =
  | { readonly ok: true; readonly sessions: Readonly<Record<string, SealAnswer>> }
  | IdsRefusal;

/**
 * Asks the sessions' Durable Objects to seal now (Phase 5 spec §4.3, the repair path): the web
 * app's inbox loader calls this through its `EDGE` service binding, with at most 500 lowercase
 * session UUIDs, for sessions that ended a while ago and still have no seal in Postgres. Each
 * object answers `live` (still capturing, left alone), `sealing` (sealed by this call; the seal
 * reaches Postgres with its flush), `sealed` (sealed before), or `gone` (it holds no log, so the
 * web Worker may seal Postgres's copy itself). Only bound Workers can call it; a bad argument is
 * answered, not thrown.
 */
export async function sealSessions(env: Env, sessionIds: readonly string[]): Promise<SealResult> {
  const ids = sessionIdsOf(sessionIds, MAX_SEAL_SESSIONS);
  if (!Array.isArray(ids)) return ids;
  const answers: Record<string, SealAnswer> = {};
  for (let start = 0; start < ids.length; start += PURGE_CONCURRENCY) {
    await Promise.all(
      ids.slice(start, start + PURGE_CONCURRENCY).map(async (id) => {
        answers[id] = await env.SESSION.get(env.SESSION.idFromName(id)).sealNow();
      }),
    );
  }
  const counts: Record<SealAnswer, number> = { live: 0, sealing: 0, sealed: 0, gone: 0 };
  for (const answer of Object.values(answers)) counts[answer] += 1;
  createLogger().info("sessions asked to seal", counts);
  return { ok: true, sessions: answers };
}
