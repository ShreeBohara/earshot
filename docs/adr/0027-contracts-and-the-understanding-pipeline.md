# ADR-0027: Contracts and the understanding pipeline: proposals name the record, a deterministic linker resolves it, and the second witness can downgrade it

## Status

Proposed (2026-11-19). Phase 4 WP1 builds the contracts below: proposal schema v2 with its upcaster, two new event types, the protocol additions, and migration 0012. WP8 finishes this ADR when `SessionDO` writes v2 through the pipeline; until then the pipeline section is the plan. Amends ADR-0020 (see its "Phase 4 event types").

## Context and problem

In Phase 3 the extractor sees the session's CRM list and names a target by id, and only exact names and aliases match. Phase 4 changes who decides (spec decision 1). The model quotes the words that named a record and says what kind of record it is, and a deterministic linker in `SessionDO` resolves the quote against the session's records by sound, spelling, and context. A second witness, an unbiased transcript of the same turn, can then disagree with the biased one at a name. The contracts must carry all of this:

- a target that records the decision (link, ask, new, or none), its probability, its candidates, and the words that named it;
- flags and conflicts that arrive after the card has appeared, without holding the card back for the second witness;
- each record's parent and the account open in Earshot, as context for the linker;
- the browser's unbiased transcript of each turn.

Every stored Phase 3 event has to keep loading (ADR-0020). The client and the edge deploy together, edge first, so the protocol can grow without a version bump.

## Considered options

- Proposal shape: **a new version of `proposal.created` with an upcaster from v1**; editing v1 in place; v1 plus a separate `proposal.linked` event.
- Later changes to a proposal: **a `proposal.flagged` event that adds flags, a conflict, and an optional downgrade**; writing the proposal again; waiting for both witnesses before writing any proposal.
- The protocol: **optional fields and one new client message, still protocol version 1**; protocol version 2.
- Storage: **`proposals.target` and `proposals.conflicts` as `jsonb` columns**; normalized candidate and conflict tables.

## Decision

### Events

**`proposal.created` v2** replaces `targetEntityId` with `target`: `decision` (`linked`, `ask`, `new`, or `none`), `entityId` (set exactly when linked), the model's `kind`, the `basis` of a link (`exact`, `sound`, `context`, or `focus`), the calibrated probability `p`, the `mention` and `company` quotes with their evidence, and up to four `candidates` (three records plus "new", a `null` id). It adds the `meeting` type, seven risk kinds, a `norm` object on each field (the model's value when a deterministic reading replaced it, every reading of an ambiguous quote, a currency), `supersedes` for WP14, and the `linker` version. A flag on the target uses the reserved field name `target`.

**The v1 → v2 upcaster.** A `targetEntityId` becomes `linked` on an `exact` basis, since v1 matched only exact names and aliases. No target becomes `new` when v1 flagged `new_entity`, and `none` otherwise. What v1 never recorded is null or empty, fields and flags carry over unchanged, and `supersedes` and `linker` are null. v1's exports stay frozen.

**`proposal.flagged` v1** (written by `SessionDO` after comparing the witnesses): the proposal, the source (`witness`), at least one flag, an optional downgrade (`{ decision: "ask", candidates }`, at least one candidate), and an optional conflict (the field, the biased quote with its evidence, and the unbiased words with their utterance and audio window).

**`turn.witnessed` v1:** how a turn's second witness ended (`compared`, `failed`, or `skipped`), its provider and model, the unbiased utterances, the number of conflicts, the latency, and why there was no comparison.

### Projections

- `proposalsProjection` folds v2 targets. `targetEntityId` stays on the view and always equals `target.entityId`.
- `proposal.flagged` adds each flag the proposal doesn't already have (the same kind on the same field), and appends its conflict.
- A downgrade sets the decision to "ask", clears `entityId`, and keeps the old target first among the candidates: the linked record, or "new" for a new one. The downgrade must list that record with the probability the comparison gave it. If it doesn't, the fold fails with a `ProjectionError` rather than invent a probability. A target that was already "ask" or "none" takes the downgrade's candidates as they are.
- `sessionProjection` treats `turn.witnessed` and `proposal.flagged` like `turn.completed`: they move only `lastSeq` and `lastEventAt`. Unbiased utterances already land in `utterancesProjection` with `witness: "unbiased"`.

