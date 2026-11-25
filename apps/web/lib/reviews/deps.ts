import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { log } from "../auth";
import { MODE } from "../auth/config";
import { sealSessionsViaEdge } from "../auth/edge";
import { withViewerTenant } from "../auth/viewer";
import { getDb } from "../db";
import type { CorrectionRouteDeps } from "./corrections";
import type { SealRepairDeps } from "./repair";
import type { ReviewRouteDeps } from "./routes";

/** What the review route runs on in this request: the viewer's tenant transaction, the Worker's environment, the log, and the clock. */
export function reviewRouteDeps(): ReviewRouteDeps {
  return {
    withViewerTenant,
    env: getCloudflareContext().env,
    log,
    now: () => new Date(),
    mode: MODE,
  };
}

/** What the inbox loader's repair path runs on: the same, and the edge Worker's `sealSessions`. */
export function sealRepairDeps(): SealRepairDeps {
  return { withViewerTenant, sealSessions: sealSessionsViaEdge(log), now: () => new Date(), log };
}

/**
 * What the correction route runs on in this request: its database pool (for the rate limit), the
 * viewer's tenant transaction on the same pool, the log, the clock, and whether limits count.
 */
export async function correctionRouteDeps(): Promise<CorrectionRouteDeps> {
  return {
    db: await getDb(),
    withViewerTenant,
    log,
    now: () => new Date(),
    rateLimit: MODE === "production",
  };
}
