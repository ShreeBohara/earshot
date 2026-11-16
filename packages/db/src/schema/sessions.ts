import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaceId, workspaceMembers } from "./workspaces";

/**
 * One capture session: a debrief, a conversation, or a local-mode run. Not to be confused
 * with Better Auth's `session` table, which holds sign-in sessions.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    /** Who recorded it: a member of the workspace, and the transaction's own user (0004). */
    userId: text("user_id").notNull(),
    mode: text().notNull(),
    engine: text().notNull(),
    /** Which speech-to-text, LLM, and speech-to-speech providers and models ran. */
    providers: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
    /** Latency and usage measurements. */
    metrics: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    unique("sessions_workspace_id_id_unique").on(t.workspaceId, t.id),
    // Removing a member removes their sessions in that workspace, and everything under them.
    foreignKey({
      name: "sessions_member_fk",
      columns: [t.workspaceId, t.userId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
    }).onDelete("cascade"),
    index("sessions_workspace_id_started_at_idx").on(t.workspaceId, t.startedAt),
    index("sessions_workspace_id_user_id_idx").on(t.workspaceId, t.userId),
    check("sessions_mode_check", sql`${t.mode} in ('debrief', 'conversation', 'local')`),
  ],
);

/**
 * The append-only event log (docs/adr/0004): one row per `EventEnvelope` from
 * `@earshot/core`. Not partitioned yet; docs/adr/0019 says when to revisit that.
 */
export const sessionEvents = pgTable(
  "session_events",
  {
    /**
     * The envelope's own id (a UUIDv7), which the event store returns. No default: every
     * envelope has one, and a missing id should fail rather than be invented.
     */
    id: uuid().notNull(),
    workspaceId: workspaceId(),
    sessionId: uuid("session_id").notNull(),
    seq: integer().notNull(),
    type: text().notNull(),
    schemaVersion: integer("schema_version").notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    ts: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.seq] }),
    // Scoped to the session rather than global, so a conflict reveals nothing about other
    // workspaces' events.
    uniqueIndex("session_events_session_id_id_unique").on(t.sessionId, t.id),
    foreignKey({
      name: "session_events_session_fk",
      columns: [t.workspaceId, t.sessionId],
      foreignColumns: [sessions.workspaceId, sessions.id],
    }).onDelete("cascade"),
    index("session_events_workspace_id_session_id_idx").on(t.workspaceId, t.sessionId),
    check("session_events_seq_check", sql`${t.seq} >= 0`),
    check("session_events_schema_version_check", sql`${t.schemaVersion} > 0`),
  ],
);

/**
 * Final utterances, projected from the log, from either witness: `biased` (transcribed with
 * the CRM's names as keyterms) or `unbiased` (without them).
 */
export const utterances = pgTable(
  "utterances",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    sessionId: uuid("session_id").notNull(),
    seq: integer().notNull(),
    witness: text().notNull(),
    text: text().notNull(),
    /** Word timings and confidences, as the provider reported them. */
    words: jsonb().$type<unknown[]>().notNull().default([]),
    confidence: real(),
    /** Offsets from the start of the session. */
    startedMs: integer("started_ms").notNull(),
    endedMs: integer("ended_ms").notNull(),
  },
  (t) => [
    unique("utterances_session_id_witness_seq_unique").on(t.sessionId, t.witness, t.seq),
    foreignKey({
      name: "utterances_session_fk",
      columns: [t.workspaceId, t.sessionId],
      foreignColumns: [sessions.workspaceId, sessions.id],
    }).onDelete("cascade"),
    index("utterances_workspace_id_session_id_idx").on(t.workspaceId, t.sessionId),
    check("utterances_seq_check", sql`${t.seq} >= 0`),
    check("utterances_witness_check", sql`${t.witness} in ('biased', 'unbiased')`),
  ],
);
