# ADR-0019: Tenant isolation with row-level security, proven by pgTAP in PGlite

## Status

Accepted (2026-11-15)

## Context and problem

Every workspace's transcripts, CRM mirror, encrypted keys, and audit trail share one Postgres database. One missing `where workspace_id = …`, or an id taken from a request without a check, would show one workspace another's data. Phase 2's gate is that user B sees none of user A's data, proven by tests (ADR-0005). The rule has to hold in the database, for every query, including the ones nobody reviewed.

## Considered options

- **Postgres row-level security (RLS) for a dedicated app role, keyed to a workspace set for each transaction.**
- Filtering in application code only: a `where workspace_id` on every query, perhaps through a wrapper. One forgotten filter leaks, and nothing proves the filters are there.
- A schema or database per workspace. It isolates strongly, but multiplies migrations and branches, and Neon's free tier caps branches and storage.
- RLS on the table owner (`FORCE ROW LEVEL SECURITY`). Migrations, seeds, and Better Auth would then need tenant settings or policy exceptions.

## Decision

**The role.** Migration 0004 creates `earshot_app` (NOLOGIN) if it doesn't exist, grants it to the migrating owner so that role can `SET ROLE` to it, and grants it schema `USAGE` and `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the tenant tables. `audit_log` gets only `SELECT` and `INSERT`, so the app can't change its history. Grants are explicit per table, with no default privileges, so a new table stays closed to the app until a migration opens it. The grants come last in the migration, after every policy. The owner owns every table and isn't subject to RLS. It runs migrations, seeds, Better Auth, and the few reads that span workspaces, such as finding a user's workspace before `withTenant`. `earshot_app` has no privileges on Better Auth's tables.

**The policy.** Every tenant table has `workspace_id uuid not null references workspaces(id) on delete cascade`, RLS enabled, and one policy, `tenant_isolation`, for `earshot_app`:

```sql
using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
```

`workspaces` has the same policy on `id`. The tenant tables are `workspaces`, `workspace_members`, `credentials`, `crm_connections`, `crm_entities`, `sessions`, `session_events`, `utterances`, `proposals`, `sync_jobs`, `commitments`, `facts`, and `audit_log`. `withTenant` (ADR-0018) also sets `app.user_id`; no policy uses it yet.

**Failing closed.** If `app.workspace_id` was never set in the session, `current_setting(…, true)` returns NULL. After a transaction that set it, the session's value reverts to an empty string, which `nullif` turns into NULL. Either way the comparison is NULL: the app sees no rows, and every insert or update fails the `with check`. A malformed value makes the `uuid` cast raise an error. `withTenant` sets the role and both settings for one transaction only, so nothing carries over to the next transaction on a pooled connection.

**Foreign keys match on `workspace_id`.** Foreign-key checks bypass RLS. With a plain `session_id` key, workspace A could attach a row to B's session if it knew the id. Every reference between tenant tables is composite, `(workspace_id, session_id) → sessions (workspace_id, id)` and so on, so a row can only point inside its own workspace. `proposals.target_entity_id` needs `ON DELETE SET NULL (target_entity_id)` (Postgres 15+), which drizzle-kit can't express, so that key is hand-written in migration 0004.

**Proof: pgTAP in PGlite.** pgTAP (`@electric-sql/pglite-pgtap`) runs inside PGlite, the WebAssembly build of Postgres, with pgvector and pg_trgm, on every CI run and with no database server. A Vitest harness applies the migrations, seeds workspaces A and B with a row in every tenant table, then runs each `packages/db/test/pgtap/*.sql` file in a fresh copy of that database. A file fails on any `not ok` line, a missing plan, or a plan mismatch, and the failure shows the TAP output. The six files hold 245 assertions:

- **Structure:** the role's attributes, RLS and exactly one policy on exactly the tenant tables, the policy text, exact grants, and composite keys.
- **Reads:** each workspace sees only its own rows, and the other workspace's ids return nothing.
- **Writes:** inserting or moving a row into B fails, A's updates and deletes of B's rows match nothing, and A can't point a row at one of B's.
- **Failing closed:** with no workspace set, or an empty one, the tables are empty and writes fail.
- **The audit log:** updates, deletes, and `TRUNCATE` are denied.
- **Membership:** `workspace_members` is isolated, and Better Auth's tables are closed to the app role.

The catalog checks also fail when someone adds a table with a `workspace_id` column but no RLS, or grants the app a table that RLS doesn't protect. A TypeScript test drives `withTenant` through Drizzle on PGlite.

**`session_events` isn't partitioned yet.** ADR-0004 and the plan call for monthly partitions. They wait for now, for four reasons:

- At Phase 2 volumes (tens of events per debrief) partitions buy nothing.
- Every unique key on a partitioned table must include the partition key, which would turn the `(session_id, seq)` primary key into `(session_id, seq, ts)` and weaken it.
- drizzle-kit doesn't manage partitions.
- Archiving old events to R2 (ADR-0004) may make partitions unnecessary.

Revisit at about 10 million rows or a few GB, or when retention needs to drop whole months cheaply.

## Consequences

**Good**

- Isolation holds for every query the app runs as `earshot_app`, including queries that forget a filter or trust an id from a request.
- The defaults are closed: no workspace setting, no rows; a new table, no access.
- The proof runs in seconds in CI without a server. Deliberately weakening the schema (turning RLS off, loosening a policy, using a plain foreign key, widening a grant, or adding an unprotected table) makes it fail.

**Bad**

- Tenant code has to go through `withTenant`, which costs a transaction and two extra statements per unit of work.
- RLS guards against mistakes, not hostile code. Anything holding the owner connection can `RESET ROLE` or skip `withTenant`, so the connection string remains the real secret.
- Unique keys that span workspaces (`sync_jobs.idempotency_key`, `session_events.id`) can reveal through a conflict that another workspace used a value, so they must stay unguessable, for example derived from random ids.
- HNSW indexes span all workspaces. A vector search ranks every workspace's rows and RLS filters afterwards, so a small workspace can get fewer than k results. Phase 4 should enable pgvector's iterative index scans (`hnsw.iterative_scan`) if recall suffers.
- On a sequential scan, the policy's `current_setting()` call runs once per row. Indexes that lead with `workspace_id` avoid most of that. Wrapping the expression in a scalar subquery is an option if profiling shows a cost.
- The app role can't read `user`, so showing names next to tenant data needs a separate read as the owner, or column grants later.

## More information

- The migration is `packages/db/migrations/0004_tenant_isolation.sql`, and `withTenant` is in `packages/db/src/tenant.ts`.
- Roles exist per Neon branch. Branches forked from `dev` inherit `earshot_app` along with the data, and the migration skips creating it when it already exists.
- Running the same pgTAP files against each PR's Neon branch in the preview job is still to do.
