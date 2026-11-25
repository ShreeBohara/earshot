import { sql } from "drizzle-orm";
import {
  bigint,
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
 * `target` is the entity linker's decision (`TargetV2`, migration 0012), after any downgrade by
 * the second witness, and `target_entity_id` holds its `entityId`. Flags on the target are in
 * `risk_flags` as `kind:target`.
 *
 * From migration 0014 (Phase 5 WP3, docs/adr/0032) a row holds the latest review whole (`review`,
 * every field of `proposal.reviewed` v2 as the projection keeps it, a reopen included), with the
 * fields the inbox and Phase 6's sync query by in columns of their own: `review_id`,
 * `review_mode`, `batch_id`, `policy_id`, and `sync_eligible_at`. It also holds the snooze
 * (`snoozed_until`) and the corrections that replace proposals (`supersedes`, `superseded_by`,
 * with the status `superseded`). From migration 0018 (Phase 5 WP13, docs/adr/0038) it holds its
 * follow-up questions too (`followups`). From migration 0019 (Phase 6 WP1, docs/adr/0040) it holds
 * its latest sync attempt whole (`sync`, as the projection's `SyncView` keeps it), with its state in
 * a column of its own for queries (`sync_state`), and the statuses `synced` and `failed`.
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
    /** The linker's decision on the target. Null on rows from before Phase 4, until a rebuild. */
    target: jsonb().$type<Record<string, unknown>>(),
    fields: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Each flag as its `kind`, or as `kind:field` when it's about one field (`date:dueDate`). */
    riskFlags: text("risk_flags").array().notNull().default(sql`'{}'::text[]`),
    /** Where the two witnesses disagreed, from `proposal.flagged`, in order. */
    conflicts: jsonb().$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    status: text().notNull().default("proposed"),
    /** What the reviewer changed, when the status is `edited`. */
    editDiff: jsonb("edit_diff").$type<Record<string, unknown>>(),
    /**
     * How long the latest review took: the review clock's `handlingMs` (v1's `reviewerMs`).
     * bigint, like the contract's safe-integer range.
     */
    reviewerMs: bigint("reviewer_ms", { mode: "number" }),
    /** The seq of the `proposal.created` event. */
    seq: integer(),
    /** The seq and `ts` of the latest `proposal.reviewed` event; null until the first review. */
    reviewedSeq: integer("reviewed_seq"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /**
     * The latest review, a reopen included, as `@earshot/events`' `ReviewView` keeps it, without
     * its seq and time (`reviewed_seq`, `reviewed_at`). Null until the first review.
     */
    review: jsonb().$type<Record<string, unknown>>(),
    /** The latest review's `reviewId`: what an undo names, and what Phase 6 re-reads. */
    reviewId: uuid("review_id"),
    /** The latest review's mode: `single`, `batch`, `policy`, or `system`. */
    reviewMode: text("review_mode"),
    /** The "accept all" the latest review belonged to, when its mode is `batch`. */
    batchId: uuid("batch_id"),
    /** The approval policy behind the latest review, when its mode is `policy`. */
    policyId: uuid("policy_id"),
    /** When the latest review, an approval or an edit, may sync to the CRM. */
    syncEligibleAt: timestamp("sync_eligible_at", { withTimezone: true }),
    /** Hidden from the inbox until then, from the latest `proposal.snoozed`. */
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    /** The proposal this one replaces (a correction); null otherwise. */
    supersedes: uuid(),
    /** The proposal that replaced this one; set exactly when the status is `superseded`. */
    supersededBy: uuid("superseded_by"),
    /**
     * Its follow-up questions (migration 0018, Phase 5 WP13; docs/adr/0038), as the projection
     * keeps them (`FollowupView`): each asked about it, or still open on a proposal it replaced.
     */
    followups: jsonb().$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    /**
     * The latest sync attempt (migration 0019, Phase 6 WP1; docs/adr/0040), as the projection keeps
     * it (`SyncView`): its job, review, attempt, and CRM, what it wrote, or why it didn't. Null until
     * the outbox claims a job for the proposal.
     */
    sync: jsonb().$type<Record<string, unknown>>(),
    /** That attempt's state, for queries: `syncing`, `synced`, `failed`, or `conflicted`. */
    syncState: text("sync_state"),
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
      sql`${t.status} in ('proposed', 'approved', 'edited', 'rejected', 'superseded', 'synced', 'failed')`,
    ),
    check("proposals_seq_check", sql`${t.seq} >= 0`),
    check("proposals_reviewed_seq_check", sql`${t.reviewedSeq} >= 0`),
    check(
      "proposals_review_mode_check",
      sql`${t.reviewMode} in ('single', 'batch', 'policy', 'system')`,
    ),
    check(
      "proposals_sync_state_check",
      sql`${t.syncState} in ('syncing', 'synced', 'failed', 'conflicted')`,
    ),
  ],
);

