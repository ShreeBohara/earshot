# ADR-0020: Event store: an append-only log per session, upcasting on read, pure projections, and JSONL files

## Status

Accepted (2026-11-15)

## Context and problem

ADR-0004 chose event sourcing for sessions, and Phase 2 builds the store. It has to:

- keep each session's events in order, and refuse a write when two writers race (for example `SessionDO` and the Queue consumer that flushes to Postgres);
- keep loading old events after their schemas change. The first change is already here: `utterance.final` v2 records which witness heard the utterance;
- rebuild the `sessions`, `utterances`, and `proposals` tables exactly, every time. That is the Phase 2 gate;
- move sessions in and out as files, for the public replay demo, test fixtures, and the lab.

The `session_events` table arrives with the schema PR: `workspace_id`, `session_id`, `seq`, `type`, `schema_version`, `payload`, and `ts`, with primary key `(session_id, seq)`.

## Considered options

- Order and concurrency: **a contiguous `seq` per session, checked against the writer's expected last seq**; ordering by timestamp or UUIDv7; one global sequence; last write wins.
- Old events: **upcasters, applied on read, one version at a time**; rewriting stored events in a migration; projections that handle every version.
- Projections: **pure folds over validated events at the latest version**; handlers that update tables as events arrive and keep their own state.
- Interchange: **JSONL, one canonical event per line**; one JSON array per session; Avro or Protobuf; SQL dumps.
- Storage: **in memory now, Postgres next, with no partitions**; partitioning `session_events` by month now, as ADR-0004 planned.

## Decision

**An append-only log with `seq` per session.** `EventStore.append(sessionId, expectedLastSeq, events)` writes all of the events or none of them, numbered from the session's last seq plus one. Seq starts at 0, and `NO_EVENTS` (-1) is the expected last seq of a new session. If the log ends anywhere else, `append` throws a `ConcurrencyError`. Its reason is `stale` when another writer got there first, and `gap` when the writer is ahead of the log, which would leave a hole. A writer that numbers events itself, as `SessionDO` will before it flushes a batch, passes `seq` on each event, and the store checks every one. Events are validated against their payload schema and stored exactly as written. Nothing in the log is updated or deleted. `read(sessionId, fromSeq?)` returns events in seq order.

**Versioned payloads, upcast on read.** Each payload contract in `@earshot/core` is keyed by an event `type` and a `schemaVersion`, and its JSON Schema export records both as `x-event-type` and `x-schema-version`. The payload doesn't repeat them, because the envelope (and the table) already carries both, and `proposal.created` uses `type` for the kind of proposal. The registry in `@earshot/events` maps each `(type, schemaVersion)` to its schema and chains upcasters. An upcaster takes an event and returns it one version higher, changing only `schemaVersion` and `payload`. The registry refuses to build if any version below the latest has no upcaster, so a broken chain fails when the module loads, not when an old session is replayed. The first upcaster moves `utterance.final` v1 to v2 with `witness: "biased"`, because v1 predates the second witness.

**Projections are pure folds.** `replay(events, projections)` first checks every envelope, and checks that the events are one session numbered 0, 1, 2, and so on, with unique ids. It then upcasts every event to the latest version and validates it, and only then folds the events, in seq order, into each projection. A projection is `(state, event) → state`, with no I/O, no clock, and no randomness; times come from event timestamps. Earshot ships three: `sessionProjection` (status, mode, timings, cost), `utterancesProjection`, and `proposalsProjection` (proposals with their evidence and review status). An event type the registry doesn't know fails the replay, unless the caller passes `allowUnknownTypes`, in which case projections never see it. A newer version of a known type always fails, because skipping it would drop data silently.

**JSONL is the interchange format.** `toJsonl` writes one event per line, in a canonical form: envelope fields in a fixed order and payload keys sorted. The same events then give the same bytes whether they come from memory or from Postgres `jsonb`, which reorders keys. `fromJsonl` validates each line against `EventEnvelope` and against the payload schema for its type and version, and its errors cite the line number. Events keep their stored version in both directions. The first session file is `packages/events/fixtures/demo-session.jsonl`, a 40-second debrief that drives the Phase 3 replay demo. Its projections are committed next to it, and a test fails if replay stops reproducing them byte for byte.

**In memory, and Postgres.** `InMemoryEventStore` serves tests, the replay demo, and local sessions. `PgEventStore` in `packages/db` implements the same interface on `session_events`, and one contract suite, `describeEventStoreContract` in `@earshot/events/testing`, runs against both:

