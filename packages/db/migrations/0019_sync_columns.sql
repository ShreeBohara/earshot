-- Sync's columns (Phase 6 WP1, docs/adr/0040): the outbox's table shaped for the jobs WP3 writes,
-- each proposal's latest sync attempt (`proposals.sync`, the projection's `SyncView`, and its state
-- in `sync_state` for queries), the rep's time zone from `session.started` v2 (`sessions.time_zone`),
-- and `sync` among the audit checkpoints' requests. drizzle-kit generated it from src/schema, with
-- three of sync_jobs' columns answered as renames at its prompts: `adapter` is now `provider`,
-- `attempts` is `attempt`, and `status` is `state`. Nothing has written sync_jobs, so it takes NOT
-- NULL columns without defaults, and `external_id` goes: a job's writes can make up to eight records
-- (`records`). One statement is by hand: drizzle-kit renames `attempts` without moving its default
-- from 0 to 1 (its snapshot records 1), and an attempt is numbered from 1. The tables' row-level
-- security and grants are unchanged. Each statement has its own breakpoint: the migrator runs one
-- prepared statement per chunk.
ALTER TABLE "sync_jobs" RENAME COLUMN "adapter" TO "provider";--> statement-breakpoint
ALTER TABLE "sync_jobs" RENAME COLUMN "attempts" TO "attempt";--> statement-breakpoint
ALTER TABLE "sync_jobs" ALTER COLUMN "attempt" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "sync_jobs" RENAME COLUMN "status" TO "state";--> statement-breakpoint
ALTER TABLE "audit_checkpoints" DROP CONSTRAINT "audit_checkpoints_request_check";--> statement-breakpoint
ALTER TABLE "sync_jobs" DROP CONSTRAINT "sync_jobs_attempts_check";--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "sync" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "sync_state" text;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "review_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "not_before" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "mapping_version" integer;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "error_kind" text;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "records" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "time_zone" text;--> statement-breakpoint
CREATE INDEX "sync_jobs_workspace_id_state_not_before_idx" ON "sync_jobs" USING btree ("workspace_id","state","not_before");--> statement-breakpoint
ALTER TABLE "sync_jobs" DROP COLUMN "external_id";--> statement-breakpoint
ALTER TABLE "audit_checkpoints" ADD CONSTRAINT "audit_checkpoints_request_check" CHECK ("audit_checkpoints"."request" in ('review', 'flush', 'policy', 'export', 'sync'));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_sync_state_check" CHECK ("proposals"."sync_state" in ('syncing', 'synced', 'failed', 'conflicted'));--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_attempt_check" CHECK ("sync_jobs"."attempt" between 1 and 20);--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_state_check" CHECK ("sync_jobs"."state" in ('pending', 'syncing', 'synced', 'failed', 'conflicted', 'canceled'));--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_provider_check" CHECK ("sync_jobs"."provider" in ('hubspot', 'twenty', 'attio', 'demo'));--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_idempotency_key_check" CHECK ("sync_jobs"."idempotency_key" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_mapping_version_check" CHECK ("sync_jobs"."mapping_version" > 0);--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_error_kind_check" CHECK ("sync_jobs"."error_kind" in ('rate_limited', 'transient', 'auth', 'forbidden', 'not_found', 'validation', 'duplicate', 'unmapped', 'unsupported', 'unknown'));--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_last_error_check" CHECK ("sync_jobs"."last_error" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$');--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_time_zone_check" CHECK ("sessions"."time_zone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$' and char_length("sessions"."time_zone") <= 64);
