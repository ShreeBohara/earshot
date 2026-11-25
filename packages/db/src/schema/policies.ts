import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaceId } from "./workspaces";

/**
 * A workspace's approval policy, one row per version (Phase 5 spec §4.6, WP11; docs/adr/0034):
 * which proposal types SessionDO approves on its own as they're created, and the fields that
 * always need review (`ApprovalPolicyRules` in `@earshot/core`). Each change inserts the next
 * version; the latest is the policy, and no row means every proposal waits for a person.
 *
 * Append-only for the app, like `audit_log`: its role may only read and insert here, in its own
 * workspace, and only in its own user's name (migration 0016). `id` is the policy's own, the same
 * for every version of a workspace's policy, and auto-approvals name it with the version and the
 * rule (`proposal.reviewed` v2's `policy`). `rules_sha256` is the lowercase hex SHA-256 of the
 * rules' canonical JSON (`canonicalJson` in `@earshot/core`), which the change's `policy.changed`
 * audit entry repeats.
 *
 * `(workspace_id, created_by)` references `workspace_members` through a foreign key that lives in
 * migration 0016: like `audit_log.actor_user_id`, it needs `ON DELETE SET NULL (created_by)`, which
 * Drizzle can't express, so a version outlives its author's membership.
 */
export const approvalPolicies = pgTable(
  "approval_policies",
  {
    workspaceId: workspaceId(),
    /** The policy's id: the same for every version of a workspace's policy. */
    id: uuid().notNull(),
    /** 1 for the first version, and one more for each change. */
    version: integer().notNull(),
    /** `ApprovalPolicyRules`, as the writer checked them. */
    rules: jsonb().$type<Record<string, unknown>>().notNull(),
    rulesSha256: text("rules_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Who changed it: the transaction's own user. Null once they leave the workspace. */
    createdBy: text("created_by"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.version] }),
    check("approval_policies_version_check", sql`${t.version} > 0`),
    check("approval_policies_rules_sha256_check", sql`${t.rulesSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);
