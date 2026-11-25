-- The mirror's history (Phase 5 WP12, spec decision 10; docs/adr/0008): one row per change to one
-- field of one crm_entities row, its value before and after, when, and where it came from (the demo
-- CRM's controls now, Phase 6's sync later). valueAt (src/crm-history.ts) reads a field's value at
-- any time from it, so a review card can show the CRM's value when the rep spoke beside its value
-- now. drizzle-kit generated the table, its checks, keys, and index from src/schema; the rest is by
-- hand, because drizzle-kit can't express it: the table's row-level security and grants. Each
-- statement has its own breakpoint: the migrator runs one prepared statement per chunk.
--
-- Append-only for the app, like audit_log (docs/adr/0019): its role may read and insert its own
-- workspace's changes, and never change or delete one. A change goes with its record (the composite
-- key cascades), and with its workspace.
CREATE TABLE "crm_entity_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old" jsonb,
	"new" jsonb,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "crm_entity_changes_source_check" CHECK ("crm_entity_changes"."source" in ('demo', 'sync')),
	CONSTRAINT "crm_entity_changes_field_check" CHECK ("crm_entity_changes"."field" ~ '^[a-z][A-Za-z0-9]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "crm_entity_changes" ADD CONSTRAINT "crm_entity_changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_entity_changes" ADD CONSTRAINT "crm_entity_changes_entity_fk" FOREIGN KEY ("workspace_id","entity_id") REFERENCES "public"."crm_entities"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_entity_changes_entity_field_idx" ON "crm_entity_changes" USING btree ("workspace_id","entity_id","field","changed_at");
--> statement-breakpoint
ALTER TABLE crm_entity_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON crm_entity_changes TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Last, after the policy, so a run that stops partway leaves the app no access rather than access
-- to a table without RLS.
GRANT SELECT, INSERT ON TABLE crm_entity_changes TO earshot_app;
