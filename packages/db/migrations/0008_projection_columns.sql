ALTER TABLE "utterances" ALTER COLUMN "words" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "utterances" ALTER COLUMN "confidence" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "seq" integer;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "reviewed_seq" integer;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "utterances" ADD COLUMN "ts" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_seq_check" CHECK ("proposals"."seq" >= 0);--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_reviewed_seq_check" CHECK ("proposals"."reviewed_seq" >= 0);