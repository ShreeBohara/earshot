import { sessions, user, workspaceMembers, workspaces } from "../src/schema";
import type { TenantContext } from "../src/tenant";
import type { migratedDb } from "./db";

type Db = Awaited<ReturnType<typeof migratedDb>>["db"];

/**
 * Creates a tenant as the app will, connected as the owner (row-level security doesn't apply):
 * the user in Better Auth's `user` table, the workspace, the user's owner membership, and one
 * debrief per session id, started by that user. The membership comes before the sessions, and
 * every session's `user_id` is the tenant's own, so the rows also satisfy a foreign key from
 * `sessions (workspace_id, user_id)` to `workspace_members`, and policies that require
 * `sessions.user_id` to match `app.user_id` on tenant writes.
 */
export async function createTenant(
  db: Db,
  tenant: TenantContext,
  sessionIds: readonly string[] = [],
): Promise<void> {
  await db.insert(user).values({
    id: tenant.userId,
    name: `User ${tenant.userId}`,
    email: `${tenant.userId}@example.test`,
  });
  await db.insert(workspaces).values({ id: tenant.workspaceId, name: `${tenant.userId}'s` });
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: tenant.workspaceId, userId: tenant.userId, role: "owner" });
  if (sessionIds.length > 0) {
    await db.insert(sessions).values(
      sessionIds.map((id) => ({
        id,
        workspaceId: tenant.workspaceId,
        userId: tenant.userId,
        mode: "debrief",
        engine: "cascaded",
      })),
    );
  }
}
