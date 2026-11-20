# ADR-0032: Reviews, undo, and the seal: `proposal.reviewed` v2, snoozes, compensating undo, `syncEligibleAt`, and two writers that never overlap

## Status

Proposed (2026-11-20). Phase 5 WP1 built the contracts: `proposal.reviewed` v2 and its upcaster, `proposal.snoozed` and `session.sealed` v1, the writers' review rules, the projections that fold them, the `review` and `snooze` messages, the `sealed` error code, and the `am` and `sat` ticket claims. WP3 builds the seal and the two writers (`SessionDO`'s handling of the new messages, the web Worker's route, and migration 0014), and completes this record. Amends ADR-0020 (see its "Phase 5 event types").

## Context and problem

Phase 5 turns the tray's review buttons into a review inbox, with undo, "accept all", approval policies, and a boundary that Phase 6's CRM sync must respect. Phase 3's `proposal.reviewed` v1 records a decision, an optional edit, and one time. It can't say:

- which record the reviewer chose when the linker asked, or that a new record was meant;
- whether a person decided one card, accepted a batch, or a policy approved it on its own;
- which review an undo reverses, or that a later conflict reopened an approval;
- what the reviewer saw: the card's tier, its values, the CRM's values, and whether they played the audio;
- how long the decision took, by what input, on which surface, and how the reviewer signed in;
- when an approval may sync.

Two writers will append reviews. While a session is live, `SessionDO` writes the tray's reviews to its own log and flushes them to Postgres. The inbox reviews hours later, after the object has deleted itself, so the web Worker must write to Postgres directly. The flush dead-letters a batch when another writer's events sit where its own should (`apps/edge/src/flush.ts`), so the two must never append to one log at the same time.

Every stored event has to keep loading (ADR-0020), and the client and the edge still deploy together, edge first, under protocol version 1.

## Considered options

- **The review's shape:** **a new version with an upcaster from v1 (chosen)**; editing v1 in place; separate events for the record chosen, the batch, and the policy.
- **Undo:** **a later review that reopens the proposal, naming the review it reverses (chosen)**; deleting or editing the reviewed event; a pending state held only in the page.
- **Snooze:** **its own event (chosen)**; a fourth decision; the page's memory alone.
- **Machine-made reviews:** **two modes of their own, `policy` and `system` (chosen)**; recording auto-approvals as single reviews.
- **The two writers:** **a seal event, the last `SessionDO` writes, after which the web Worker writes under the session's lock (chosen)**; forwarding inbox reviews to the object by RPC; sealing at `end`; a seal flag the flush consumer sets.
- **Where the rules the schema can't express live:** **one pure module in `@earshot/events`, shared by both writers (chosen)**; Zod refinements on the payload; each writer's own checks.

## Decision

### Events

**`proposal.reviewed` v2** (`packages/core/src/contracts/events/proposal-reviewed.ts`):

| Field | What it holds |
|---|---|
| `reviewId` | A UUIDv7 from the client, so a review is idempotent across the socket and the web route |
| `proposalId`, `decision` | v1's decisions plus `reopened` |
| `target` | The record chosen, `{ entityId }`; a `null` id is a new record. Null when nothing was chosen |
| `editDiff` | As in v1, set exactly when the decision is `edited` |
| `mode`, `batchId`, `policy` | `single`, `batch` (with one `batchId` for an "accept all"), `policy` (an auto-approval, with the policy's id, version, and rule), or `system` (`SessionDO` reopening an approval a later flag put in doubt) |
| `undoes`, `reason` | For a reopen: the review it reverses, and why (`undo` or `flagged`) |
| `seen` | What the card showed: its tier (`loud`, `quiet`, or `none`), each field's proposed value with the CRM's value at proposal time and now, the record shown and the records offered, a record offered at review time, and whether the clip was played |
| `timing` | The review clock's `decisionMs` and `handlingMs` |
| `input`, `surface` | Keyboard, pointer, touch, voice, or none; inbox, tray, pilot, or session |
| `syncEligibleAt` | When an approval may sync |
| `by` | The user, and how and when their web session signed in (`auth`, null for policy and system reviews) |

**`proposal.snoozed` v1:** `snoozeId`, `proposalId`, `until` (null wakes it), and `by`. A snooze decides nothing, so it isn't a review: no timing, no audit entry, no effect on sync.

**`session.sealed` v1:** `sealedAt`, and who sealed it: `session` (`SessionDO`), `web` (the repair path), or `import` (sample sessions).

All three are registered in `eventPayloadContracts`, exported to JSON Schema and Pydantic, and covered by parity fixtures in Vitest and pytest. v1's exports are frozen.

**The v1 → v2 upcaster** (`proposalReviewedV1ToV2`). The event's own id becomes the `reviewId`, so the upcast is deterministic and a later reopen can name an old review. `decision` and `editDiff` carry over, `reviewerMs` becomes both `decisionMs` and `handlingMs`, and the mode is `single`. Everything v1 never recorded is null, including `syncEligibleAt`: nothing upcast from v1 is eligible to sync. A registry built without it fails when it loads.

### Undo and the sync boundary

- Undo appends a review with `decision: "reopened"` and `undoes` naming the review it reverses. The log keeps both decisions, the compensating-event pattern, which is also Phase 8's data on changed minds. Undoing an "accept all" writes one reopen per proposal.
- A `proposal.flagged` on an approved or edited proposal makes `SessionDO` append a reopen with `mode: "system"` and `reason: "flagged"` (spec decision 15; WP3).
- Each approval records `syncEligibleAt`, its time plus 30 s (target). Phase 6's outbox must not write before it, must re-read the latest review first, and syncs only sealed sessions.

### The writers' rules

JSON Schema can't express a field that must be set exactly when another has some value, short of unions that would change the contract's shape in both languages. So `checkReview(proposals, review, { tierOf, from })` in `@earshot/events` (`review-rules.ts`) holds them, pure, and both writers run it against the session's folded proposals before they append:

1. **Shape:** `batchId` with `batch`, `policy` with `policy`, `undoes` and `reason` with `reopened`, `editDiff` (not empty) with `edited`, and `syncEligibleAt` with `approved` and `edited`, each set exactly then. A Phase 5 writer always sets `seen`, `input`, `surface`, and `by`. A person reviews in `single` or `batch` mode, with an input, on a surface of their own. A policy approves, and a system review reopens for a flag; both have no sign-in or input, the `session` surface, and zero timings. A batch approves or undoes, and only approvals and edits choose a record.
2. **Origin:** `policy` and `system` reviews come only from `SessionDO` (`from: "session"`), and `SessionDO` writes no other kind.
3. **The proposal:** it exists, and no correction has superseded it.
4. **The decision:** approving, editing, and rejecting need a `proposed` proposal. Approving and editing need a record unless the target is `none`, which can't be approved: for an ask, one of its candidates; otherwise the proposal's own record or a candidate, if the review names one. A record offered at review time (`seen.relinked`) counts as offered. A reopen names the latest review, which must be a decision, and a system reopen only an approval or an edit.
5. **The mode:** a batch takes only unmarked proposals (`tierOf` is `none`); a policy only an unmarked, linked proposal that doesn't supersede another.

`checkReviews` checks a request (a `review` message or a web request): each review id and proposal once, and one batch id; then each review against the state before the request. `checkSnooze` needs an existing, unsuperseded, proposed proposal. Refusals carry a reason (`malformed`, `unknown_proposal`, `superseded`, `not_proposed`, `not_latest`, `nothing_to_reopen`, `target_required`, `target_not_offered`, `no_target`, `marked`, `machine_only`, or `policy_excluded`) for the writers to map to protocol errors and HTTP statuses.

The tier function is passed in. Until WP4's `tierOf` (`@earshot/understanding/tiers`), `anyFlagTier` counts any flag as a marker.

### Projections

- **`proposalsProjection`.** The status is the latest decision, and a reopen returns it to `proposed`. The proposal's `review` is its latest review, a reopen included, with every v2 field (`ReviewView` no longer has `reviewerMs`; it's `timing.handlingMs`). `proposal.snoozed` sets `snoozedUntil`, and a review leaves it as it is. A `proposal.created` that `supersedes` another marks that one `superseded` and sets its `supersededBy`; the new proposal keeps `supersedes`.
- **What fails the fold,** as writer bugs, like Phase 4's downgrade check: a reopen that doesn't name the latest review, or that names a reopen; a review or a snooze of a superseded proposal; superseding an unknown proposal, or one already superseded. A v1 log that reviewed a proposal twice with no reopen between still loads, with the later decision standing.
- **`sessionProjection`** gains `sealedAt`. A seal before `session.ended`, or a second seal, fails the fold. Events may follow the seal: the web Worker's reviews.
- **The demo session.** `demo-session.jsonl` is byte for byte unchanged and replays. Its committed projections were regenerated on purpose: the session gained `sealedAt: null`; each proposal gained `supersedes`, `supersededBy`, and `snoozedUntil`, all null; and each review gained its upcast fields (its event's id as `reviewId`, `mode: "single"`, both timings from `reviewerMs`, and nulls) and lost `reviewerMs`.

### The protocol (still version 1)

- **`review`** carries 1 to 25 `ReviewInput`s: `proposal.reviewed` v2 without `by` and `syncEligibleAt`, which the writer fills from the sender's sign-in and its own clock, in `single` or `batch` mode only, so with no policy, and reopening only to undo. Record ids are capped at 128 characters, like `start`'s. A longer batch goes in several messages with one `batchId`.
- **`snooze`** carries `snoozeId`, `proposalId`, and `until`.
- **`sealed`** joins the error codes: the session takes no more writes, ever, and the client sends reviews to the web route instead, with the same review ids. Not retryable.
- **Keys.** Both messages are held to the frame cap and refused if anything in them is shaped like a key, as every client message is outside `turn_end.key`. `ReviewInput` carries the same check itself, so the web route, which parses it on its own, refuses key-shaped strings too.
- **Tickets** gain two optional claims, still version 1: `am`, how the web session that minted the ticket signed in, and `sat`, when, in Unix seconds. They come together, `sat` can't be later than the ticket's `iat` plus the clock skew (which also catches milliseconds), and they're written after `exp`, so a ticket without them signs to exactly the bytes it did before. `SessionDO` will record them as each socket review's `by.auth`.
- **Until WP3,** `SessionDO` and the voice package's fake don't handle `review` or `snooze`, as `witness` waited from Phase 4's WP1 to its WP9. No client sends them before WP3.

### Storage until migration 0014

`rebuildProjections` writes what the Phase 4 tables can hold: the status (a reopen stores `proposed`), the latest review's diff, its `handlingMs` as `reviewer_ms` (v1's `reviewerMs` for every stored review, so no row changes), and its seq and time. Migration 0014 (WP3) adds `review_id`, `review_mode`, `batch_id`, `policy_id`, `sync_eligible_at`, `snoozed_until`, `supersedes`, `superseded_by`, and `sessions.sealed_at`, and `superseded` to the allowed statuses. No writer supersedes a proposal before then.

### The seal and the two writers (WP3)

The design WP3 builds, from the spec's decision 1 and §4.3:

- `SessionDO` takes reviews from `start` until it seals: 60 s after `end`, or after the last state-changing message that followed it, whichever is later, and at most 30 minutes after `end` (targets). `session.sealed` is the last event it ever writes, flushed at once; after it, every client message but `hello` and `ack` is refused with `sealed`.
- Seqs are contiguous, so once Postgres holds `session.sealed` it holds the whole log. Only then does the web Worker append reviews and snoozes, one `withTenant` transaction per request: the session's advisory lock, a log that must hold the seal (else 409 `not_sealed`), `replay`, `checkReviews`, the append, and `rebuildProjections`.
- Neither can claim a seq the other holds: `SessionDO` writes nothing after the seal, and the web Worker writes nothing before Postgres has it. A redelivered flush message for a range Postgres already holds takes the existing "stale, the ids match" path, even with web reviews after it.
- Sessions that ended before Phase 5, or whose seal never came, are sealed by a repair path (`sealSessions`), with `by: "web"` when the object holds nothing.

## Consequences

**Good**

- Every stored session still loads, through one more upcaster, and the demo's log is byte for byte the same.
- A review records what Phase 6's sync and the pilot need: the record chosen, the batch, the policy, what was seen, the timings, and the sign-in.
- Undo deletes nothing, so the log keeps every decision a reviewer made and unmade.
- Auto-approvals and system reopens have their own modes, so they never enter a person's review timings.
- Both writers share one set of rules, tested at $0, and the fold refuses the worst violations again, so a writer that skips them can't commit a log that won't replay.
- The sync boundary is in each approval (`syncEligibleAt`), not in a page that can close.
- Tickets without the sign-in claims are unchanged, so old and new web apps both work against the new edge.

**Bad**

- The fold now fails on more writer bugs: a misnamed or doubled reopen, a review or snooze of a superseded proposal, a bad supersede, a seal before the end or twice. Each stops that session's replay until it's fixed with a new event or an upcaster.
- Many cross-field rules live in code (`checkReview`), not in the schema, in either language, so the lab's Pydantic models accept reviews the writers would refuse.
- Until migration 0014, Postgres rows hold only part of a v2 review; the projection and the log hold the rest.
- `ReviewView` dropped `reviewerMs`, so its readers changed, and the `reviewer_ms` column keeps a name that now means the handling time.
- `anyFlagTier` marks more than WP4's tiers will (a lone `self_correction`, for one), so "accept all" takes less until WP4 lands.
- A v2 review is several times the size of a v1 review, mostly `seen`, which grows logs and flush messages.

## More information

- Spec: `reports/Earshot Phase 5 build spec.md`, decisions 1–3, 15, and 16, §4.1 to §4.3, WP1, and WP3.
- Contracts: `packages/core/src/contracts/events/{proposal-reviewed,proposal-snoozed,session-sealed}.ts`; `ReviewInput`, `SnoozeInput`, `review`, `snooze`, and `sealed` in `session-protocol.ts`; `am` and `sat` in `session-ticket.ts`.
- Upcaster, rules, and projections: `packages/events/src/{upcasters,review-rules}.ts` and `packages/events/src/projections/{proposals,session}.ts`.
- Storage: `packages/db/src/projections.ts`.
- Regenerate the demo snapshot on purpose with `pnpm --filter @earshot/events test -u`, and review the diff.