- `append` is one transaction: lock the session, read its `max(seq)`, compare it with `expectedLastSeq`, and insert the rows. The primary key `(session_id, seq)` backs up the check, and the store reports a clash on it as a `ConcurrencyError`.
- `read` is a range scan on the primary key, ordered by `seq`.
- `workspace_id` comes from the store's transaction context, which RLS sets, so the interface doesn't carry it.

"Postgres store" below has the details.

**No partitioning yet.** In Postgres, a primary key on a partitioned table must include the partition key. Monthly partitions on `ts` would therefore break the `(session_id, seq)` key that the concurrency check relies on. One table is plenty at Phase 2 volumes. This replaces ADR-0004's "partitioned by month" for now. Revisit it when the table grows large, together with archiving old sessions to R2.

## Postgres store

`PgEventStore(db, tenant)` in `packages/db` takes `createPoolDb` or PGlite, as `withTenant` does, and passes the same contract tests as `InMemoryEventStore`, run against PGlite. Migrations 0007 and 0008 add the columns it needs.

**Transaction shape.** `PgEventStore` runs each `append` and `read` in its own `withTenant` transaction. `appendEvents(tx, …)`, `readEvents(tx, …)`, and `rebuildProjections(tx, …)` take a transaction the caller already holds, so it can append and project together. An append makes these statements, after `withTenant`'s `SET LOCAL ROLE` and `set_config`:

1. `select pg_advisory_xact_lock(hashtextextended('earshot.session:' || session_id, 0))`. The lock lasts until the transaction ends, so appends and rebuilds of one session run one at a time. Under READ COMMITTED each statement takes a fresh snapshot, so the next writer reads the log only after the previous one committed. Checking and inserting then act as one step, as in memory, and the loser of a race gets the usual `ConcurrencyError` with the true last seq. The loser would have waited for the winner's commit at the primary key anyway, so the lock costs a round trip, not extra waiting. Any role may take advisory locks.
2. One query for the session's `max(seq)` and whether its `sessions` row is in the workspace. RLS filters both tables, so another workspace's session looks like no session.
3. If `expectedLastSeq` matches, which of the batch's ids the session already has.
4. No statement: `prepareAppend` from `@earshot/events`, the same checks in the same order as `InMemoryEventStore`, then the Postgres-only refusals below.
5. One multi-row `INSERT`, with `workspace_id` taken from `app.workspace_id`, never from the caller.

A read is one range scan on the primary key. Events come back frozen, as they do from memory.

**Errors.** Both stores run `prepareAppend`, so every batch the in-memory store refuses, the Postgres store refuses with the same error and message. Beyond that:

| Case | Error |
| --- | --- |
| A non-empty batch for a session with no `sessions` row in the workspace, missing or another workspace's | `UnknownSessionError`, before the insert |
| `23505` on `session_events_session_id_seq_pk`: a writer that skipped the lock committed first | `ConcurrencyError`, `stale`. `actualLastSeq` is the batch's first seq, a lower bound, because the aborted transaction can't read the log again |
| `23505` on `session_events_session_id_id_unique` | `StreamError` |
| `23503` on `session_events_session_fk`: the session was deleted after the check | `UnknownSessionError` |
| An `id` or `sessionId` with uppercase hex, which a uuid column returns in lowercase | `EventValidationError` |
| A `ts` in year 0000, which Postgres's calendar lacks | `EventValidationError` |
| A payload string or key with U+0000 or an unpaired surrogate, which `jsonb` refuses | `EventValidationError` |

The session check comes before the insert, not from the foreign key, because Postgres checks the primary key first: workspace B appending at seq 0 of A's session would clash with A's event and learn that the session has events. Ids match exactly, as map keys do in memory, so reading an uppercase session id returns nothing. Other driver errors pass through unchanged. If the insert fails, the transaction is aborted, so the caller must let it roll back.

**`ts`.** `session_events.ts` is a `timestamptz`, which keeps the instant but not how it was written: the offset and the precision. Migration 0007 adds `ts_text`, set only when the written `ts` isn't in the canonical form `YYYY-MM-DDTHH:MM:SS.sssZ`. That's what `Date.prototype.toISOString` writes, and what Earshot's writers send. A check constraint holds `ts_text` to the same instant as `ts`. A read returns `coalesce(ts_text, to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`, so a canonical `ts` costs nothing extra and any other comes back byte for byte. Postgres parses `ts` from the string, not from a JS `Date`, so the instant keeps microseconds. `jsonb` reorders keys but keeps values: JavaScript writes each number as the shortest decimal that parses back to the same double, and `numeric` keeps every digit. With `toJsonl` sorting keys, `fromJsonl`, append, read, and `toJsonl` reproduce `demo-session.jsonl` byte for byte. JSON itself still turns `-0` into `0` and drops keys whose value is `undefined`.

