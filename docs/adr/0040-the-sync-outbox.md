# ADR-0040: The sync outbox: sync events, `proposal.reviewed` v3, `session.started` v2, and writes that can't land twice

## Status

Proposed (2026-11-25). Phase 6 WP1 built the contracts the outbox stands on: the four sync events, `proposal.reviewed` v3 and its upcaster, `session.started` v2 and its upcaster, each proposal's sync view and the statuses `synced` and `failed`, the writers' sync rules (`checkReview`'s and `checkCorrection`'s new refusals, and `checkSyncEvent`), `@earshot/crm`'s types, `CrmError`, the idempotency key and the write markers, `CrmMapping`, the retry route's request, and migration 0019. WP3 adds the outbox itself (jobs made with their approvals, the sync Workflow and its claim, `ConnectionDO`, the sweep, and the chaos test) and completes this ADR. WP15 amends ADR-0020 (the new event types) and ADR-0032 (the sync rule, enforced).

## Context and problem

Phase 6 writes approved proposals to real CRMs (HubSpot, Twenty, Attio) and the demo CRM. Phase 5 left the boundary ready (ADR-0032): every approval records `syncEligibleAt`, only sealed sessions sync, and `sync_jobs` exists but nothing writes it. Before the outbox can be built, several things have to be settled in contracts every later package reads:

- **The record.** Phase 2's status columns reserve `synced` and `failed`, but nothing says where a sync's result lives. If job state lived only in Postgres, the session's log would say "approved" forever, replay and export wouldn't see the sync, and the inbox would join two sources.
- **The point of no return.** Undo is a later review (ADR-0032). Once a CRM write may be under way, an undo can't take it back: Earshot can't unwrite a CRM change. Some event has to mark that moment, and every writer has to refuse a reopen after it, not just the page.
- **Conflicts.** When the CRM's value moved after the rep looked, the record was deleted, or the person already exists, the card has to come back. Phase 5 decided status means "the latest decision" (decision 15): a later flag reopens an approval through a system review. A conflict should do the same.
- **The rep's time zone.** `start` has carried the rep's IANA zone since Phase 3, but `SessionDO` kept it only in its own store, which is gone after the seal. A task's due time and a meeting's start are read in it.
- **Writes that can't land twice.** Workflows retry a step until it succeeds, so a CRM call can commit and then run again, and no CRM checked offers an idempotency key. Each write needs a stable marker the adapter can find its first try by.
- **Stored events keep loading** (ADR-0020), in every runtime that reads them: the edge Worker, the web Worker, the browser, Node, and the lab.

## Considered options

- **Sync results:** **four events in the session's log, appended after the seal under the session's lock (chosen)**; job state in Postgres only.
- **The point of no return:** **`proposal.sync_started`, with the rule in `checkReview`, which every writer runs (chosen)**; hiding Undo in the page.
- **Conflicts:** **a system reopen in `proposal.reviewed` v3, with `reason: "conflict"`, written by a third origin, `sync`, right after `proposal.sync_conflicted` (chosen)**; the conflict event reopening the proposal by itself; reusing `reason: "flagged"`.
- **The time zone:** **`session.started` v2, with a v1 → v2 upcaster that sets null (chosen)**; a column the edge Worker fills at the flush, outside the log; reading `SessionDO`'s store after the seal.
- **The zone's check in the contract:** **its shape and length, with `Intl` checked where `start` arrives (chosen)**; `Intl` in the event contract.
- **Where the sync's rules live:** **pure modules in `@earshot/events`, beside the review rules (chosen)**; each writer's own checks.
- **A write's marker:** **`es_` and 20 base32 characters of SHA-256 of the job's key and the write's index (chosen)**; search, then create; a random id per write.
- **A record's link in a sync event:** **an `http` or `https` URL, by pattern (chosen; a review fix)**; `z.url()`, as the spec wrote it.

## Decision

### Events

**The sync's own events** (`packages/core/src/contracts/events/proposal-sync.ts`), all v1. Each names its proposal (`proposalId`), the job (`jobId`), the approval it syncs (`reviewId`, the proposal's latest review when the job starts), the attempt (1 to 20; a Retry starts the next under the same key), and the CRM (`provider`: `hubspot`, `twenty`, `attio`, or `demo`). The spec's field list left `proposalId` out; it was added at review, for consistency with every other `proposal.*` event, so a reader of one event, its audit row, or an export can tell what it's about without folding the log.

