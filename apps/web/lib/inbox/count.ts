// The inbox's count (Phase 5 spec WP6 step 4): how many cards the inbox shows for review, for the
// header's "Inbox" and the home page. One count query in the viewer's `withTenant` transaction,
// never a load of the inbox itself:
//
// - the viewer's own debriefs (another member's are as missing as another workspace's, as in the
//   loader and the review route), sealed in Postgres (an unsealed one is "Finishing");
// - their proposals still `proposed` (decided, superseded, and synced ones aren't), and not snoozed
//   past now.
//
// It counts every such card, where the inbox's first page reads the latest 20 debriefs; "Load
// older" reads the rest, so the two differ only for a rep with more than 20 debriefs open.
//
// Cost: one tenant transaction per server render that asks (`BEGIN`, the role and the two settings
// `withTenant` makes, the count, `COMMIT`: five statements on one pooled connection), on the
// `(workspace_id, status)` index of `proposals` and the primary key of `sessions`. React's `cache`
// shares it between the layout's header and the home page within one render.
import "server-only";
import { schema } from "@earshot/db";
import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { cache } from "react";
import { log } from "../auth";
import { getViewer, type TenantTx, withViewerTenant } from "../auth/viewer";
import type { Viewer } from "../auth/viewer-core";
import { errorSummary, type Logger } from "../log";

/** The cards the inbox would show for review, counted in the viewer's tenant transaction. */
export async function countForReview(
  tx: TenantTx,
  viewer: { readonly userId: string; readonly workspaceId: string },
  now: Date,
): Promise<number> {
  const { proposals, sessions } = schema;
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(proposals)
    .innerJoin(
      sessions,
      and(eq(sessions.workspaceId, proposals.workspaceId), eq(sessions.id, proposals.sessionId)),
    )
    .where(
      and(
        eq(proposals.workspaceId, viewer.workspaceId),
        eq(proposals.status, "proposed"),
        or(isNull(proposals.snoozedUntil), lte(proposals.snoozedUntil, now)),
        eq(sessions.userId, viewer.userId),
        isNotNull(sessions.sealedAt),
      ),
    );
  return Number(row?.count ?? 0);
}

/** The viewer's count, or null when it can't be read (the header then shows "Inbox" alone). */
export async function readReviewCount(viewer: Viewer, logger?: Logger): Promise<number | null> {
  try {
    return await withViewerTenant(
      (tx) =>
        countForReview(tx, { userId: viewer.user.id, workspaceId: viewer.workspaceId }, new Date()),
      viewer,
    );
  } catch (error) {
    // A count is a nicety: a failed one never fails the page it decorates.
    logger?.warn("inbox count unavailable", { error: errorSummary(error) });
    return null;
  }
}

/**
 * The signed-in viewer's count, once per server render: the layout's header and the home page
 * share it. Null signed out, or when it can't be read.
 */
export const getReviewCount = cache(async (): Promise<number | null> => {
  const viewer = await getViewer();
  return viewer ? readReviewCount(viewer, log) : null;
});
