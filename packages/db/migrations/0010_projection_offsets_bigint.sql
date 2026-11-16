ALTER TABLE "proposals" ALTER COLUMN "reviewer_ms" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "utterances" ALTER COLUMN "started_ms" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "utterances" ALTER COLUMN "ended_ms" SET DATA TYPE bigint;