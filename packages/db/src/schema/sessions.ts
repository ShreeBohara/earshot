import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
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
 *
 * `focus_entity_id` references `crm_entities` through a foreign key that lives in migration 0014
 * instead of here: like `proposals.target_entity_id`, it needs `ON DELETE SET NULL
 * (focus_entity_id)`, which Drizzle can't express.
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
    /**
     * When `session.sealed` says the session was sealed (migration 0014, docs/adr/0032): Postgres
     * holds its whole log, and from then on the web Worker writes its reviews. Null until then.
     */
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    /**
     * The account open in Earshot when the session was created (`POST /api/sessions`), which
     * `start` names as `focusEntityId`. Null for none, or once that record is deleted.
     */
    focusEntityId: uuid("focus_entity_id"),
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
 * `@earshot/core`. The app role may only read and insert here (migration 0009). Not partitioned
 * yet; docs/adr/0019 says when to revisit that.
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
    /** When the event happened, by the writer's clock: the envelope's `ts` as an instant. */
    ts: timestamp({ withTimezone: true }).notNull(),
    /**
     * The envelope's `ts` exactly as written, when it isn't in the canonical form that `ts` reads
     * back as (UTC with milliseconds, `2026-11-10T19:15:00.040Z`): an offset, or a different
     * precision. Null otherwise. `timestamptz` keeps the instant but not the spelling, and the
     * event store returns events exactly as written (docs/adr/0020).
     */
    tsText: text("ts_text"),
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
    // Envelope timestamps always carry Z or an offset, so this cast doesn't depend on TimeZone.
    check(
      "session_events_ts_text_check",
      sql`${t.tsText} is null or ${t.tsText}::timestamptz = ${t.ts}`,
    ),
  ],
);

/**
 * Final utterances, projected from the log by `rebuildProjections`, from either witness:
 * `biased` (transcribed with the CRM's names as keyterms) or `unbiased` (without them). Each row
 * holds one `UtteranceView` from `@earshot/events`.
 */
export const utterances = pgTable(
  "utterances",
  {
    /** The id from the `utterance.final` event, which proposal evidence points at. */
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    sessionId: uuid("session_id").notNull(),
    /** The seq of the `utterance.final` event. */
    seq: integer().notNull(),
    /** The `utterance.final` event's `ts`. */
    ts: timestamp({ withTimezone: true }),
    witness: text().notNull(),
    text: text().notNull(),
    /** Word timings and confidences, as the provider reported them; null when it sent none. */
    words: jsonb().$type<unknown[]>().default([]),
    /** Double precision, so a confidence reads back exactly as the event has it. */
    confidence: doublePrecision(),
    /**
     * Offsets from the start of the session. bigint, because the contract's `AudioMs` accepts any
     * non-negative safe integer: an integer column would let the log hold an event that the
     * rebuild can't write.
     */
    startedMs: bigint("started_ms", { mode: "number" }).notNull(),
    endedMs: bigint("ended_ms", { mode: "number" }).notNull(),
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
