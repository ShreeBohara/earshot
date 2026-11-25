-- Approval policies (Phase 5 WP11, docs/adr/0034): one row per version of a workspace's policy,
-- which proposal types SessionDO approves on its own as they're created, and the fields that always
-- need review. drizzle-kit generated the table and its checks from src/schema; the rest is by hand,
-- because drizzle-kit can't express it: the author's foreign key, which clears one column, and the
-- table's row-level security, actor policy, and grants. Each statement has its own breakpoint: the
-- migrator runs one prepared statement per chunk.
--
-- Append-only for the app, like audit_log (docs/adr/0019): its role may read and insert its own
-- workspace's versions, in its own user's name, and never change or delete one. No row means no
-- policy: every proposal waits for a person.
CREATE TABLE "approval_policies" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"rules_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "approval_policies_workspace_id_version_pk" PRIMARY KEY("workspace_id","version"),
	CONSTRAINT "approval_policies_version_check" CHECK ("approval_policies"."version" > 0),
	CONSTRAINT "approval_policies_rules_sha256_check" CHECK ("approval_policies"."rules_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A version's author must be a member of its workspace. Hand-written for the reason audit_log's
-- actor key is (migration 0004): when the membership goes, the version stays and only its author
-- is cleared.
ALTER TABLE approval_policies ADD CONSTRAINT approval_policies_creator_fk
  FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_members (workspace_id, user_id)
  ON DELETE SET NULL (created_by);
--> statement-breakpoint
ALTER TABLE approval_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON approval_policies TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A version names the transaction's own user as its author, so a member can't change a policy in
-- someone else's name. RESTRICTIVE, on top of tenant_isolation, as audit_log's actor_insert is.
CREATE POLICY actor_insert ON approval_policies AS RESTRICTIVE FOR INSERT TO earshot_app
  WITH CHECK (created_by = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
-- Last, after the policies, so a run that stops partway leaves the app no access rather than access
-- to a table without RLS.
GRANT SELECT, INSERT ON TABLE approval_policies TO earshot_app;
