import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea } from "./columns";
import { workspaceId } from "./workspaces";

/**
 * For the chain columns, which the `BEFORE INSERT` trigger fills (migration 0013): Drizzle sends
 * `DEFAULT`, which is NULL for these columns, and the trigger replaces it before `NOT NULL` is
 * checked. Inserts may leave them out; anything an insert does send is overwritten.
 */
const filledByTrigger = () => sql`default`;

/**
 * Every approval, edit, sync, key change, and export. Append-only for the app: its role may
 * only read and insert here, and only in its own user's name (migration 0004). Ids are random
 * UUIDs rather than a sequence, so they reveal nothing about other workspaces' activity.
 *
 * `(workspace_id, actor_user_id)` references `workspace_members` through a foreign key that
 * lives in migration 0004: it needs `ON DELETE SET NULL (actor_user_id)`, which Drizzle can't
 * express, so an entry outlives its actor's membership.
 *
 * The rows of each workspace form a hash chain (migration 0013, docs/adr/0033). A trigger sets
 * `chain_seq` (1, 2, 3, … per workspace), `prev_hash` (the previous row's `entry_hash`, or 32
 * zero bytes), `at` (the clock once the workspace's lock is held, never earlier than the row
 * before), and `entry_hash`, SHA-256 of `prev_hash` and the row's canonical text
 * (`audit_entry_canonical`). The app can't choose any of them.
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
    /**
     * Set by the trigger: when the row joined the chain, never earlier than the row before it. A
     * value the app sends is ignored.
     */
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** The row's place in its workspace's chain, from 1, with no gaps. Set by the trigger. */
    chainSeq: bigint("chain_seq", { mode: "number" }).notNull().$defaultFn(filledByTrigger),
    /** The previous row's `entry_hash`, or 32 zero bytes for the first row. Set by the trigger. */
    prevHash: bytea("prev_hash").notNull().$defaultFn(filledByTrigger),
    /** SHA-256 of `prev_hash` and the row's canonical text, as UTF-8. Set by the trigger. */
    entryHash: bytea("entry_hash").notNull().$defaultFn(filledByTrigger),
  },
  (t) => [
    index("audit_log_workspace_id_at_idx").on(t.workspaceId, t.at),
    unique("audit_log_workspace_id_chain_seq_unique").on(t.workspaceId, t.chainSeq),
    check("audit_log_chain_seq_check", sql`${t.chainSeq} > 0`),
    check("audit_log_prev_hash_check", sql`octet_length(${t.prevHash}) = 32`),
    check("audit_log_entry_hash_check", sql`octet_length(${t.entryHash}) = 32`),
  ],
);

/**
 * Why a checkpoint was signed: a web request with reviews, a flush message with them, a policy
 * change, an account export (which signs the head it exports), or the sync outbox's record of an
 * attempt's result (Phase 6, migration 0019).
 */
export const AUDIT_CHECKPOINT_REQUESTS = ["review", "flush", "policy", "export", "sync"] as const;
export type AuditCheckpointRequest = (typeof AUDIT_CHECKPOINT_REQUESTS)[number];

/**
 * Signed heads of the audit chain (docs/adr/0033): one per review request and per account export,
 * signed with Ed25519 in the Worker that wrote the rows. The signed text is
 * `{"v":1,"wid":…,"seq":…,"head":…,"ts":…,"kid":…}` (`checkpointMessage` in `@earshot/keys`),
 * rebuilt from these columns: `head` is `entry_hash` in hex and `ts` is `signed_at` in ISO form
 * with milliseconds.
 *
 * A tenant table with the audit log's rules: the app may only read and insert (migration 0013).
 * `(workspace_id, chain_seq)` must name an existing chain row.
 */
export const auditCheckpoints = pgTable(
  "audit_checkpoints",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    /** The head this checkpoint signs. */
    chainSeq: bigint("chain_seq", { mode: "number" }).notNull(),
    /** That row's `entry_hash`. */
    entryHash: bytea("entry_hash").notNull(),
    /** The signed time, with millisecond precision. */
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    /** Which key signed it; `/api/audit/keys` serves its public half. */
    kid: text().notNull(),
    /** Ed25519, 64 bytes. */
    signature: bytea().notNull(),
    request: text().$type<AuditCheckpointRequest>().notNull(),
  },
  (t) => [
    foreignKey({
      name: "audit_checkpoints_chain_fk",
      columns: [t.workspaceId, t.chainSeq],
      foreignColumns: [auditLog.workspaceId, auditLog.chainSeq],
    }),
    index("audit_checkpoints_workspace_id_chain_seq_idx").on(t.workspaceId, t.chainSeq),
    check(
      "audit_checkpoints_request_check",
      sql`${t.request} in ('review', 'flush', 'policy', 'export', 'sync')`,
    ),
    check("audit_checkpoints_chain_seq_check", sql`${t.chainSeq} > 0`),
    check("audit_checkpoints_entry_hash_check", sql`octet_length(${t.entryHash}) = 32`),
    check("audit_checkpoints_signature_check", sql`octet_length(${t.signature}) = 64`),
    check("audit_checkpoints_kid_check", sql`${t.kid} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'`),
  ],
);