| Event | Adds |
|---|---|
| `proposal.sync_started` | The connection (null for the demo CRM), the mapping version and its SHA-256 (null where there's none), and whether "Sync now" skipped the window |
| `proposal.synced` | What each write did, 1 to 8 records (`{ write, op, ref }`; `op` is `created`, `updated`, or `found`, a retry finding its first try), and how many associations it made |
| `proposal.sync_failed` | The error kind (`SyncErrorKind`), the CRM's code (never its message), the field a refused or unmapped value names, what landed first, and whether Retry is offered |
| `proposal.sync_conflicted` | Why: `moved` (with each field's value as seen and as live), `gone`, or `duplicate` (with the record that already holds the person) |

A record is an `ExternalRef`: its object (`company`, `contact`, `deal`, `note`, `task`, or `meeting`), its id in the CRM, and its link in the CRM's app, or null. **The link is `http` or `https` only** (`CrmRecordUrl`), a host with no spaces or credentials, at most 2,048 characters. This is a review fix: the spec's `z.url()` takes any scheme, `javascript:` and `data:` among them, and WP9 will render the link. It's a pattern on a plain string rather than `z.url()` with a protocol option, so the JSON Schema export carries the rule: Pydantic drops a pattern and a length on a `format: uri` string, and the lab would have accepted what Zod refuses. `http` is for a self-hosted Twenty on `localhost`, in development and in the `crm` CI job.

**`proposal.reviewed` v3** is v2 with one more reopen reason, `conflict`. v2's exports are frozen; a v2 → v3 upcaster changes nothing but the version. Every writer writes v3: `SessionDO` (the tray's reviews, policy approvals, reopens after a flag), the web Worker's review writer, the voice package's in-memory `SessionDO`, and the pilot's local log. The pilot folds its reviews at v3 but keeps v2 payloads in its results file, as its pre-registration names them (ADR-0039): a person's review has v2's shape. `ReviewInput`, what a person sends, derives from v3 and still reopens only to undo.

**`session.started` v2** is v1 plus `timeZone`: the IANA zone `start` sent, or null, which readers take as UTC. A v1 → v2 upcaster sets null. `SessionDO` writes v2. The contract checks the zone's shape and length (`TimeZoneName`), not `Intl`: `start` is still checked against `Intl` when it arrives, but a stored event must load in every runtime, whatever time zone data it ships, and the lab's model then checks exactly what Zod does.

All six new payloads are registered in `eventPayloadContracts`, exported to JSON Schema and Pydantic, and covered by parity fixtures in Vitest and pytest. A registry built without either new upcaster fails when it loads.

### The sync view and statuses

- **`ProposalView.sync`** is the proposal's latest attempt, or null: its job, review, attempt, CRM, and the time of its latest event, and its state. `syncing` from the start; then `synced`, with the records; `failed`, with the failure (kind, code, field, what landed, whether it's retryable); or `conflicted`, with the cause, the fields, and the existing record. The next attempt, a Retry's or a later approval's, takes its place. In TypeScript it's a union by state, so `error` narrows with it.
- **Statuses.** `proposal.synced` sets `synced` and `proposal.sync_failed` sets `failed`. A later start (a Retry) sets the review's decision again. A conflict changes no status: the system reopen after it returns the proposal to `proposed`.
- **What fails the fold,** as writer bugs, like the review checks: a sync event for a proposal the log doesn't have; a start for a superseded proposal, or for a review that isn't its proposal's latest, approving or editing; a result without a start on its proposal; two results for one attempt; a result that names another review or CRM than its start.
- **Waiting and canceled jobs aren't events.** They're `sync_jobs` rows (WP3), which the inbox reads beside the view.
- **`sessionProjection`** gains `timeZone`.
- **The demo session.** `demo-session.jsonl` is byte for byte unchanged and replays. Its committed projections were regenerated on purpose: the session gained `"timeZone": null`, and each proposal `"sync": null`.

### The writers' rules

**`checkReview`** (`review-rules.ts`):

