import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Logger } from "../log";
import type { SealSessions } from "../reviews/repair";
import type { PurgeSessions } from "./server";

/** The part of the edge Worker's RPC surface the web app calls (apps/edge/src/index.ts). */
interface EdgeRpc {
  purgeSessions(
    sessionIds: string[],
  ): Promise<{ ok: true; purged: number } | { ok: false; reason: string }>;
  sealSessions: SealSessions;
}

/** The edge Worker takes at most this many ids per `purgeSessions` call. */
export const PURGE_BATCH_SIZE = 500;

/**
 * Purges sessions' Durable Object storage through the `EDGE` service binding, in batches.
 * Production fails closed: a missing binding or a refused batch throws, which stops an account
 * deletion before anything is deleted. Under `next dev` the binding only works while the edge
 * Worker runs in `wrangler dev`; without it, the purge is skipped with a warning, since local
 * sessions live in that Worker's own local state.
 */
export function purgeSessionsViaEdge(log: Logger): PurgeSessions {
  return async (sessionIds) => {
    if (sessionIds.length === 0) return;
    const development = process.env.NODE_ENV === "development";
    const edge = getCloudflareContext().env.EDGE as unknown as Partial<EdgeRpc> | undefined;
    try {
      if (typeof edge?.purgeSessions !== "function") {
        throw new Error("the EDGE service binding is missing");
      }
      for (let start = 0; start < sessionIds.length; start += PURGE_BATCH_SIZE) {
        const batch = sessionIds.slice(start, start + PURGE_BATCH_SIZE);
        const result = await edge.purgeSessions(batch);
        if (!result.ok) throw new Error(`the edge Worker refused the purge: ${result.reason}`);
      }
    } catch (error) {
      if (!development) throw error;
      log.warn("session storage not purged: the edge Worker isn't running under next dev", {
        sessions: sessionIds.length,
      });
    }
  };
}

/**
 * Asks sessions' Durable Objects to seal now, through the `EDGE` service binding, for the inbox
 * loader's repair path (lib/reviews/repair.ts). Throws when the binding is missing, as under
 * `next dev` without the edge Worker; the repair path then skips this load.
 */
export function sealSessionsViaEdge(_log: Logger): SealSessions {
  return async (sessionIds) => {
    const edge = getCloudflareContext().env.EDGE as unknown as Partial<EdgeRpc> | undefined;
    if (typeof edge?.sealSessions !== "function") {
      throw new Error("the EDGE service binding is missing");
    }
    return edge.sealSessions(sessionIds);
  };
}
