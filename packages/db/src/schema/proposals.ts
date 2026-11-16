import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { sessions } from "./sessions";
import { workspaceId } from "./workspaces";

/**
 * A proposed CRM change, waiting for a human (docs/adr/0007). Every value in `fields` carries
 * its evidence: utterance, character span, audio offsets, and confidence. `rebuildProjections`
 * writes each row from one `ProposalView` in `@earshot/events`: `id` is the event's
 * `proposalId`, `created_at` the `proposal.created` event's `ts`, and `updated_at` the latest
 * review's `ts`, or `created_at` before any review.
 *
 * `target_entity_id` references `crm_entities` through a foreign key that lives in migration
 * 0004 instead of here: it needs `ON DELETE SET NULL (target_entity_id)`, which Drizzle can't
 * express, so deleting an entity clears the target without touching `workspace_id`.
 */
export const proposals = pgTable(
  "proposals",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    sessionId: uuid("session_id").notNull(),
    /** For example `note`, `task`, `contact`, or `deal_update`. */
    type: text().notNull(),
    targetEntityId: uuid("target_entity_id"),
    fields: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Each flag as its `kind`, or as `kind:field` when it's about one field (`date:dueDate`). */
    riskFlags: text("risk_flags").array().notNull().default(sql`'{}'::text[]`),
    status: text().notNull().default("proposed"),
    /** What the reviewer changed, when the status is `edited`. */
    editDiff: jsonb("edit_diff").$type<Record<string, unknown>>(),
    /** How long the reviewer took to decide. */
    reviewerMs: integer("reviewer_ms"),
    /** The seq of the `proposal.created` event. */
    seq: integer(),
    /** The seq and `ts` of the latest `proposal.reviewed` event; null until the first review. */
    reviewedSeq: integer("reviewed_seq"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique("proposals_workspace_id_id_unique").on(t.workspaceId, t.id),
    foreignKey({
      name: "proposals_session_fk",
      columns: [t.workspaceId, t.sessionId],
      foreignColumns: [sessions.workspaceId, sessions.id],
    }).onDelete("cascade"),
    index("proposals_workspace_id_session_id_idx").on(t.workspaceId, t.sessionId),
    index("proposals_workspace_id_status_idx").on(t.workspaceId, t.status),
    index("proposals_workspace_id_target_entity_id_idx").on(t.workspaceId, t.targetEntityId),
    check(
      "proposals_status_check",
      sql`${t.status} in ('proposed', 'approved', 'edited', 'rejected', 'synced', 'failed')`,
    ),
    check("proposals_seq_check", sql`${t.seq} >= 0`),
    check("proposals_reviewed_seq_check", sql`${t.reviewedSeq} >= 0`),
  ],
);

/** The CRM sync outbox: one job per approved proposal and adapter. */
export const syncJobs = pgTable(
  "sync_jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    proposalId: uuid("proposal_id").notNull(),
    adapter: text().notNull(),
    /**
     * Unique across all workspaces, so derive it from random ids (for example the proposal
     * id): a guessable key would let one tenant probe for another's through a conflict.
     */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    attempts: integer().notNull().default(0),
    lastError: text("last_error"),
    /** The record id the CRM returned. */
    externalId: text("external_id"),
    status: text().notNull().default("pending"),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: "sync_jobs_proposal_fk",
      columns: [t.workspaceId, t.proposalId],
      foreignColumns: [proposals.workspaceId, proposals.id],
    }).onDelete("cascade"),
    index("sync_jobs_workspace_id_proposal_id_idx").on(t.workspaceId, t.proposalId),
    check("sync_jobs_attempts_check", sql`${t.attempts} >= 0`),
  ],
);
