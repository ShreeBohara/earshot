-- Corrections and follow-up questions (Phase 5 WP13, docs/adr/0038): how each utterance's words
-- arrived (`utterances.input`, from `utterance.final` v3: `speech`, or `typed` into a correction)
-- and each proposal's follow-up questions (`proposals.followups`, from `followup.asked` and
-- `followup.closed` as the projection folds them), which `rebuildProjections` writes like every
-- other projected column. drizzle-kit generated it from src/schema. Expand only: both columns have
-- defaults, so rows written before WP13 read as speech with no questions until their session's
-- next rebuild, which is what their events say anyway.
ALTER TABLE "proposals" ADD COLUMN "followups" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "utterances" ADD COLUMN "input" text DEFAULT 'speech' NOT NULL;--> statement-breakpoint
ALTER TABLE "utterances" ADD CONSTRAINT "utterances_input_check" CHECK ("utterances"."input" in ('speech', 'typed'));