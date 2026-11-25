-- The demo CRM's notes, tasks, and meetings (Phase 6 WP2; docs/adr/0041): what the demo adapter
-- writes when an approval syncs to the demo CRM, each on one of the workspace's demo records, with
-- the marker of the write that made it (write_id, unique in its workspace) so a retried write finds
-- its first try. drizzle-kit generated the table, its checks, keys, and index from src/schema; the
-- rest is by hand, because drizzle-kit can't express it: the table's row-level security and grants.
-- Each statement has its own breakpoint: the migrator runs one prepared statement per chunk.
--
-- Append-only for the app, like crm_entity_changes (migration 0017): its role may read and insert
-- its own workspace's activities, and never change or delete one. An activity goes with its record
-- (the composite key cascades), and with its workspace.
CREATE TABLE "crm_demo_activities" (
	"workspace_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"write_id" text NOT NULL,
	"body" text NOT NULL,
	"due_at" timestamp with time zone,
	"starts_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_demo_activities_workspace_id_write_id_unique" UNIQUE("workspace_id","write_id"),
	CONSTRAINT "crm_demo_activities_kind_check" CHECK ("crm_demo_activities"."kind" in ('note', 'task', 'meeting')),
	CONSTRAINT "crm_demo_activities_write_id_check" CHECK ("crm_demo_activities"."write_id" ~ '^es_[a-z2-7]{20}$'),
	CONSTRAINT "crm_demo_activities_body_check" CHECK (char_length("crm_demo_activities"."body") between 1 and 20000),
	CONSTRAINT "crm_demo_activities_due_at_check" CHECK ("crm_demo_activities"."due_at" is null or "crm_demo_activities"."kind" = 'task'),
	CONSTRAINT "crm_demo_activities_starts_at_check" CHECK ("crm_demo_activities"."starts_at" is null or "crm_demo_activities"."kind" = 'meeting')
);
--> statement-breakpoint
ALTER TABLE "crm_demo_activities" ADD CONSTRAINT "crm_demo_activities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_demo_activities" ADD CONSTRAINT "crm_demo_activities_entity_fk" FOREIGN KEY ("workspace_id","entity_id") REFERENCES "public"."crm_entities"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_demo_activities_entity_idx" ON "crm_demo_activities" USING btree ("workspace_id","entity_id","created_at");
--> statement-breakpoint
ALTER TABLE crm_demo_activities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON crm_demo_activities TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Last, after the policy, so a run that stops partway leaves the app no access rather than access
-- to a table without RLS.
GRANT SELECT, INSERT ON TABLE crm_demo_activities TO earshot_app;