/** Where a sync job stands (Phase 6 spec §4.5). */
export const SYNC_JOB_STATES = [
  "pending",
  "syncing",
  "synced",
  "failed",
  "conflicted",
  "canceled",
] as const;
export type SyncJobState = (typeof SYNC_JOB_STATES)[number];

/**
 * The CRM sync outbox (Phase 6 spec §4.5, decisions 1 to 3; docs/adr/0040): one job per approval,
 * inserted in the same transaction as the event that makes its proposal eligible (WP3), and keyed
 * by `idempotency_key`, so a second insert for the same approval does nothing.
 *
 * Migration 0019 (Phase 6 WP1) shaped it for the outbox before anything had written it: the review
 * it syncs, the CRM and connection it writes to, the attempt, when it may run (`not_before`, the
 * review's `syncEligibleAt`), the mapping version it plans with, its state (`status` renamed, with
 * a check), how its last attempt ended, and what its writes did. `adapter` became `provider` and
 * `attempts` became `attempt`; `external_id` went, since a job's writes can make up to eight
 * records (`records`).
 */
export const syncJobs = pgTable(
  "sync_jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    proposalId: uuid("proposal_id").notNull(),
    /** The approval it syncs: its `proposal.reviewed` event's `reviewId`. */
    reviewId: uuid("review_id").notNull(),
    /** `hubspot`, `twenty`, `attio`, or `demo`. */
    provider: text().notNull(),
    /**
     * The CRM connection it writes through; null for the demo CRM. No foreign key yet: what a
     * disconnect does to a connection's jobs is WP5's (docs/adr/0040).
     */
    connectionId: uuid("connection_id"),
    /**
     * Lowercase hex SHA-256 of `earshot.sync.v1:`, the proposal id, and the review id (Phase 6 spec
     * decision 3; `idempotencyKey` in `@earshot/crm`). Unique across all workspaces, which is why
     * it's derived from random ids: a guessable key would let one tenant probe for another's
     * through a conflict.
     */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    /** The attempt under way, or the last one made, from 1. A Retry starts the next. */
    attempt: integer().notNull().default(1),
    /** `SYNC_JOB_STATES`. */
    state: text().notNull().default("pending"),
    /** When it may run: its review's `syncEligibleAt`, the end of the undo window. */
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    /** The version of the connection's mapping it plans with; null for the demo CRM. */
    mappingVersion: integer("mapping_version"),
    /** How its last attempt failed: a `SyncErrorKind` from `@earshot/core`; null otherwise. */
    errorKind: text("error_kind"),
    /**
     * Why it failed or was canceled, as a fixed code: the CRM's error code or category, or the
     * claim's reason. Never the CRM's message, which can quote a record.
     */
    lastError: text("last_error"),
    /** What each write did, as `proposal.synced` records it: `{ write, op, ref }` each. */
    records: jsonb().$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    /** When the outbox claimed its latest attempt, and when that attempt ended. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: "sync_jobs_proposal_fk",
      columns: [t.workspaceId, t.proposalId],
      foreignColumns: [proposals.workspaceId, proposals.id],
    }).onDelete("cascade"),
    index("sync_jobs_workspace_id_proposal_id_idx").on(t.workspaceId, t.proposalId),
    // The sweep's query: a workspace's jobs in a state, by when they may run.
    index("sync_jobs_workspace_id_state_not_before_idx").on(t.workspaceId, t.state, t.notBefore),
    check("sync_jobs_attempt_check", sql`${t.attempt} between 1 and 20`),
    check(
      "sync_jobs_state_check",
      sql`${t.state} in ('pending', 'syncing', 'synced', 'failed', 'conflicted', 'canceled')`,
    ),
    check("sync_jobs_provider_check", sql`${t.provider} in ('hubspot', 'twenty', 'attio', 'demo')`),
    check("sync_jobs_idempotency_key_check", sql`${t.idempotencyKey} ~ '^[0-9a-f]{64}$'`),
    check("sync_jobs_mapping_version_check", sql`${t.mappingVersion} > 0`),
    check(
      "sync_jobs_error_kind_check",
      sql`${t.errorKind} in ('rate_limited', 'transient', 'auth', 'forbidden', 'not_found', 'validation', 'duplicate', 'unmapped', 'unsupported', 'unknown')`,
    ),
    check("sync_jobs_last_error_check", sql`${t.lastError} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'`),
  ],
);
