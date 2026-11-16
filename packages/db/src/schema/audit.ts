import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaceId } from "./workspaces";

/**
 * Every approval, edit, sync, key change, and export. Append-only for the app: its role may
 * only read and insert here, and only in its own user's name (migration 0004). Ids are random
 * UUIDs rather than a sequence, so they reveal nothing about other workspaces' activity.
 *
 * `(workspace_id, actor_user_id)` references `workspace_members` through a foreign key that
 * lives in migration 0004: it needs `ON DELETE SET NULL (actor_user_id)`, which Drizzle can't
 * express, so an entry outlives its actor's membership.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    /** Null for system actors, and once the actor leaves the workspace. */
    actorUserId: text("actor_user_id"),
    /** Dotted, for example `proposal.approved` or `credential.rotated`. */
    action: text().notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    detail: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_workspace_id_at_idx").on(t.workspaceId, t.at)],
);
