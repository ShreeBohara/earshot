ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "sessions_user_id_idx";--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_members"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_workspace_id_user_id_idx" ON "sessions" USING btree ("workspace_id","user_id");