**Projection rebuild.** `rebuildProjections(tx, sessionId)` takes the same lock, checks that the session is in the workspace, reads the log, runs `replay` with the default projections, and writes the result. It writes no clock values, so running it again writes identical rows.

- `utterances` are deleted and inserted. `id` is the event's `utteranceId`, which evidence points at.
- `proposals` are upserted by `id`, the `proposalId`, within the same session, and the session's other proposals are deleted. A delete would cascade to `sync_jobs`. A proposal id that another session holds is an error, not a row to take over.
- The `sessions` row gets `mode`, `engine`, `providers`, `started_at`, `ended_at`, and `cost_usd`. Status and duration follow from `ended_at`, and the last seq and its time are in `session_events`.

Migration 0008 lets the tables hold the projections exactly: `utterances.ts`; `utterances.words` made nullable, because null (the provider sent no timings) differs from `[]`; `utterances.confidence` widened from `real`, which keeps about seven significant digits, to `double precision`; and `proposals.seq`, `reviewed_seq`, and `reviewed_at`. `proposals.created_at` holds the `proposal.created` timestamp and `updated_at` the latest review's. Risk flags go into the existing `text[]` as `kind`, or `kind:field` for a flag on one field. Two values are adjusted: a target entity that isn't in the workspace's CRM mirror is stored as null, as `ON DELETE SET NULL` would leave it, and a missing cost is stored as `cost_usd` 0, rounded to four places like any cost. Tests check that the demo session's rows read back as `demo-session.projections.json`, and that deleting the rows and rebuilding restores them exactly.

**What Phase 3's `SessionDO` flush calls.** One transaction per batch:

```ts
await withTenant(db, { userId, workspaceId }, async (tx) => {
  await appendEvents(tx, sessionId, lastFlushedSeq, batch);
  await rebuildProjections(tx, sessionId);
});
```

- Number the drafts (`seq`) before flushing, and pass the last seq Postgres acknowledged as `expectedLastSeq`, so the store checks every seq.
- Create the `sessions` row when the session starts. Until it exists, the session takes no events.
- On a `stale` `ConcurrencyError`, read from `expectedLastSeq + 1`. If those ids are the batch's, an earlier attempt committed and only its reply was lost. Otherwise another writer is active, and the DO stops and resyncs.
- Run as the session's own user. If RLS lets the transaction read the session row but not update it, `rebuildProjections` throws rather than leave the summary columns stale.
- A full rebuild per flush is cheap for a debrief's tens of events. Long conversations should rebuild at the end and after reviews, or get incremental projections.
- Because the rebuild shares the flush's transaction, the projections never lag the log, and a batch that `replay` refuses (a review of an unknown proposal, say) is rolled back. That's a bug in the batch, so don't retry it.

## Consequences

**Good**

- Replaying a session file rebuilds identical projections, and CI checks it against a committed snapshot.
- Old events keep loading. A schema change ships as a new version plus an upcaster, and a missing link fails fast.
- A racing or stale writer gets a `ConcurrencyError`, so writes never interleave or overwrite each other.
- The demo, the tests, and the lab share one file format that reads line by line and diffs cleanly in review.
- One contract suite holds both stores to the same behavior, so the in-memory store stays a faithful stand-in for Postgres.

**Bad**

- Every payload change needs a new version, an upcaster, fixtures for both languages, and regenerated contracts.
- Upcasting on every read costs CPU. That's fine at session sizes, but long histories may need snapshots later.
- Strict validation means one bad event stops a replay. The fix is a new event or an upcaster, never an edit to the log.
- JSONL is larger than a binary format.
- PGlite runs one transaction at a time, so CI never interleaves two appends. Triggers stand in for a writer that commits between the check and the insert, which tests the error mapping but not the lock under load.
- `session_events` grants the app role `UPDATE` and `DELETE`, which an append-only log doesn't need. Narrowing them, as for `audit_log`, is a separate change.

## More information

- Migration 0005 gave `session_events` an `id uuid not null` column with a unique index on `(session_id, id)`, which also catches an event retried under a new seq. The in-memory store and `replay` reject a repeated id too.
- The store is `packages/db/src/event-store.ts` and the rebuild `packages/db/src/projections.ts`. Their tests run the contract, then the Postgres-specific cases and tenant isolation, in `packages/db/test`.
- Regenerate the demo's projection snapshot on purpose with `pnpm --filter @earshot/events test -u`, and review the diff.