- Nothing reopens a proposal while it's syncing (`syncing`) or once it synced (`synced`), whoever writes the reopen.
- A third origin, `sync`, writes only a system reopen with `reason: "conflict"`, and only for a proposal whose latest attempt conflicted for its latest review (`no_conflict` otherwise). The outbox checks it against the proposals as they stand once its `proposal.sync_conflicted` is folded in, since it appends both in one transaction. A client never writes a system review (`machine_only`), and `SessionDO` never writes a conflict reopen.
- Approvals, edits, and rejections still need `proposed`, so `synced` and `failed` refuse them (`not_proposed`). After a failure, the rep undoes the approval, then edits and approves again, which makes a new job.

**`checkCorrection`** refuses a proposal that's syncing or synced (`syncing`, `synced`).

**`checkSyncEvent(proposals, session, event)`** (`sync-rules.ts`), for the outbox's own events:

1. Every sync event needs a sealed session (`unsealed`).
2. Shape rules the schema can't carry (`malformed`): a start names a connection exactly when its CRM isn't the demo CRM; a success names each planned write once; a failure names a field only for a refused value or an unreadable plan (`validation`, `unmapped`, `unsupported`), and carries a code shaped like one (`VALIDATION_ERROR`, `invalid_grant`), never a message; a conflict lists fields exactly when its cause is `moved`, and names an existing record only when it's `duplicate`.
3. Every sync event names a proposal the session has (`unknown_proposal`).
4. A start needs nothing superseding its proposal (`superseded`), its review to be the proposal's latest (`not_latest`), approving or editing (`not_approved`), and no attempt syncing (`syncing`). If the proposal's last attempt was the same job's, that attempt must have failed retryably, and the new attempt must be later (`not_retryable`); a sweep that failed an attempt before its claim leaves a gap in the numbers, which is fine. A job syncs one review to one CRM, and a review syncs through one job (`malformed`).
5. A result needs the attempt syncing its proposal (`unknown_attempt`), no result for it yet (`settled`), and its start's review and CRM (`malformed`).

On success it answers with the proposal, for the writer's audit rows. The web review and correction routes and the pilot's log read the new refusals `syncing` and `synced` as stale, as they read `not_proposed`.

### The adapter SDK's types and the markers (`@earshot/crm`)

A new internal package, pure TypeScript compiled with ES2023 and the WebWorker library's Web APIs (fetch's `Request` and `Response`, WebCrypto, `TextEncoder`), with no DOM and no Node types, since the edge Worker will import it.

- **Types** (§4.2): `Capabilities`, `PlanInput`, `PlanResult`, `WritePlan`, `LiveCheck`, `PlannedWrite`, `CrmAdapter`, `CrmContext`, and what they name (`MirrorRef`, `CrmSchema` with its stages, owners, association types, and properties, `CrmValue`, `RequestPreview`, `RenderContext`, `ConnectionInfo`, `CrmRecord`, `WriteOutcome`, `ChangeCursor`, `ChangePage`). `PlanInput` also carries the plan's markers, made by the caller: WebCrypto's digest is asynchronous and `plan()` isn't.
- **`CrmError`**, with `kind` (`SyncErrorKind` from `@earshot/core`), `retryable` (by default only `rate_limited` and `transient`), `retryAfterMs`, `status`, `code`, and `field`. Its message is the adapter's own fixed words, never the CRM's message or a credential.
- **`idempotencyKey(proposalId, reviewId)`**: lowercase hex SHA-256 of `earshot.sync.v1:`, the proposal's id, `:`, and the review's id, each lowercased first. Both ids are random UUIDs, so a key, unique across workspaces, reveals nothing about another workspace's jobs.
- **`marker(key, index)`**: `es_` and the first 20 characters of the lowercase RFC 4648 base32, without padding, of SHA-256 of the key, `:`, and the write's index. That's 100 bits (the spec says 103), in lower case letters and digits, safe in any field or URL.

Both are tested against vectors made outside this code with Python's `hashlib` and `base64`.

### Other contracts

- **`CrmMapping`** (`contracts/crm-mapping.ts`), exactly §4.9's shape: a connection's stages with the words a rep might say, the pipeline for new deals, reps' CRM owners, and where commitments and meetings land. Stored by WP5 in `crm_mappings`.
- **`SyncRouteRequest`** (`contracts/sync-route.ts`): the retry route's body, `{ attempt }`, the attempt the page saw fail, 1 to 20, so a double click can't start two retries. Unlike the other routes' requests it's exported to JSON Schema: it holds no string, so it needs no key check that JSON Schema can't carry.

