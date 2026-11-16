// The data layer's auth checks. Every page, server action, and route handler that touches user or
// tenant data starts here: proxy.ts only makes optimistic redirects from cookie presence, and is
// never the only check (docs/adr/0006).
import "server-only";
import { type TenantTransaction, withTenant } from "@earshot/db";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "../db";
import { hasSessionCookie } from "./cookies";
import { getAuth } from "./index";
import { HOME_PATH, signInPath } from "./redirects";
import { loadViewer, type Viewer } from "./viewer-core";

export { displayName, type Viewer } from "./viewer-core";

type Schema = typeof import("@earshot/db").schema;

/**
 * A transaction pinned to the viewer's workspace and user, as `withTenant` opens it: the event
 * store's `TenantTransaction`, typed with the app's schema.
 */
export type TenantTx = TenantTransaction<
  PgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

/**
 * The signed-in viewer, or null. Checks the session against the database (no trust in cookies
 * alone) and resolves the workspace. Memoized for one server render, so a layout and its page
 * share one lookup. Visitors with no session cookie cost nothing: no auth setup, no database.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  if (!hasSessionCookie(await cookies())) return null;
  const [auth, db] = await Promise.all([getAuth(), getDb()]);
  return loadViewer({ auth, db, headers: await headers() });
});

/**
 * The viewer, for pages and server actions. Without a valid session it redirects to /sign-in,
 * which sends the user back to `next` afterwards.
 */
export async function requireViewer(next: string = HOME_PATH): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect(signInPath(next));
  return viewer;
}

/**
 * Wraps a route handler so it only runs for a signed-in viewer. Without a valid session it
 * answers 401 with a JSON body instead of redirecting.
 */
export function withViewer<TContext = unknown>(
  handler: (viewer: Viewer, request: Request, context: TContext) => Response | Promise<Response>,
) {
  return async (request: Request, context: TContext): Promise<Response> => {
    const viewer = await getViewer();
    if (!viewer) {
      return Response.json(
        { error: "unauthorized", message: "Sign in to continue." },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
    return handler(viewer, request, context);
  };
}

/**
 * Runs `fn` in a transaction pinned to the viewer's workspace and user (`withTenant`): row-level
 * security limits it to that workspace's rows and binds every row it writes to the viewer. Pass
 * the viewer from `withViewer` in route handlers; elsewhere it's resolved here, redirecting to
 * /sign-in when there's none.
 */
export async function withViewerTenant<T>(
  fn: (tx: TenantTx, viewer: Viewer) => Promise<T>,
  viewer?: Viewer,
): Promise<T> {
  const current = viewer ?? (await requireViewer());
  return withTenant(
    await getDb(),
    { userId: current.user.id, workspaceId: current.workspaceId },
    (tx) => fn(tx, current),
  );
}