### The protocol (still version 1)

- `EntityRef` gains an optional `parentId`: the company of a contact or deal. It's an exported contract, so JSON Schema and Pydantic have it too.
- The socket caps `parentId` at 128 characters, like `id`.
- `start` gains an optional `focusEntityId`, at most 128 characters, which must be one of `start.entities`.
- A new client message, `witness`, carries one turn's unbiased transcript. It names the provider and model, and its outcome is either `transcribed`, with an utterance whose witness must be `unbiased`, or `failed`/`skipped`, with a reason. An optional `latencyMs` is in whole ms.
- Like every client message, `witness` is held to the 64 KiB frame cap and the 4,000-character text cap, and refused if it holds anything key-shaped. The audio and the witness's provider key go from the browser straight to the provider, never through Earshot.
- The `utterance` message is unchanged. Extraction must still leave unbiased utterances out (WP8).

### Storage

- Migration 0012 adds `proposals.target jsonb`, null on older rows until their session is rebuilt, and `proposals.conflicts jsonb not null default '[]'`.
- `target_entity_id` holds `target.entityId`, still null when the entity isn't in the workspace's CRM mirror.
- The `target` column keeps the decision as the events have it.
- Flags on the target go into `risk_flags` as `kind:target`.

### Writers until WP8

`SessionDO`'s Phase 3 extractor keeps writing `proposal.created` v1, and so does the in-memory fake in `@earshot/voice/testing`. Readers upcast every v1 event, so the client store, the replay demo, and Postgres already see v2.

### Rules the schema doesn't check

Three cross-field rules have no JSON Schema form short of a union, which would change the contract's shape in both languages. The writer (`understand()`, WP8) keeps them, and tests in WP4, WP5, and WP8 cover them:

- `entityId` is set exactly when the decision is "linked";
- `mention` is null only for an implied target or "none";
- no proposal has a field named `target`.

### The pipeline (WP8 builds it)

`turn_end` runs one forced tool call with no CRM list. Its drafts carry a target quote, a kind, and a company quote. `understand(draft, ctx)` then runs four pure steps inside `SessionDO`:

1. Locate every quote in the turn's biased utterances.
2. Link: candidates, features, a calibrated probability, and the decision rule (ADR-0028).
3. Normalize dates, amounts, negations, and corrections.
4. Check each value against its quote.

An unquoted target becomes "none" with `unsupported:target`. If no name was said and an account is open, the target is that account (`basis: "focus"`, `implied_target`). When the witness arrives, the comparison writes `proposal.flagged` and `turn.witnessed` (spec §4.6).

## Consequences

**Good**

- Every Phase 3 session still loads: `demo-session.jsonl` is byte-for-byte unchanged and replays to v2 targets.
- The decision, its evidence, and its candidates are data, so a card can show "Ask: Acme Dynamics or Akme Dynamics?" and an eval can score it at $0.
- A conflict reaches the card after it appears, so the witness never delays the first card.
- Old clients and the new edge speak the same protocol version.

**Bad**

- Projections now fail on a downgrade that leaves out the target it replaces. That's a bug in the comparison, but it stops the session's replay until fixed with a new event or an upcaster.
- `targetEntityId` and `target.entityId` duplicate each other on the view and in the table.
- `supersedes` and `linker` live only in the events. The `proposals` table has no columns for them yet.
- The three cross-field rules aren't enforced by the schema in either language.

## More information

- Spec: `reports/Earshot Phase 4 build spec.md`, §4.1 to §4.3 and WP1.
- Contracts: `packages/core/src/contracts/events/{proposal-created,proposal-flagged,turn-witnessed}.ts`, `entity-ref.ts`, and `session-protocol.ts`.
- Upcaster and projections: `packages/events/src/{upcasters,projections/proposals}.ts`.
- Storage: `packages/db/migrations/0012_proposal_targets.sql` and `packages/db/src/projections.ts`.
- Regenerate the demo snapshot on purpose with `pnpm --filter @earshot/events test -u`. WP1's run added each proposal's upcast `target` and an empty `conflicts`, and nothing else.
