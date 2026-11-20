-- The audit chain, signed checkpoints, and the sign-in method (Phase 5 WP2, docs/adr/0033).
-- drizzle-kit generated the tables, columns, and constraints from src/schema; the rest is by hand,
-- because drizzle-kit can't express it: the chain columns are added nullable, filled for the rows
-- that exist, and only then made NOT NULL; the canonical text, the trigger that chains each new
-- row, and the check; and audit_checkpoints' row-level security and grants. Each statement has
-- its own breakpoint: the migrator runs one prepared statement per chunk.
CREATE TABLE "audit_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chain_seq" bigint NOT NULL,
	"entry_hash" "bytea" NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"kid" text NOT NULL,
	"signature" "bytea" NOT NULL,
	"request" text NOT NULL,
	CONSTRAINT "audit_checkpoints_request_check" CHECK ("audit_checkpoints"."request" in ('review', 'flush', 'policy')),
	CONSTRAINT "audit_checkpoints_chain_seq_check" CHECK ("audit_checkpoints"."chain_seq" > 0),
	CONSTRAINT "audit_checkpoints_entry_hash_check" CHECK (octet_length("audit_checkpoints"."entry_hash") = 32),
	CONSTRAINT "audit_checkpoints_signature_check" CHECK (octet_length("audit_checkpoints"."signature") = 64),
	CONSTRAINT "audit_checkpoints_kid_check" CHECK ("audit_checkpoints"."kid" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
);
--> statement-breakpoint
-- Nullable for now: the rows that exist get their values from the backfill below.
ALTER TABLE "audit_log" ADD COLUMN "chain_seq" bigint;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "prev_hash" "bytea";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "entry_hash" "bytea";--> statement-breakpoint
-- How each sign-in happened (Better Auth's session row). Sessions that exist are 'unknown'.
ALTER TABLE "session" ADD COLUMN "sign_in_method" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
-- The text each row's hash covers, used by the trigger, the check, and the export alike, so a
-- verifier outside Postgres hashes the same bytes: a JSON array of the form version (1), the
-- workspace, the seq, the actor, the action, the subject's type and id, the detail, and the time.
-- Every part has a fixed rendering that no server setting changes: the uuid and text columns as
-- JSON strings (lowercase uuid; JSON escapes for '"', '\', and control characters; anything else
-- as UTF-8), the seq as an integer, the detail in jsonb's own text form (keys ordered by length,
-- then bytes; ": " and ", " between parts; numbers as stored), and the time with to_char in UTC,
-- to the microsecond, rather than through DateStyle or TimeZone. json_build_array joins the parts
-- with ", ".
CREATE FUNCTION public.audit_entry_canonical(r public.audit_log) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT json_build_array(
    1,
    r.workspace_id::text,
    r.chain_seq,
    r.actor_user_id,
    r.action,
    r.subject_type,
    r.subject_id,
    r.detail,
    to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )::text
$$;
--> statement-breakpoint
-- Chains the rows that exist: per workspace, in (at, id) order, from 32 zero bytes. Key changes,
-- demo CRM loads, and account events from before this migration all get a place in the chain.
DO $$
DECLARE
  r public.audit_log;
  current_workspace uuid;
  seq bigint;
  prev bytea;
BEGIN
  FOR r IN SELECT * FROM public.audit_log ORDER BY workspace_id, at, id LOOP
    IF current_workspace IS DISTINCT FROM r.workspace_id THEN
      current_workspace := r.workspace_id;
      seq := 0;
      prev := decode(repeat('00', 32), 'hex');
    END IF;
    seq := seq + 1;
    r.chain_seq := seq;
    r.prev_hash := prev;
    r.entry_hash := sha256(prev || convert_to(public.audit_entry_canonical(r), 'UTF8'));
    UPDATE public.audit_log
      SET chain_seq = r.chain_seq, prev_hash = r.prev_hash, entry_hash = r.entry_hash
      WHERE id = r.id;
    prev := r.entry_hash;
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE "audit_log"
  ALTER COLUMN "chain_seq" SET NOT NULL,
  ALTER COLUMN "prev_hash" SET NOT NULL,
  ALTER COLUMN "entry_hash" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_chain_seq_unique" UNIQUE("workspace_id","chain_seq");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_chain_seq_check" CHECK ("audit_log"."chain_seq" > 0);--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_prev_hash_check" CHECK (octet_length("audit_log"."prev_hash") = 32);--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_entry_hash_check" CHECK (octet_length("audit_log"."entry_hash") = 32);--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_sign_in_method_check" CHECK ("session"."sign_in_method" in ('passkey', 'magic_link', 'github', 'google', 'unknown'));--> statement-breakpoint
