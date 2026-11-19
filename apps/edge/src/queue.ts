// The Workers side of the flush: the producer sink SessionDO sends through, and the purge fan-out
// for deletion.
import { type FlushMessage, type FlushSink, sendBatches } from "./flush-message";
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
