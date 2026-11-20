# ADR-0032: Reviews, undo, and the seal: `proposal.reviewed` v2, snoozes, compensating undo, `syncEligibleAt`, and two writers that never overlap

## Status

Proposed (2026-11-20). Phase 5 WP1 built the contracts: `proposal.reviewed` v2 and its upcaster, `proposal.snoozed` and `session.sealed` v1, the writers' review rules, the projections that fold them, the `review` and `snooze` messages, the `sealed` error code, and the `am` and `sat` ticket claims. WP3 built the seal and the two writers: `SessionDO`'s `review` and `snooze`, the seal and its refusals, the reopen after a flag, `sealNow` and the edge Worker's `sealSessions`, the flush consumer's audit rows, the web Worker's review route, the repair path, migration 0014, tickets that carry the sign-in, sample sessions, and the client's `sendReview` and `sendSnooze`. Amends ADR-0020 (see its "Phase 5 event types") and ADR-0024 (its "Phase 5: the seal").

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

The tier function is passed in: `tierOf` from `@earshot/understanding/tiers` (WP4, ADR-0035), the same one every writer passes, so `@earshot/events` depends on the contracts alone. WP1's stand-in, `anyFlagTier` (any flag a marker), is a test helper in `@earshot/events/testing` now.

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
- **Tickets** gain two optional claims, still version 1: `am`, how the web session that minted the ticket signed in, and `sat`, when, in Unix seconds. They come together, `sat` can't be later than the ticket's `iat` plus the clock skew (which also catches milliseconds), and they're written after `exp`, so a ticket without them signs to exactly the bytes it did before. `SessionDO` records them as each socket review's `by.auth` (WP3, below).

### Storage: migration 0014 (WP3)

`sessions` gains `sealed_at` (from `session.sealed`) and `focus_entity_id` (the account open when `POST /api/sessions` created the session, with a foreign key to the workspace's `crm_entities` that clears the column when the record goes, as `proposals.target_entity_id` does). `proposals` gains `review` (the latest review whole, `ReviewView` without its seq and time), and in columns of their own the fields the inbox and Phase 6 query by: `review_id`, `review_mode` (checked), `batch_id`, `policy_id`, and `sync_eligible_at`; plus `snoozed_until`, `supersedes`, and `superseded_by`. The status check is dropped and recreated with `superseded`. Every column is nullable: rows from before fill at their session's next rebuild. `rebuildProjections` writes them all, so the rows read back as the replay exactly: `packages/db/test/projections.test.ts` compares them with the committed demo snapshot in full again, as it did before WP1.

### The seal (WP3)

**When.** `end` sets `seal_due_ms` 60 s ahead. Each client write that follows it and appends something (a review, a snooze, usage, a metric) moves it to 60 s after that write, never past 30 minutes after `end` (`SEAL_TIMING`, targets). A session `SessionDO` ended itself after idling gets the same grace. The alarm, once it's due, appends `session.sealed { by: "session" }` in the session's serial queue (so after any turn, witness, or `end` queued before it), re-checking the grace first, since a write that arrived while the task waited restarts it; then it flushes at once, after any flush already under way. An object that ended before Phase 5 has no `seal_due_ms`: its grace runs from `end`, long over, so it seals at its next alarm.

**After.** `session.sealed` is the last event the object ever writes. Every client message but `hello` and `ack` is refused with `sealed`, not retryable, except a resend of a message answered before the seal, which gets its first answer as any resend does. Cleanup waits for Postgres to confirm a log that ends in the seal, then runs a day later, as before; a confirmation of the log up to `session.ended` is no longer enough.

**`sealNow()`**, for the repair path: `gone` when the object holds no log (never started, cleaned up, or purged), `live` while it's capturing, `sealed` when it was sealed before, and `sealing` when this call wrote the seal (it skips the grace). The edge Worker's default entrypoint fans it out as `sealSessions(ids)`, at most 500 lowercase session UUIDs a call, ten at a time, answering a bad argument rather than throwing, like `purgeSessions`.

### The socket writer: `SessionDO` (WP3)

- **`review`**, from `start` until the seal: reviews whose `reviewId` the log already holds are skipped (a `writes` table maps each review and snooze id to its seq and proposal; an id reused for another proposal is refused), so the same review under a new msgId gets the first one's seq. The rest are completed (`by` is the pinned user with the socket's `am` and `sat` as `auth`; `syncEligibleAt` is the object's clock plus `UNDO_WINDOW_MS` for an approval or an edit) and checked together with `checkReviews` against the proposals the log folds to, then appended in one transaction, or refused together with `bad_message`. Refusals log a fixed reason and a position, never an id or a value.
- **A ticket without `am` and `sat`** (minted by a web app from before WP3, during the deploy window the protocol allows) records `by.auth: null`: unknown, not unauthenticated, since the ticket itself proves the web app signed the user in. The review's mode (`single` or `batch`) still tells it apart from machine reviews, whose `auth` is null too.
- **`snooze`** follows the same rules with `checkSnooze`, and needs no signing key: it approves nothing.
- **Failing closed:** without a usable `EARSHOT_AUDIT_SIGNING_KEY` (development uses the committed development key, as `loadAuditSigningKey` allows only there), `review` is refused with `internal`, not retryable, since the flush couldn't store it with its audit row.
- **A flag after an approval** (decision 15): when a witness's `proposal.flagged` lands on an approved or edited proposal, the same transaction appends, right after that flag, a reopen with `mode: "system"`, `reason: "flagged"`, `undoes` the latest review, no sign-in, input, or time, the `session` surface, and as `seen` the proposal as the flag left it. It's checked with `checkReview` (`from: "session"`) first. It's written whether or not a signing key is set: without one no approval could have been taken over the socket, and an approval in doubt mustn't stand.

### The flush consumer's part (WP3)

For the review events an append writes, whichever path writes them (the batch itself, the rest of a stale batch, or a gap repaired from the object), the consumer records an audit row each, in the session's user's name as the `actor_insert` policy requires, and one checkpoint (`request: "flush"`), in the append's own transaction (`recordReviewAudit` in `@earshot/db`). Nothing on the "stale, the ids match" path, so a redelivery adds no rows. Without a signer a message carrying reviews is retried, and stores nothing, until the key is fixed; messages without reviews flush as before.

### The web writer: `POST /api/sessions/:id/reviews` (WP3)

`{ reviews?: ReviewInput[], snoozes?: SnoozeInput[] }`, 1 to 25 in all and at most 64 KiB (`ReviewRouteRequest` in `@earshot/core`, which refuses anything shaped like a key, as the socket does). Same-site only, as the key routes are. Reviews need the signing key: without a usable one the route answers 503 `audit_unavailable` before touching the database; snooze-only requests don't. Each review records the viewer's sign-in method and when that sign-in session began, and `syncEligibleAt` from the route's clock. Then one `withTenant` transaction (`writeSessionReviews` in `@earshot/db`):

1. the session's advisory lock, the one `appendEvents` takes;
2. the log; without `session.sealed`, 409 `not_sealed`, even when `ended_at` is set;
3. `replay`, then each review and snooze whose id the log holds is answered as `recorded: "before"` with its seq, and the rest are checked with `checkReviews` and `checkSnooze` (a proposal may appear once per request);
4. the append after the log's last seq;
5. `rebuildProjections`;
6. an audit row per review appended, and one checkpoint (`request: "review"`), last.

Answers: 200 `{ sessionId, reviews, snoozes, lastSeq }` with each item's seq; 409 `stale` (with the item's kind and position) for a proposal decided, reopened, or replaced since its card loaded; 400 `invalid_request` for anything else; 404 for a session that isn't the viewer's own; 413 `too_large`; 503; 500. Nothing from the request is quoted.

