import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * The tenant. Phase 2 gives each user one workspace; everything a user creates belongs to a
 * workspace, and row-level security keys on it (docs/adr/0019).
 */
export const workspaces = pgTable("workspaces", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The tenant key every tenant table carries. Deleting a workspace deletes all of its rows.
 * A new table that calls this also needs RLS, a policy, and grants in a migration; the pgTAP
 * structure test fails until it has them.
 */
export function workspaceId() {
  return uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });
}

/** Who belongs to a workspace. Phase 2 has one member per workspace, its owner. */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: workspaceId(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text().notNull().default("owner"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    // Finding a user's workspace happens before a tenant is pinned, so it runs as the owner.
    index("workspace_members_user_id_idx").on(t.userId),
    check("workspace_members_role_check", sql`${t.role} in ('owner')`),
  ],
);