### Storage: migration 0019

- **`sync_jobs`**, which nothing had written, shaped for the outbox: the review it syncs, its connection (null for the demo CRM), the attempt (1 to 20, default 1), `not_before` (the review's `syncEligibleAt`), the mapping version, the error kind, `records` (jsonb, default `[]`), and when the attempt started and finished, with the sweep's index on `(workspace_id, state, not_before)`. `status` is renamed `state` and checked (`pending`, `syncing`, `synced`, `failed`, `conflicted`, `canceled`). Where the spec was silent: `adapter` became `provider` (checked), and `attempts` became `attempt`; `external_id` went, since a job's writes can make up to eight records; `last_error` stays for a fixed code (the CRM's code, or a claim's reason for a cancel), checked to a code's shape so a CRM's message can't land there; the idempotency key is checked to 64 hex digits. `connection_id` has no foreign key yet: what a disconnect does to a connection's jobs is WP5's to decide.
- **`proposals`** gains `sync` (the view) and `sync_state` (checked), which `rebuildProjections` writes with the new statuses; a proposal's `updated_at` follows its latest review or sync event.
- **`sessions`** gains `time_zone`, checked to an IANA name's shape, which `rebuildProjections` writes.
- **`audit_checkpoints.request`** accepts `sync`.
- Row-level security and grants are unchanged. drizzle-kit generated the migration, with the three renames answered at its prompts; one statement is by hand, the `attempt` column's new default, which drizzle-kit drops when it renames a column.

## Consequences

**Good**

- Every stored session still loads, through two more upcasters, and the demo's log is byte for byte the same.
- The log stays the record: replay, export, and the audit chain will see every sync, and the inbox reads one fold.
- The point of no return is a rule every writer shares, so a second tab, the socket, or a stale page can't reopen a proposal once the outbox has claimed it.
- A conflict reopens through a review, so status still means the latest decision.
- The sync rules are pure and tested at $0, and the fold refuses the worst violations again.
- The key and markers are pure, deterministic, and WebCrypto only, with committed vectors, so a retry anywhere finds its first try.
- A record's link can't carry a script, in TypeScript or in the lab.

**Bad**

- The fold fails on more writer bugs: a start for the wrong review, a result without a start or doubled, a result that names another review or CRM. Each stops that session's replay until it's fixed with a new event or an upcaster.
- Some rules live in code, not the schema (`checkSyncEvent`, the conflict reopen), so the lab's models accept events the writers would refuse; and the event contract checks a time zone's shape, so a stored zone `Intl` doesn't know still loads (readers fall back to UTC).
- Each proposal row repeats its latest attempt whole (`sync`, jsonb) beside `sync_state`.
- `sync_jobs` lost `external_id` and renamed two columns. Nothing had written them, but any outside query of the old names breaks.
- Once a proposal syncs, Earshot can't take it back: the rep fixes it in the CRM.

## More information

- Spec: `reports/Earshot Phase 6 build spec.md`, decisions 2 to 7 and 15, §4.1, §4.2, §4.4, §4.9, and WP1.
- Contracts: `packages/core/src/contracts/events/{proposal-sync,proposal-reviewed,session-started,shared}.ts`, `packages/core/src/contracts/{crm-mapping,sync-route}.ts`.
- Upcasters, projections, and rules: `packages/events/src/{upcasters,review-rules,corrections,sync-rules}.ts` and `packages/events/src/projections/{proposals,session}.ts`.
- The SDK: `packages/crm/src/{adapter,errors,markers}.ts`.
- Storage: `packages/db/migrations/0019_sync_columns.sql`, `packages/db/src/projections.ts`, and `packages/db/test/pgtap/98_sync.sql`.
- Tests: `packages/core/test/{contracts,events}.test.ts`, `packages/events/test/{registry,projections,review-rules,corrections,sync-rules}.test.ts`, `packages/crm/test/{markers,errors}.test.ts`, `packages/db/test/projections.test.ts`, `apps/edge/test/sessions/{flow,reviews}.test.ts`, and `lab/tests/test_contracts.py`.
- Regenerate the demo snapshot on purpose with `pnpm --filter @earshot/events test -u`, and review the diff.
