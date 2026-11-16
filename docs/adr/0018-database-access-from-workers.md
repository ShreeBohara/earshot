# ADR-0018: Database access from Workers: a `neon-serverless` pool for tenant transactions, `neon-http` for one-shot reads

## Status

Accepted (2026-11-15)

## Context and problem

Phase 1's health check needs a single read from Postgres inside a Worker. Phase 2 adds row-level security (RLS) keyed to a workspace that is set for each transaction (ADR-0019). Every piece of tenant work therefore runs in one transaction that first takes the tenant role and sets the workspace, then runs its queries on the same connection. That needs interactive transactions, which the simplest driver can't run.

## Considered options

- **`neon-http` (Drizzle's driver) for everything.** One HTTP request per query and no connection to manage, but no interactive transactions: its `transaction()` throws.
- **Drizzle's `neon-serverless` driver, a WebSocket `Pool` from `@neondatabase/serverless`.** It speaks the Postgres protocol over a WebSocket, so it runs interactive transactions from a Worker.
- **Hyperdrive with `pg`.** Cloudflare's connection pooler; the Workers free plan includes 100k queries a day. It adds a binding per environment and a second pooling layer in front of Neon's.

## Decision

Tenant work runs in an interactive transaction on Drizzle's `neon-serverless` driver. `packages/db` exports:

- **`createPoolDb(url)`**: a Drizzle database over a `Pool`. In a Worker, create one per request and end it when the request is done (`ctx.waitUntil(db.$client.end())`), because a WebSocket can't outlive the request that opened it.
- **`withTenant(db, { userId, workspaceId }, fn)`**: opens a transaction, runs `SET LOCAL ROLE earshot_app` and `select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)`, then returns `fn(tx)`. It takes any Postgres Drizzle database that runs interactive transactions: the pool in production, PGlite in tests.
- **`createHttpDb(url)`**, unchanged, on `neon-http`: for one-shot reads outside any tenant, such as the health check.

Migrations still use the direct, non-pooled URL. `scripts/migrate.ts` now runs them through the pool, so all pending migrations apply in one transaction. With `neon-http`, Drizzle's migrator sent one statement per request, with no transaction around them.

### Per request in the web Worker (Phase 2)

`apps/web/lib/db` turns this into what a request uses:

- **One pool per request.** `getDb()` creates a `createPoolDb` pool on first use and keys it by the request's `ExecutionContext`. OpenNext keeps the Cloudflare context in AsyncLocalStorage, so that context is unique to each request. Next's `after()` closes the pool once the response is sent, and OpenNext runs `after()` through `ctx.waitUntil`, so the Worker stays alive until the WebSocket has closed. The socket opens on the first query. Requests that never query open none: signed-out pages without a session cookie, the static replay demo, and the landing page.
- **Better Auth shares that pool rather than using `neon-http`.** Its Drizzle adapter runs with `transaction: true` (ADR-0006), so multi-step writes are atomic: an OAuth user with their account, consuming a magic link. `neon-http` can't run those transactions. Sharing also means one WebSocket per request serves the session check, `resolveWorkspace`, and `withTenant`, where `neon-http` for auth would add a second connection path to every signed-in request. Better Auth is built once per isolate, so it gets `requestScopedDb`, a proxy that resolves the current request's pool on every property access and never holds one across requests.
- **`createHttpDb` stays** for one-shot reads outside auth and tenants, such as the health check.

**Local development without a database.** Under `next dev` with no `DATABASE_URL`, the app runs PGlite in process, with pgvector and pg_trgm, the same extensions as Neon:

- It's persisted in `apps/web/.data/pglite/` (gitignored).
- Every migration is applied at startup.
- One instance is cached on `globalThis`, so hot reloads reuse it.
- With `DATABASE_URL` set, `next dev` uses one long-lived Neon pool instead, which a Node process can keep open across requests.

The development module is reached only through a dynamic import behind `process.env.NODE_ENV === "development"`. The production build replaces that with `false` and drops the branch, so PGlite never reaches the Worker. `build:worker` proves it on every build: `scripts/check-worker-bundle.mjs` scans `.open-next/` and fails on PGlite's file names, its class name, or the development module's markers. Tests use PGlite directly, the same way packages/db's tests do.

A production build must run in workerd, through `pnpm preview` or a deploy. `next start` shares one `ExecutionContext` across requests, so it would share, and then close, one pool. It isn't supported.

## Consequences

**Good**

- One driver package for both paths, and no extra Cloudflare binding or service.
- `SET LOCAL` and `set_config(…, true)` last only until the transaction ends, so they're safe behind Neon's transaction-mode pooler and can't leak into another request.
- A migration run that fails changes nothing, so the tenant-isolation migration can't half-apply.
- `withTenant` runs unchanged on PGlite, which is how the isolation tests exercise it.

**Bad**

- Opening a WebSocket costs more round trips than one HTTP query, on every request that does tenant work.
- Every request that creates a pool has to end it.
- There are two ways to reach the database. Code must pick the right one, and `withTenant` over `neon-http` fails at run time, not at compile time.
- Requests that touch the database pay the WebSocket handshake once each. Rate-limited auth endpoints add two or three queries for the limiter (ADR-0006).

## More information

Hyperdrive stays the fallback if WebSocket setup shows up in Phase 3's latency budget, along with a short session cookie cache, which would skip the session query on most requests. ADR-0019 covers the role, the policies, and the pgTAP tests, which run in PGlite in CI. Running them against each PR's Neon branch in the preview job is still to do.
