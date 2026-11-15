# ADR-0018: Database access from Workers: `neon-http` for one-shot reads now; Phase 2 chooses the transaction path for RLS

## Status

Proposed; decided in Phase 2

## Context and problem

Phase 1's health check needs a single read from Postgres inside a Worker. Phase 2 adds row-level security (RLS) keyed to the current user for each transaction. That needs interactive transactions, which the simplest driver can't run.

## Considered options

- **`neon-http` (Drizzle's driver) for one-shot reads.** Suits the health check but can't run interactive transactions.
- **Drizzle's `neon-serverless` WebSocket pool.** The expected default for Phase 2.
- **Hyperdrive with `pg`.** The alternative. The Workers free plan includes Hyperdrive (100k queries a day).

## Decision

For now, `packages/db` exports `createHttpDb(url)`, built on `neon-http`, used for the health check. Phase 2 will choose the transaction-capable path, defaulting to the `neon-serverless` pool, with Hyperdrive plus `pg` as the alternative. This ADR stays Proposed until then.

Migrations are not affected: they always use the direct, non-pooled URL.

## Consequences

**Good**

- Phase 1 stays small and avoids a decision that needs the real schema.
- The two Phase 2 candidates are already named, so the choice can be tested against real RLS work.

**Bad**

- Phase 2 must make this choice early, because RLS depends on it.
- Code written against `neon-http` can't be reused for transactional paths.
- Until the decision, ADR-0005's RLS plan has an open dependency.

## More information

Phase 2 also adds pgTAP tests that run against each PR's database branch in the preview job.
