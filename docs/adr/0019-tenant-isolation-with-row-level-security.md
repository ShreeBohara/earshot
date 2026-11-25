# ADR-0019: Tenant isolation with row-level security, proven by pgTAP in PGlite

## Status

Accepted (2026-11-15). Amended for Phase 5 (2026-11-25): three new tenant tables, each append-only for the app, and a hash chain on `audit_log` built by a trigger. See "Amendment: Phase 5" below.

## Context and problem

Every workspace's transcripts, CRM mirror, encrypted keys, and audit trail share one Postgres database. One missing `where workspace_id = …`, or an id taken from a request without a check, would show one workspace another's data. Phase 2's gate is that user B sees none of user A's data, proven by tests (ADR-0005). The rule has to hold in the database, for every query, including the ones nobody reviewed.

Within a workspace there are two more risks. A member who could write `workspace_members` could add a victim to their workspace or promote themselves. A member who could set a row's user column freely could record sessions or audit entries in someone else's name, even naming a user from another workspace.

## Considered options

- **Postgres row-level security (RLS) for a dedicated app role, keyed to a workspace and a user set for each transaction.**
- Filtering in application code only: a `where workspace_id` on every query, perhaps through a wrapper. One forgotten filter leaks, and nothing proves the filters are there.
- A schema or database per workspace. It isolates strongly, but multiplies migrations and branches, and Neon's free tier caps branches and storage.
- RLS on the table owner (`FORCE ROW LEVEL SECURITY`). Migrations, seeds, and Better Auth would then need tenant settings or policy exceptions.

## Decision

**The role.** Migration 0004 creates `earshot_app` (NOLOGIN) if it doesn't exist and grants it to the migrating owner, so that role can `SET ROLE` to it. It grants `earshot_app` schema `USAGE`, then per table:

