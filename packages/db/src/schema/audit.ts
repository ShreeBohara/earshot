import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { workspaceId } from "./workspaces";

/**
 * Every approval, edit, sync, key change, and export. Append-only for the app: its role may
 * only read and insert here (migration 0004). Ids are random UUIDs rather than a sequence, so
 * they reveal nothing about other workspaces' activity.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    /** Null for system actors, and once the user is deleted. */
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    /** Dotted, for example `proposal.approved` or `credential.rotated`. */
    action: text().notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    detail: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_workspace_id_at_idx").on(t.workspaceId, t.at)],
);
