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

**In memory now, Postgres next.** `InMemoryEventStore` serves tests, the replay demo, and local sessions. The Postgres store comes after the schema PR and implements the same interface:

- `append` is one transaction: read the session's `max(seq)`, compare it with `expectedLastSeq`, and insert the rows. If two writers pass the check at once, the primary key `(session_id, seq)` rejects the second insert, and the store reports it as a `ConcurrencyError`.
- `read` is a range scan on the primary key, ordered by `seq`.
- `workspace_id` comes from the store's transaction context, which RLS sets, so the interface doesn't carry it.

**No partitioning yet.** In Postgres, a primary key on a partitioned table must include the partition key. Monthly partitions on `ts` would therefore break the `(session_id, seq)` key that the concurrency check relies on. One table is plenty at Phase 2 volumes. This replaces ADR-0004's "partitioned by month" for now. Revisit it when the table grows large, together with archiving old sessions to R2.

## Consequences

**Good**

- Replaying a session file rebuilds identical projections, and CI checks it against a committed snapshot.
- Old events keep loading. A schema change ships as a new version plus an upcaster, and a missing link fails fast.
- A racing or stale writer gets a `ConcurrencyError`, so writes never interleave or overwrite each other.
- The demo, the tests, and the lab share one file format that reads line by line and diffs cleanly in review.

**Bad**

- Every payload change needs a new version, an upcaster, fixtures for both languages, and regenerated contracts.
- Upcasting on every read costs CPU. That's fine at session sizes, but long histories may need snapshots later.
- Strict validation means one bad event stops a replay. The fix is a new event or an upcaster, never an edit to the log.
- JSONL is larger than a binary format.
- The in-memory store can't prove the Postgres store's behavior, which needs its own tests against the same interface.

## More information

- The planned `session_events` columns have no place for `EventEnvelope.id`. The Postgres store needs an `id uuid not null` column, ideally with a unique index on `(session_id, id)`, which also catches an event retried under a new seq. The in-memory store and `replay` already reject a repeated id.
- Regenerate the demo's projection snapshot on purpose with `pnpm --filter @earshot/events test -u`, and review the diff.
