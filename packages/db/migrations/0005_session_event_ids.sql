ALTER TABLE "session_events" DROP CONSTRAINT "session_events_id_unique";--> statement-breakpoint
ALTER TABLE "session_events" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_session_id_id_unique" ON "session_events" USING btree ("session_id","id");