// Reading the inbox for a request (Phase 5 spec WP5 steps 1 and 10): the repair path first, so a
// debrief whose seal never came is sealed before it's read (lib/reviews/repair.ts; at most 20 a
// load, and never more than a few seconds of waiting on the edge Worker), then the loader, in the
// viewer's tenant transaction. The page and `GET /api/inbox` share it.
import "server-only";
import { withViewerTenant } from "../auth/viewer";
import type { Viewer } from "../auth/viewer-core";
import { sealRepairDeps } from "../reviews/deps";
import { repairUnsealedSessions, type SealSessions } from "../reviews/repair";
import { loadInbox } from "./load";
import type { InboxData } from "./types";

/** The longest an inbox load waits on the edge Worker's `sealSessions` (target). */
export const SEAL_REPAIR_TIMEOUT_MS = 3_000;

function withTimeout(sealSessions: SealSessions, ms: number): SealSessions {
  return (ids) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the edge Worker took too long")), ms);
      sealSessions(ids).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
}

/**
 * The viewer's inbox: the first page, after the repair path; or, with `before`, the page of older
 * debriefs, which needs no repair (the repair path takes the oldest unsealed debriefs anyway).
 */
export async function readInbox(
  viewer: Viewer,
  options: { readonly before?: string | null } = {},
): Promise<InboxData> {
  if (!options.before) {
    const deps = sealRepairDeps();
    await repairUnsealedSessions(viewer, {
      ...deps,
      sealSessions: withTimeout(deps.sealSessions, SEAL_REPAIR_TIMEOUT_MS),
    });
  }
  const now = new Date();
  return withViewerTenant(
    (tx) =>
      loadInbox(
        tx,
        { userId: viewer.user.id, workspaceId: viewer.workspaceId },
        { now, before: options.before ?? null },
      ),
    viewer,
  );
}
