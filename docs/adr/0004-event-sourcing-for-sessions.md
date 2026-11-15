# ADR-0004: Event sourcing for sessions

## Status

Accepted (2026-11-15)

## Context and problem

Earshot has to explain every CRM change: which words, at what time, with what confidence. It also needs deterministic replay for demos, tests, and debugging. Plain tables that overwrite state can't reconstruct how a session unfolded.

## Considered options

- **Event sourcing: an append-only event log plus projections.**
- Plain CRUD tables.

## Decision

Every session is stored as an append-only log in `session_events`: session ID, per-session sequence number, type, schema version, payload, and timestamp, partitioned by month. Tables such as `utterances` and `proposals` are projections of that log.

Phase 1 defines the `EventEnvelope` contract so the contracts pipeline carries something real. Phase 2 builds the store: schema versions with upcasters so old events still load, projections, a replay engine, and JSONL export and import for demos and test fixtures.

## Consequences

**Good**

- Replaying a session file rebuilds identical projections, which is also a Phase 2 gate.
- The public replay demo and the session scrubber use the same log.
- Audit and provenance come from the same data.

**Bad**

- More moving parts than CRUD: projections, upcasters, and a replay engine to maintain.
- Event schemas need versioning discipline, because old events must keep loading.
- Debugging means reasoning about a log, not reading a row.

## More information

Neon's free tier has storage limits. The plan's mitigation is to archive old events to R2.
