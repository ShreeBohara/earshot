# ADR-0008: CRM reads come from a local mirror, with optional read-only MCP

## Status

Accepted (2026-11-15). Amended for Phase 4 (2026-11-20): the mirror's phonetic keys are filled, and the embedding stays empty. See "Amendment: Phase 4" below. Amended for Phase 5 (2026-11-25): the mirror keeps its history, written by the demo CRM's controls now and by Phase 6's sync later. See "Amendment: Phase 5" below.

## Context and problem

Linking a spoken name to a CRM record needs fast access to the user's companies, contacts, and deals, including aliases and phonetic keys. Live questions during a voice session, such as "what stage is Acme in?", need current data. Querying the CRM for every lookup would be slow and rate-limited.

## Considered options

- **A local mirror of CRM entities, plus an optional read-only MCP connection during voice sessions.**
- MCP for everything.

## Decision

Keep a mirror of companies, contacts, and deals in `crm_entities`: external ID, name, aliases, phonetic keys, a 512-dimension half-precision embedding, and properties. Entity linking runs against the mirror. Phase 6 syncs it incrementally, using webhooks where the CRM offers them and polling otherwise.

An optional read-only CRM MCP connection can be attached to speech-to-speech sessions for live questions. This stays experimental: it only ships if the CRM token can stay on the server, and OpenAI's docs don't say whether MCP authorization can be set when the ephemeral key is minted.

## Consequences

**Good**

- Fast entity linking.
- Linking can use phonetic and embedding signals the CRM's own search lacks.
- Writes remain separate and approved (ADR-0007).

**Bad**

- The mirror can be stale, and sync adds work and failure modes.
- Mirrored CRM data needs the same tenant isolation as everything else.
- The MCP read path depends on provider behavior that isn't yet confirmed.

## Amendment: Phase 4 (2026-11-20)

- **Phonetic keys are filled.** `crm_entities.phonetic_keys` holds the Double Metaphone codes of each row's name and aliases. The name toolkit in `@earshot/understanding/names` is the one place they're computed, and the demo CRM's loader writes them (Phase 4 WP2).
- **The linker runs in `SessionDO`, on the records the session starts with.** The web app reads the mirror and sends the session's records in its `start` message: at most 250, each with its name, up to 20 aliases, and its parent company. `SessionDO` builds the entity linker's index (ADR-0028) from them, computing the keys with the same toolkit, so no turn waits on Postgres.
- **No embeddings yet.** Embeddings through Workers AI and Postgres search (spec WP13) were cut from Phase 4 by its cut lines. The `embedding` column stays empty, and Phase 6 builds search with the mirror's sync. The linker v1 ablations measure what sound, trigrams, and context each add without them (ADR-0028).

## Amendment: Phase 5 (2026-11-25)

A review card has to tell the CRM's value when the rep spoke from its value now, and show three values when they differ (spec decision 10, WP12; ADR-0035). `start` carries no values and `SessionDO` reads no database on the turn path, so nothing snapshots them as a proposal is made; the mirror keeps its history instead, which Phase 6's sync needs anyway for its change tracking.

- **`crm_entity_changes`** (migration 0017): one row per change to one field of one mirror record: `id`, `workspace_id`, `entity_id`, `field`, `old`, `new`, `changed_at`, `source`. `old` and `new` are JSON scalars, SQL NULL for no value; `field` is a field name (`stage`, `closeDate`, or `name`); the record is named through a composite key, `(workspace_id, entity_id)` to `crm_entities`, so a change can't point into another workspace, and it cascades, so a record's history goes with it.
- **A tenant table, append-only for the app** (ADR-0019): row-level security by workspace, and `SELECT` and `INSERT` only, so the app can add to the history but never rewrite it. pgTAP covers the reads, the fail-closed case, the grants, the cross-workspace key, and the checks. It's exported with the account and deleted with the workspace.
- **`source` is a fixed set:** `demo`, for the demo CRM's controls in the inbox, and `sync`, for Phase 6's sync with a real CRM. A check constraint and the writer (`recordCrmChanges`) refuse anything else.
- **`valueAt(entityId, field, at)`** (`packages/db/src/crm-history.ts`, spec WP12 step 1): the `new` of the last change at or before `at`; else the `old` of the first change after it; else the record's value now. Changes at the same instant are ordered by id, so the answer never depends on row order. A field with no history has always held its value now, as far as the mirror knows.
- **A record's arrival is a change of its `name` from null.** So `valueAt(id, "name", t)` is null for a time before the record reached the mirror, which is how the inbox's re-link offer knows a record was "added to your CRM after you spoke". Records loaded without an arrival row (the demo CRM's dataset) count as having always been there.
- **Who writes it now:** the demo CRM's controls only. "Simulate a CRM change" (`moveDemoField`) moves one field of one of the workspace's demo records and records the change in the same transaction, and "Add a matching record" (`addDemoRecord`) records the new record's arrival in the same transaction as the record. Both act only on demo rows (no connection, the `demo:` prefix), and only on the transaction's workspace.
- **Who reads it:** the inbox's loader, for each update's `base` (`valueAt` at the proposal's time) beside the record's value now, and for the arrivals the re-link offer checks.
- **Phase 6's sync must write it:** every change it mirrors, in the same transaction as the change to `crm_entities`, with `source: "sync"` and the CRM's own change time where the CRM gives one; a new record's arrival as its name's change from null. A value changed in the mirror without a history row shows no 3-way card, and a record that arrives without an arrival row is never offered at review time.
- **What it is, and isn't:** the mirror's account of the CRM, as trustworthy as the mirror itself, which the app can also write. It decides what a review card shows, never what's written: every CRM write still needs an approval (ADR-0007), and Phase 6's sync re-reads the CRM's live value before writing and stops on a conflict. The audit trail stays `audit_log` (ADR-0033).

## More information

Phase 1 has no CRM mirror. It arrives with the adapters in Phase 6.