**The lock order.** Session first, then the workspace's audit lock, everywhere: the trigger takes the audit lock at the first audit insert and holds it until commit, and no writer takes a session lock after an audit insert. Both writers run `rebuildProjections` before the audit rows rather than after (§4.3 listed it last): the rebuild reads and rewrites the session's rows and doesn't depend on the audit rows, so the reorder changes nothing but how long the audit lock is held, which is now just the inserts and the checkpoint's signature.

### Why the two writers can't race

`SessionDO` writes nothing after `session.sealed`, and the web Worker writes nothing until Postgres holds it, under the same advisory lock the flush's appends take, so no seq can be claimed twice. A redelivered flush message for a range Postgres already holds takes the "stale, the ids match" path even with the web Worker's reviews after it, and is acked; a redelivery of the seal's own message does the same. `apps/edge/test/node/flush.test.ts` runs exactly that against PGlite: a sealed log flushed, a web review written, then the original message and the seal's message redelivered, both acked with no conflict and no extra audit row.

### Tickets, sessions, and the repair path (WP3)

- `POST /api/sessions` and `/ticket` sign each ticket with the viewer's `signInMethod` (Better Auth's session row, `unknown` before migration 0013) and the session's `createdAt` in whole seconds. A sign-in time ahead of the route's clock is claimed at the ticket's own time, so a clock difference can't fail the ticket.
- `POST /api/sessions` stores the focus account; `/ticket` answers for an ended session until it's sealed, since the tray still reviews over the socket then; `/api/voice/token` still refuses an ended session.
- **The repair path** (`repairUnsealedSessions`, for WP5's inbox loader): at most 20 of the viewer's sessions with events and no seal, ended more than 10 minutes ago or never ended and started more than 2 hours ago (targets), oldest first; `sealSessions` asks their objects; for `gone`, `sealSessionLog` seals Postgres's copy under the session's lock, with `session.ended` first, at the last event's time and with the usage it recorded as its cost, if the log never ended. `live`, `sealing`, and `sealed` are left alone. An unreachable edge Worker skips the load.

### Sample sessions and the client (WP3)

- `importSessionLog(tx, jsonl, { mapDemoIds })` loads a sealed log into the workspace as the user's session: every id derived from the workspace and the original (so a sample loads into any number of workspaces, and loading it twice adds nothing), records named by the demo CRM's dataset ids pointed at the workspace's rows, and `session.ended` and `session.sealed { by: "import" }` added if missing. Settings → Data loads two fixtures (`packages/events/fixtures/samples/`); WP7 switches it to `pilot.v1`.
- `SessionClient.sendReview(reviews)` splits a batch by count (25) and by frame bytes (64 KiB), in order, and resolves with one delivery per message; a review no frame can hold is reported `too_large`, unsent. A message refused with `sealed`, and every message once the client has closed for good, goes to the route (`createReviewRoute`, which retries `not_sealed` briefly) with the same review ids. `sendSnooze` does the same for one snooze. The voice package's in-memory SessionDO takes both and can `seal()`.
- **The capture screen (WP6; ADR-0035).** Its session client is built with the route (`createReviewRoute`) and is the tray's writer. After `end` the screen keeps it open until `session.sealed` arrives, the rep leaves the screen, or 31 minutes pass (the seal's cap and a margin), where it used to close a few seconds after `end`; the tray reviews over the socket in that grace, each review restarting it, and through the route after the seal, under the same review ids.