ALTER TABLE "audit_checkpoints" ADD CONSTRAINT "audit_checkpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- After the unique key it references. A checkpoint names a row in its own workspace's chain, and
-- that row can't be deleted while the checkpoint exists (deleting the workspace removes both).
ALTER TABLE "audit_checkpoints" ADD CONSTRAINT "audit_checkpoints_chain_fk" FOREIGN KEY ("workspace_id","chain_seq") REFERENCES "public"."audit_log"("workspace_id","chain_seq") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_checkpoints_workspace_id_chain_seq_idx" ON "audit_checkpoints" USING btree ("workspace_id","chain_seq");--> statement-breakpoint
-- Chains every new row. SECURITY DEFINER, so it reads the true head whoever inserts (the tenant
-- role's RLS would otherwise decide what it sees), with search_path pinned and every name
-- qualified. It overwrites whatever the insert sent for chain_seq, prev_hash, at, and entry_hash.
-- The advisory lock serializes writers per workspace until their transactions end; after waiting
-- for it, the read below takes a fresh snapshot (READ COMMITTED), so it sees the row the last
-- holder committed. A writer at a stricter isolation level would collide on the unique key instead
-- of forking the chain.
CREATE FUNCTION public.audit_log_chain() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  head_seq bigint;
  head_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('earshot.audit:' || NEW.workspace_id::text, 0));
  SELECT a.chain_seq, a.entry_hash INTO head_seq, head_hash
    FROM public.audit_log a
    WHERE a.workspace_id = NEW.workspace_id
    ORDER BY a.chain_seq DESC
    LIMIT 1;
  NEW.chain_seq := coalesce(head_seq, 0) + 1;
  NEW.prev_hash := coalesce(head_hash, decode(repeat('00', 32), 'hex'));
  NEW.at := now();
  NEW.entry_hash := sha256(NEW.prev_hash || convert_to(public.audit_entry_canonical(NEW), 'UTF8'));
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_chain BEFORE INSERT ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_chain();
--> statement-breakpoint
-- The first seq at which a workspace's chain doesn't hold, or NULL if it does: a missing seq (a
-- deleted or moved row), a prev_hash that isn't the previous row's entry_hash, or an entry_hash
-- that isn't the hash of the row as it stands (an edit). Then every checkpoint must name a row
-- that is still there with the hash it signed, which catches a chain rewritten from some row on.
-- SECURITY INVOKER: as the tenant role, RLS limits it to the transaction's own workspace.
CREATE FUNCTION public.audit_chain_verify(workspace uuid) RETURNS bigint
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r public.audit_log;
  expected bigint := 1;
  prev bytea := decode(repeat('00', 32), 'hex');
  bad_row bigint;
  bad_checkpoint bigint;
BEGIN
  FOR r IN
    SELECT * FROM public.audit_log a WHERE a.workspace_id = workspace ORDER BY a.chain_seq
  LOOP
    IF r.chain_seq <> expected THEN
      bad_row := expected;
      EXIT;
    END IF;
    IF r.prev_hash IS DISTINCT FROM prev
      OR r.entry_hash IS DISTINCT FROM
        sha256(r.prev_hash || convert_to(public.audit_entry_canonical(r), 'UTF8')) THEN
      bad_row := r.chain_seq;
      EXIT;
    END IF;
    prev := r.entry_hash;
    expected := expected + 1;
  END LOOP;
  SELECT min(c.chain_seq) INTO bad_checkpoint
    FROM public.audit_checkpoints c
    WHERE c.workspace_id = workspace
      AND NOT EXISTS (
        SELECT FROM public.audit_log a
        WHERE a.workspace_id = c.workspace_id
          AND a.chain_seq = c.chain_seq
          AND a.entry_hash = c.entry_hash
      );
  RETURN least(bad_row, bad_checkpoint);
END
$$;
--> statement-breakpoint
-- New functions are executable by PUBLIC by default. Only what needs them may run them: the app
-- builds exports with the canonical text and may check its own workspace's chain. The trigger
-- function is never called directly (EXECUTE isn't checked when a trigger fires).
REVOKE ALL ON FUNCTION public.audit_entry_canonical(public.audit_log) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.audit_log_chain() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.audit_chain_verify(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.audit_entry_canonical(public.audit_log) TO earshot_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.audit_chain_verify(uuid) TO earshot_app;--> statement-breakpoint
-- Checkpoints are a tenant table with the audit log's rules (docs/adr/0019).
ALTER TABLE audit_checkpoints ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_checkpoints TO earshot_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Last, after the policy, so a run that stops partway leaves the app no access rather than access
-- to a table without RLS. Append-only for the app, like audit_log.
GRANT SELECT, INSERT ON TABLE audit_checkpoints TO earshot_app;