- `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on most tenant tables.
- Only `SELECT` on `workspace_members`.
- Only `SELECT`, and `UPDATE` on the `name` column, on `workspaces`. The app can read and rename its workspace, but can't create or delete one, or change `id`, `created_at`, or any column added later.
- Only `SELECT` and `INSERT` on `audit_log`, so the app can't change its history.
- Only `SELECT` and `INSERT` on `session_events`, since migration 0009 revoked `UPDATE` and `DELETE`, so the event log is append-only too (ADR-0020). Deleting a session still deletes its events: `ON DELETE CASCADE` runs as the table's owner, not as the role that deleted the session.

Grants are explicit per table, with no default privileges, so a new table stays closed to the app until a migration opens it. They come last in the migration, after every policy. The owner owns every table and isn't subject to RLS. It runs migrations, seeds, Better Auth, membership changes, and the few reads that span workspaces. `earshot_app` has no privileges on Better Auth's tables.

**Membership is written only by trusted code on the owner connection.** At sign-up, the creator of a workspace becomes its owner. A later invite flow has to get the invited user's confirmation before it writes their membership. Before any tenant work, `resolveWorkspace(db, userId, requestedId?)` runs on the owner connection and picks the workspace. It returns `requestedId` if the user is a member of it, otherwise the user's oldest membership (`ORDER BY created_at, workspace_id`), otherwise null, so it never returns a workspace the user doesn't belong to. Its result is the only workspace id that goes into `withTenant`.

**The workspace policy.** Every tenant table has `workspace_id uuid not null references workspaces(id) on delete cascade`, RLS enabled, and a policy, `tenant_isolation`, for `earshot_app`:

```sql
using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
```

`workspaces` has the same policy on `id`. The tenant tables are `workspaces`, `workspace_members`, `credentials`, `crm_connections`, `crm_entities`, `sessions`, `session_events`, `utterances`, `proposals`, `sync_jobs`, `commitments`, `facts`, and `audit_log`.

**Actor binding.** `withTenant` (ADR-0018) requires a user id and sets it as `app.user_id` alongside the workspace. Two tables name a user, and both are bound to that setting:

- **Restrictive policies.** They apply on top of `tenant_isolation`:
  - On `sessions`, for `INSERT`, for `UPDATE` (in both `USING` and `WITH CHECK`), and for `DELETE` (in `USING`): `user_id = nullif(current_setting('app.user_id', true), '')`.
  - On `audit_log`, for `INSERT`: the same check on `actor_user_id`.

  A member can only record sessions and audit entries in their own name, and can only update or delete their own sessions. With no user set, neither table can be written. Reading is unaffected.
- **Composite foreign keys to `workspace_members`.** They make every named user a member of the row's workspace:
  - `sessions (workspace_id, user_id)`, `ON DELETE CASCADE`: removing a member removes their sessions there.
  - `audit_log (workspace_id, actor_user_id)`, `ON DELETE SET NULL (actor_user_id)` (Postgres 15+): an entry outlives the membership. drizzle-kit can't express that, so this key is hand-written in migration 0004.

Tenant tables reference `user` only through `workspace_members`.

**Trust model within a workspace.** Between workspaces, the database enforces isolation on every table. Within a workspace, it binds the actor only on `sessions` and `audit_log`. The rows under a session (`session_events`, `utterances`, `proposals`, `sync_jobs`) aren't bound to that session's user: any member of the workspace can write them through `withTenant`. That is deliberate, for now:

- Phase 2 has exactly one member per workspace. Only the `owner` role exists, and only trusted code writes membership, so there is no second member to guard against.
- Team workspaces arrive in a later phase, and there managers need to act on their reps' proposals. Per-member write rules get designed then, against those review flows. Adding policies now that look up each row's session owner with an `EXISTS` subquery would be wrong for those flows, and would cost a lookup per row.

**Migrations are immutable once merged.** After a migration reaches `main`, a schema change is a new migration, never an edit, because databases that already ran it would silently diverge from the file. Migration 0004 was edited before merge only because it has never run against any database: the branch was never pushed, and no Neon database exists yet. CI enforces the rule. On pull requests, the `checks` job fails if any existing `packages/db/migrations/*.sql` file is modified, renamed, or deleted relative to the base branch; new migrations and `meta/` changes pass.

**Failing closed.** If `app.workspace_id` was never set in the session, `current_setting(…, true)` returns NULL. After a transaction that set it, the session's value reverts to an empty string, which `nullif` turns into NULL. Either way the comparison is NULL: the app sees no rows, and every insert or update fails the `with check`. A malformed value makes the `uuid` cast raise an error. The same holds for `app.user_id` and the actor policies. `withTenant` sets the role and both settings for one transaction only, so nothing carries over to the next transaction on a pooled connection.

**Foreign keys match on `workspace_id`.** Foreign-key checks bypass RLS. With a plain `session_id` key, workspace A could attach a row to B's session if it knew the id. Every reference between tenant tables is composite, `(workspace_id, session_id) → sessions (workspace_id, id)` and so on, so a row can only point inside its own workspace. `proposals.target_entity_id` needs `ON DELETE SET NULL (target_entity_id)`, so that key is hand-written in migration 0004 too.

**Proof: pgTAP in PGlite.** pgTAP (`@electric-sql/pglite-pgtap`) runs inside PGlite, the WebAssembly build of Postgres, with pgvector and pg_trgm, on every CI run and with no database server. A Vitest harness applies the migrations and seeds workspaces A and B with a row in every tenant table. It then runs each `packages/db/test/pgtap/*.sql` file in a fresh copy of that database. A file fails on any `not ok` line, a missing plan, or a plan mismatch, and the failure shows the TAP output. The nine files hold 290 assertions:

- **Structure:** the role's attributes, RLS and the exact policies on exactly the tenant tables, the policy text, exact table and column grants, and composite keys.
- **Reads:** each workspace sees only its own rows, and the other workspace's ids return nothing.
- **Writes:** inserting or moving a row into B fails, A's updates and deletes of B's rows match nothing or are denied, and A can't point a row at one of B's.
- **Failing closed:** with no workspace set, or an empty one, the tables are empty and writes fail.
- **The audit log:** updates, deletes, and `TRUNCATE` are denied.
- **The event log:** updates, deletes, and `TRUNCATE` of `session_events` are denied, the app's own events included, and deleting a session, member, user, or workspace still removes the events under it.
- **Membership:** `workspace_members` is isolated and read-only to the app, and Better Auth's tables are closed to it, `rate_limit` (migration 0011) included.
- **Actors:**
  - Sessions and audit entries can't name another member, or nobody.
  - A member can update and delete their own sessions, but not another member's.
  - A user who isn't a member of the workspace fails the foreign keys.

The catalog checks also fail in three cases: a table has a `workspace_id` column but no RLS; the app is granted a table that RLS doesn't protect; or the app can write a table that names a member without an actor policy. TypeScript tests drive `withTenant` and `resolveWorkspace` through Drizzle on PGlite. They also check the cascades: removing a member or deleting a user removes their memberships and sessions, and clears their audit entries' actor.

**`session_events` isn't partitioned yet.** ADR-0004 and the plan call for monthly partitions. They wait for now, for four reasons:

- At Phase 2 volumes (tens of events per debrief) partitions buy nothing.
- Every unique key on a partitioned table must include the partition key. Adding `ts` to the `(session_id, seq)` primary key and the `(session_id, id)` unique index would weaken both.
- drizzle-kit doesn't manage partitions.
- Archiving old events to R2 (ADR-0004) may make partitions unnecessary.

Revisit at about 10 million rows or a few GB, or when retention needs to drop whole months cheaply.

## Consequences

**Good**

- Isolation holds for every query the app runs as `earshot_app`, including queries that forget a filter or trust an id from a request.
- A member can't change who belongs to a workspace, and every session and audit entry names the user who actually wrote it.
- The defaults are closed: no workspace or user setting, no rows and no writes; a new table, no access.
- The proof runs in seconds in CI without a server. Deliberately weakening the schema makes it fail, for example:
  - turning RLS off, or loosening or dropping a policy;
  - using a plain foreign key;
  - widening a grant;
  - adding an unprotected or unbound table.
- Databases that already ran a migration can't drift from its file: merged migrations never change, and CI rejects pull requests that edit them.

**Bad**

- Tenant code has to go through `resolveWorkspace` and `withTenant`, which costs a lookup and a transaction with two extra statements per unit of work.
- Creating workspaces, deleting them, and changing membership need their own owner-connection code paths: the sign-up hook, account deletion, and a future invite flow.
- A member can't update or delete a teammate's session. Background jobs that do must act as the session's user, or run as the owner.
- Within a workspace, rows under a session aren't bound to its user. That's moot while each workspace has one member, but team workspaces must close it, with rules designed for their review flows.
- Removing a member deletes their sessions in that workspace. Audit entries survive with the actor cleared, and the app role can't write entries without an actor, so system entries are written as the owner.
- RLS guards against mistakes, not hostile code. Anything holding the owner connection can `RESET ROLE` or skip `withTenant`, so the connection string remains the real secret.
- A unique key that spans workspaces (`sync_jobs.idempotency_key`) can reveal through a conflict that another workspace used a value, so it must stay unguessable, for example derived from random ids. Event ids avoid this: they're unique per session, not globally.
- HNSW indexes span all workspaces. A vector search ranks every workspace's rows and RLS filters afterwards, so a small workspace can get fewer than k results. Phase 4 should enable pgvector's iterative index scans (`hnsw.iterative_scan`) if recall suffers.
- On a sequential scan, the policies' `current_setting()` calls run once per row. Indexes that lead with `workspace_id` avoid most of that. Wrapping the expression in a scalar subquery is an option if profiling shows a cost.
- The app role can't read `user`, so showing names next to tenant data needs a separate read as the owner, or column grants later.

## Amendment: Phase 5 (2026-11-25)

Phase 5 adds three tenant tables, all append-only for the app, and changes how `audit_log` is written. There are now 16 tenant tables.

| Table | Migration | What it holds | For the app |
|---|---|---|---|
| `audit_checkpoints` | 0013 (ADR-0033) | One Ed25519 signature over the workspace's chain head per review request, flush with reviews, policy change, and export | `SELECT` and `INSERT`; `(workspace_id, chain_seq)` references the chain row it signs, so even the owner can't delete a signed row without deleting its checkpoint first |
| `approval_policies` | 0016 (ADR-0034) | One row per version of a workspace's approval policy | `SELECT` and `INSERT`; a RESTRICTIVE `actor_insert` binds `created_by` to `app.user_id`, and a composite key to `workspace_members` with `ON DELETE SET NULL (created_by)`, as `audit_log`'s actor has |
| `crm_entity_changes` | 0017 (ADR-0008) | One row per change to a field of a mirror record | `SELECT` and `INSERT`; `(workspace_id, entity_id)` references `crm_entities`, so a change can't name another workspace's record, and cascades with it |

- **The same policy.** Each has `tenant_isolation` on `workspace_id`, and fails closed the same way. `approval_policies` is the third table to bind a user column to `app.user_id`, after `sessions` and `audit_log`.
- **The audit chain** (migration 0013). `audit_log` gains `chain_seq`, `prev_hash`, and `entry_hash`, filled by a `BEFORE INSERT` trigger that runs as the table's owner (`SECURITY DEFINER`, `search_path` pinned) and overwrites whatever the app sends, so the app still can only read and append, and can't choose a seq, a hash, or a time. `audit_chain_verify` runs as the invoker, so for the app RLS confines it to its own workspace. `PUBLIC` can run none of the chain's functions; the app may run `audit_entry_canonical` and `audit_chain_verify`.
- **New columns on existing tables** keep their table's policy: `sessions.sealed_at`, `focus_entity_id` (a composite key to the workspace's `crm_entities` that clears when the record goes), and `recap`; the review columns on `proposals` with `supersedes`, `superseded_by`, and `followups`; and `utterances.input`. Better Auth's `session` table gains `sign_in_method`, still closed to the app.
- **The proof.** pgTAP grows from nine files to 13, and from 290 assertions to 411: `90_audit_chain.sql` (50: the trigger overwrites the chain columns, updates, deletes, and `TRUNCATE` still fail, seqs run per workspace, an owner's edit, deletion, or reordering fails the check at that seq, and checkpoints are append-only and isolated), `95_seal_and_reviews.sql` (9: the focus account stays in its workspace, and the statuses and review modes are checked), `96_approval_policies.sql` (17), and `97_crm_entity_changes.sql` (14). The structure file's catalog checks cover all 16 tables' RLS, policies, and grants.
- **Within a workspace,** the trust model is unchanged: one member per workspace in Phase 5. Two things wait for team workspaces: any member could change the workspace's policy after the step-up (ADR-0034), and clearing a departed member's actor on `audit_log` would change their rows' canonical text, a false alarm in the chain's check (ADR-0033's must-fix).

## More information

- The policies, grants, and hand-written keys are in `packages/db/migrations/0004_tenant_isolation.sql`; `withTenant` and `resolveWorkspace` are in `packages/db/src/tenant.ts`.
- Roles exist per Neon branch. Branches forked from `dev` inherit `earshot_app` along with the data, and the migration skips creating it when it already exists.
- Running the same pgTAP files against each PR's Neon branch in the preview job is still to do.
- The migration guard is the "Merged migrations are unchanged" step of the `checks` job in `.github/workflows/ci.yml`.