## Consequences

**Good**

- Every stored session still loads, through one more upcaster, and the demo's log is byte for byte the same.
- A review records what Phase 6's sync and the pilot need: the record chosen, the batch, the policy, what was seen, the timings, and the sign-in.
- Undo deletes nothing, so the log keeps every decision a reviewer made and unmade.
- Auto-approvals and system reopens have their own modes, so they never enter a person's review timings.
- Both writers share one set of rules, tested at $0, and the fold refuses the worst violations again, so a writer that skips them can't commit a log that won't replay.
- The sync boundary is in each approval (`syncEligibleAt`), not in a page that can close.
- Tickets without the sign-in claims are unchanged, so old and new web apps both work against the new edge.
- One event makes "sealed" and "Postgres holds the whole log" the same fact, so the two writers never need a flag kept in step, and the redelivery a second writer would break is tested.
- Reviews never reach Postgres without their audit rows: both writers fail closed without a signing key, and a redelivery writes no second row.

**Bad**

- The fold now fails on more writer bugs: a misnamed or doubled reopen, a review or snooze of a superseded proposal, a bad supersede, a seal before the end or twice. Each stops that session's replay until it's fixed with a new event or an upcaster.
- Many cross-field rules live in code (`checkReview`), not in the schema, in either language, so the lab's Pydantic models accept reviews the writers would refuse.
- Each proposal row repeats its latest review whole (`review`, jsonb) beside the columns the inbox queries, so a row grows with what the reviewer saw.
- The seal delays the inbox: an ended session shows as "Finishing" for at least a minute after the tray's last write, plus its flush. Whether 60 s is enough for late usage and metrics on real networks, and whether the seal's alarm keeps the object from hibernating, are left for the first deploy (spec Appendix B, #8 and #9).
- The whole path from the tray through the flush to the inbox needs both Workers on one Postgres, so CI tests each half (workerd and PGlite) and the first deploy checks the whole.
- `ReviewView` dropped `reviewerMs`, so its readers changed, and the `reviewer_ms` column keeps a name that now means the handling time.
- Until WP4, `anyFlagTier` marked more than the tiers do (a lone `self_correction`, for one), so "accept all" took less; WP4 put `tierOf` in every writer.
- A v2 review is several times the size of a v1 review, mostly `seen`, which grows logs and flush messages.

## More information

- Spec: `reports/Earshot Phase 5 build spec.md`, decisions 1–3, 15, and 16, §4.1 to §4.3, WP1, and WP3.
- Contracts: `packages/core/src/contracts/events/{proposal-reviewed,proposal-snoozed,session-sealed}.ts`; `ReviewInput`, `SnoozeInput`, `review`, `snooze`, and `sealed` in `session-protocol.ts`; `am` and `sat` in `session-ticket.ts`.
- Upcaster, rules, and projections: `packages/events/src/{upcasters,review-rules}.ts` and `packages/events/src/projections/{proposals,session}.ts`.
- Storage: `packages/db/migrations/0014_seal_and_reviews.sql` and `packages/db/src/projections.ts`.
- The writers: `apps/edge/src/session-do.ts` (`review`, `snooze`, the seal, `sealNow`, the reopen), `apps/edge/src/flush.ts` and `queue.ts` (audit rows at flush, `sealSessions`), `packages/db/src/reviews.ts` (`recordReviewAudit`, `writeSessionReviews`, `sealSessionLog`, `unsealedSessions`), `apps/web/lib/reviews/{routes,repair}.ts`, and `packages/db/src/import-session.ts`.
- The client: `packages/voice/src/session/{client,reviews}.ts`; the route's contract in `packages/core/src/contracts/review-route.ts`.
- Tests: `apps/edge/test/sessions/{seal,reviews}.test.ts`, `apps/edge/test/node/flush.test.ts`, `packages/db/test/{reviews,projections}.test.ts` and `pgtap/95_seal_and_reviews.sql`, `apps/web/test/review-routes.test.ts`, and `packages/voice/test/session-reviews.test.ts`.
- Regenerate the demo snapshot on purpose with `pnpm --filter @earshot/events test -u`, and review the diff.
