ALTER TABLE "proposals" ADD COLUMN "target" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL;