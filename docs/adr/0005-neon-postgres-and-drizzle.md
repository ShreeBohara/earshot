# ADR-0005: Neon Postgres and Drizzle, with RLS, pgvector, and pg_trgm

## Status

Accepted (2026-11-15)

## Context and problem

Earshot needs relational data, vector search for entity linking and memory, fuzzy name matching, and tenant isolation, on a free or near-free tier. It also needs a cheap way to give every pull request its own database.

## Considered options

- **Neon Postgres with Drizzle.**
- Supabase, whose free tier pauses after 7 days idle.
- A separate vector database next to a relational one.

## Decision

Use Neon Postgres, with Drizzle for schema and migrations. pgvector covers embeddings, pg_trgm covers trigram similarity, and row-level security (RLS) isolates tenants, to be proven with pgTAP tests in Phase 2.

Neon's free tier doesn't pause the project, and database branches make per-PR databases possible (ADR-0017). In Phase 1, `production` is the root branch and `dev` is a seed-only child. Migrations always use the direct, non-pooled URL. The extensions are created by a custom Drizzle migration, because drizzle-kit doesn't generate extension statements.

## Consequences

**Good**

- One database covers relational, vector, and fuzzy search.
- A branch per PR, forked from `dev`.
- Paid usage at about 1,000 users is estimated at $5–15 a month.

**Bad**

- Free-tier limits: 10 branches per project, 1 GB per project, and scale-to-zero after 5 minutes that can't be turned off.
- Worker-to-Postgres access needs care. ADR-0018 covers the transaction path RLS needs.
- Tied to one vendor's branching feature.

## More information

Phase 1 has one table, `app_meta`, and a health check that reads the branch name from the database.
