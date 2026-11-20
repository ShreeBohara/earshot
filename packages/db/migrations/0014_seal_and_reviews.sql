-- The seal, the focus account, and the review columns (Phase 5 WP3, docs/adr/0032). drizzle-kit
-- generated the columns and checks from src/schema; the focus account's foreign key is by hand,
-- because drizzle-kit can't express SET NULL for one column. Every new column is nullable: rows
-- that exist get their values at their session's next rebuild (any flush, review, or repair), as
-- migration 0012's `target` did, since only the log knows them. Each statement has its own
-- breakpoint: the migrator runs one prepared statement per chunk.
--
-- The status check is dropped and recreated with `superseded`, the status a proposal takes when a
-- correction replaces it (WP13).
ALTER TABLE "proposals" DROP CONSTRAINT "proposals_status_check";--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "review" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "review_id" uuid;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "review_mode" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "policy_id" uuid;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "sync_eligible_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "supersedes" uuid;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "sealed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "focus_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_review_mode_check" CHECK ("proposals"."review_mode" in ('single', 'batch', 'policy', 'system'));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_status_check" CHECK ("proposals"."status" in ('proposed', 'approved', 'edited', 'rejected', 'superseded', 'synced', 'failed'));--> statement-breakpoint
-- The focus account is a record of the session's own workspace. Deleting that record (removing
-- the demo CRM, say) clears the column and leaves the session and its workspace alone, as
-- `proposals.target_entity_id` does (migration 0004).
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_focus_entity_fk"
  FOREIGN KEY ("workspace_id", "focus_entity_id") REFERENCES "crm_entities" ("workspace_id", "id")
  ON DELETE SET NULL ("focus_entity_id");
