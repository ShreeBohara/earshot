-- Tenant isolation with row-level security (docs/adr/0019). Hand-written, because drizzle-kit
-- doesn't generate roles, grants, or these policies. Each statement has its own breakpoint:
-- the migrator runs one prepared statement per chunk.
--
-- The owner (the role that runs migrations and seeds, and that the app connects as) owns every
-- table, so RLS doesn't apply to it. Tenant work runs inside withTenant() in src/tenant.ts,
-- which does SET LOCAL ROLE earshot_app and sets app.user_id and app.workspace_id for one
-- transaction. Every tenant_isolation policy compares workspace_id with app.workspace_id; when
-- that setting is missing or empty the comparison is NULL, so the app sees no rows and can write
-- none. Restrictive actor policies bind the user a row names to app.user_id the same way.

-- The role the app takes for tenant work. NOLOGIN: nobody connects as it. Roles belong to the
-- whole cluster, not one database, so create it only if it doesn't exist yet.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'earshot_app') THEN
    CREATE ROLE earshot_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
-- Lets the migrating owner, which is also the role the app connects as, SET ROLE earshot_app.
GRANT earshot_app TO CURRENT_USER;
--> statement-breakpoint
-- workspaces is the tenant itself, so its policy compares id rather than workspace_id. The app
-- may read and rename its own workspace; creating and deleting workspaces, like changing
-- membership, is left to trusted code on the owner connection.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON workspaces TO earshot_app
  USING (id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON workspace_members TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON credentials TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE crm_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON crm_connections TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE crm_entities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON crm_entities TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sessions TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON session_events TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE utterances ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON utterances TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON proposals TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE sync_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sync_jobs TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE commitments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON commitments TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON facts TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_log TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Actor binding. A row that names a user must name the transaction's own user, app.user_id, so
-- a member can't record a session or an audit entry in someone else's name. RESTRICTIVE: these
-- apply on top of tenant_isolation, and a missing or empty app.user_id fails them. A member may
-- only update or delete their own sessions; reading is unaffected. Rows under a session (events,
-- utterances, proposals, sync jobs) aren't bound to its user: see docs/adr/0019's trust model.
CREATE POLICY actor_insert ON sessions AS RESTRICTIVE FOR INSERT TO earshot_app
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
CREATE POLICY actor_update ON sessions AS RESTRICTIVE FOR UPDATE TO earshot_app
  USING (user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
CREATE POLICY actor_delete ON sessions AS RESTRICTIVE FOR DELETE TO earshot_app
  USING (user_id = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
CREATE POLICY actor_insert ON audit_log AS RESTRICTIVE FOR INSERT TO earshot_app
  WITH CHECK (actor_user_id = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
-- Foreign keys between tenant tables include workspace_id (see src/schema), because foreign-key
-- checks bypass RLS: with a plain key, workspace A could attach a row to B's session. This one
-- lives here because drizzle-kit can't express SET NULL for one column (Postgres 15+): deleting
-- an entity clears the proposal's target and leaves workspace_id alone.
ALTER TABLE proposals ADD CONSTRAINT proposals_target_entity_fk
  FOREIGN KEY (workspace_id, target_entity_id) REFERENCES crm_entities (workspace_id, id)
  ON DELETE SET NULL (target_entity_id);
--> statement-breakpoint
-- An audit entry's actor must be a member of the entry's workspace. For the same reason this key
-- is hand-written: when the membership goes, the entry stays and only the actor is cleared.
-- (sessions has the matching key, ON DELETE CASCADE, in src/schema.)
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_fk
  FOREIGN KEY (workspace_id, actor_user_id) REFERENCES workspace_members (workspace_id, user_id)
  ON DELETE SET NULL (actor_user_id);
--> statement-breakpoint
-- Grants come last, after every policy is in place, so a run that stops partway leaves the
-- app with no access rather than access to a table without RLS.
GRANT USAGE ON SCHEMA public TO earshot_app;
--> statement-breakpoint
-- Explicit grants per table, and no default privileges: a new table stays closed to the app
-- until a migration grants it, which should come with RLS and a policy.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  credentials,
  crm_connections,
  crm_entities,
  sessions,
  session_events,
  utterances,
  proposals,
  sync_jobs,
  commitments,
  facts
TO earshot_app;
--> statement-breakpoint
-- Membership decides which workspace a user may act in, so the app can only read it, and can
-- only read and rename its workspace. Otherwise a member could add anyone to their workspace,
-- or promote themselves. UPDATE is granted on the name column alone, so the app can't change
-- the id or created_at, or any column added later.
GRANT SELECT, UPDATE (name) ON TABLE workspaces TO earshot_app;
--> statement-breakpoint
GRANT SELECT ON TABLE workspace_members TO earshot_app;
--> statement-breakpoint
-- The audit log is append-only for the app.
GRANT SELECT, INSERT ON TABLE audit_log TO earshot_app;
--> statement-breakpoint
-- No tenant table uses a sequence today (ids are random UUIDs, so they leak nothing about other
-- workspaces). This covers sequences that exist now; a later one needs its own grant.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO earshot_app;
