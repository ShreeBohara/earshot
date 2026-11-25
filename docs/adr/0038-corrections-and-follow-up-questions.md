# ADR-0038: Corrections and follow-up questions: deterministic superseding proposals, typed utterances

## Status

Proposed (2026-11-25). Phase 5 WP13 built it (below): `utterance.final` v3 with `input` and its upcaster, `followup.asked` and `followup.closed` v1, the `correct` and `followup` messages, migration 0018, `@earshot/understanding/correct` and `./followups`, `SessionDO` asking follow-up questions and reading corrections into superseding proposals, `POST /api/sessions/:id/corrections` for sealed sessions, typed corrections in the inbox and the tray, spoken ones from the tray in push-to-talk, and follow-up cards. A security review of the first build found two medium issues, both fixed before this was written: typed words that slipped past speech's limits, and corrections with no rate limit that replayed the log (see "Limits"). Voice corrections in the inbox, the one-shot dictation, are cut (spec §7, cut line 3): the route takes a dictation's words, but the inbox has no microphone yet.

## Context and problem

A card can be wrong in a way no flag catches: a silent wrong account, a date heard one day off, a title that's close but not what the rep said. WP5 gave the rep c, which picks another of the linker's candidates. That fixes a wrong record only when the right one was a candidate, and fixes nothing else. The rep also leaves gaps: a task with no due date, a meeting with no date, a stage change with no amount. A field the rep never said can't be checked against their words, so the pipeline leaves it empty, and the rep has to remember to fill it in.

What corrections have to work within:

- **The log is append-only** (ADR-0020). A proposal can't change. It can be superseded by a new one, which `proposal.created` v2 already allows (`supersedes`), and every writer refuses a review of a superseded proposal.
- **Evidence has one shape.** Every field carries `Evidence` pointing at an utterance's words. A corrected field should point at the words that corrected it, so the card can quote them and the faithfulness check can read them.
- **Keys per request** (ADR-0021). A turn's LLM key rides on `turn_end` and is used once. A correction made after the end, or from the inbox a day later, has no key.
- **Two writers that never overlap** (ADR-0032): `SessionDO` before the seal, the web Worker after it, under the session's advisory lock.
- **The KLM gate** (ADR-0039) counts what the pilot's cards show when the deciding key is pressed. The pilot can't change.
- **The web Worker's bundle.** WP12 brought the linker into it; corrections bring the normalizers too. The spec's rule: if corrections add more than 250 KiB gzipped, run them in the edge Worker by RPC.

## Considered options

- **Reading a correction:** **deterministic: the linker for a record, the normalizers for dates, times, and amounts, the words as said for text, with no model call and no key (chosen)**; extraction again on the correction's words (it needs a key the inbox doesn't have, costs a call, and can invent); a free-form edit (Edit already exists, and keeps no words).
- **What a correction makes:** **a new proposal that supersedes the original (chosen)**; an edit review (no evidence for the new value, and it decides the card instead of putting it back for review).
- **The new proposal's id:** **derived from the correction's id, a v8 UUID from SHA-256 over the session and the correction (chosen)**, so a resend to either writer finds the first one's answer; random (a resend after a lost ack would make a second proposal).
- **Typed words:** **`utterance.final` v3 with `input: "typed"`, confidence 1, no word timings, at the session's last audio time (chosen)**; a separate event type (two evidence shapes for the cards and the checks to know).
- **Typed words on the socket:** **carried on `correct` itself, written only in the correction's own transaction (chosen, after the security review)**; `utterance` messages sent before the `correct`, as the first build did (typed words could then exist with no correction, past speech's limits).
- **Sealed sessions:** **the web Worker's route, in one `withTenant` transaction under the advisory lock (chosen)**, since the bundle grew 61.73 KiB gzipped, under the 250 KiB line; the edge Worker by RPC (another hop, and the edge Worker reads no database).
- **Follow-up questions:** **rules: the spec's three, at most two a turn, none on a loud card (chosen)**; a model's questions (a key, a cost, and a question about something the rep didn't say).
- **Where questions live:** **on their proposal's view (`ProposalView.followups`), moving to the proposal that supersedes it (chosen)**; a projection of their own (a card would have to join two folds).
- **Voice in the inbox:** **cut at the UI (chosen, §7 cut line 3)**; built (a one-shot speech token, a dictation screen, and its clip on the device, an afternoon more).

## Decision

### The contracts (`packages/core`, `packages/events`, `packages/db`)

- **`utterance.final` v3:** v2 plus `input`, `speech` or `typed`. The upcaster reads v2 as `input: "speech"`, so old events load unchanged. `SessionDO` writes v3 with `input: "speech"` for every utterance it takes from the socket. No committed event data was regenerated: the demo session and the samples stay v2. The demo session's projection snapshot gains `input` on its utterances and `followups: []` on its proposals, the views' new fields.
- **`followup.asked` v1:** `questionId`, `turnId`, `proposalId`, `field`, `rule` (`due_date`, `meeting_date`, `deal_amount`), `text` (at most 200 characters). **`followup.closed` v1:** `questionId`, `outcome` (`answered` or `skipped`), and `proposalId`, the proposal that answered it, or null for a skip.
- **The messages:** `correct` (`msgId`, `turnId`, `correctionId`, `proposalId`, `field`, optional `questionId`, optional `typed: { utteranceId, text }`, the text 1–500 characters) and `followup` (`msgId`, `questionId`, `outcome: "skipped"`). `field` is `target` or a field name (at most 64 characters, `/^[a-z][A-Za-z0-9]*$/`). The `utterance` message takes speech only. `SessionErrorCode` gains `unreadable`.
- **The route's contracts:** `CorrectionRouteRequest`, a correction (`correctionId`, `proposalId`, `field`, optional `questionId`, `said`: typed text, or a dictation's 1–8 segments, and an optional IANA `timeZone`) or a skip (`questionId`), strict, with nothing shaped like a key; `CorrectionRouteResponse` (`outcome` `corrected` or `skipped`, the new `proposalId`, `recorded` `now` or `before`, `lastSeq`). `correctionProposalId(sessionId, correctionId)` is core's, so both writers derive the same id.
- **The writers' rules** (`@earshot/events`): `checkCorrection` takes a correction only of a proposal still `proposed` and not superseded, of a field its type has (`correctableFields`: `target` and the type's fields), answering a question only if it's open on that proposal and asks for that field, and only if the card wasn't corrected `maxDepth` (5) times over already (`too_deep`). It returns the open questions the correction answers. `correctionBudget` is the web Worker's count of the session's limits (below); `checkFollowupSkip` takes a skip of an open question on a proposal nothing replaced. The proposals projection holds each proposal's questions, moves the open ones to the proposal that supersedes it, and throws `ProjectionError` on a writer's bug (a question asked twice, closed twice, or on an unknown proposal).
- **Migration 0018:** `utterances.input` (text, default `'speech'`, held to the two values by a check constraint) and `proposals.followups` (jsonb, default `'[]'`), filled by `rebuildProjections`.

### Reading a correction (`@earshot/understanding/correct`)

`correctProposal(original, field, utterances, ctx)` returns the superseding proposal, or a refusal saying what it couldn't read. Pure, with no DOM, no Node APIs, no model call, and no key: the edge Worker and the web Worker both import it.

- **Lead-ins** ("actually", "no, it's", "make that", and so on) are stripped by a scan, not a regular expression.
- **The record** goes through linker v1 (ADR-0028) over the caller's index, with the session's focus account and earlier links. The original's kind is tried first, and its answer stands if it links or asks; otherwise the type's other kinds are tried for a link. A typed exact name or alias of exactly one asked candidate links it, basis `exact`: typing "Peer Logistics" settles a question between homophones that speech couldn't. A contact's target and its `name` are corrected together.
- **Dates** take the last expression that isn't negated ("not Friday, Monday" is Monday), on the call's time and the rep's time zone (ADR-0030). An ambiguous reading keeps its readings and `ambiguous_value`, so the card stays loud. Words with no reading are refused (`unreadable`). **Times** go through `resolveTime`; **amounts** take the last amount not negated, and a currency other than USD is flagged `value_mismatch`.
- **Text fields** take the words as said; a spoken email address is written out.
- **Evidence:** the corrected field's points at the correction's words, under the agent's evidence rules; every other field keeps its evidence and flags.

### Follow-up questions (`@earshot/understanding/followups`)

- A task or commitment with no due date: "When is it due?" A meeting with no date: "When is the meeting?" A deal update that moves the stage with no amount: "What's the amount?"
- At most two a turn, in the order the turn made its proposals; none about a loud card (it asks enough already), or one a policy approved in its turn.
- A question isn't a flag: the tiers, the evals' shares, "accept all", and policies never see one. The pilot's 40 cards stay 40, and the KLM baseline doesn't move.

### `SessionDO`

- **After each turn's proposals,** in the turn's own transaction: `followup.asked` for each question `followupsFor` finds, on the proposals folded with the policy's approvals. If working out the questions fails, the turn is written without them, and the log says so.
- **`correct`,** sent instead of `turn_end` for a correction turn, from `start` until the seal: the words are the turn's utterances, said before it, or the typed words it carries. After the limits (below) and `checkCorrection` on a cached fold of the session's proposals, `correctProposal` reads them over `start`'s records, and the typed utterance (if any), the superseding `proposal.created`, and a `followup.closed` (`answered`) for each question it answers are appended in one commit. The turn is used: a later `turn_end` or `correct` for it is refused, and a `turn_end` for a turn holding typed words is refused too.
- **Unreadable words** are refused with `unreadable`, and nothing is appended, the typed words included: the card stays as it was. **Refusals aren't recorded:** a resend is checked again, to the same answer.
- **`followup`** appends `followup.closed` (`skipped`) once `checkFollowupSkip` passes; a second skip of the same question gets the first one's seq.
- Neither writes an audit row or needs the audit key: a correction decides nothing, it makes a proposal for the rep to review. Neither pushes back the idle end.

### The web Worker's route (`POST /api/sessions/:id/corrections`)

- Signed in, same-site only, at most 64 KiB, nothing shaped like a key, and no text Postgres's jsonb would refuse (U+0000, or half a surrogate pair).
- In one `withViewerTenant` transaction: `writeSessionCorrection` or `writeFollowupSkip` (`@earshot/db`) takes the session's advisory lock, reads the log, and answers `not_sealed` (409) until `session.sealed` is in Postgres. A resend, found by the derived id, gets the first answer.
- Typed words become `utterance.final` v3 (`input: "typed"`, confidence 1, no words, at the session's last audio time); a dictation's segments, `input: "speech"`, moved to that time.
- The words are read by `correctProposal` over the workspace's mirror, as the inbox re-links (WP12): the link index from the mirror's rows, the focus account from `sessions.focus_entity_id`, the session's earlier links, the kinds the proposal's type allows, the call's start, and the rep's time zone from the request.
- Answers: 404 for a session that isn't the viewer's; 409 `stale` for a proposal decided or replaced, or a question closed, since its card loaded; 422 `unreadable`, writing nothing; 429 `too_many` past a limit; 400 for anything else. Every answer is `no-store` and quotes nothing from the request.
- **Superseded proposals refuse reviews** in the review route and in `SessionDO`, as every writer's `checkReview` already did; tests cover both, after a correction.

### The clients (`@earshot/voice`, `apps/web`)

- **`SessionClient`:** `sendCorrection` and `sendFollowupSkip` over the socket, each answered by its ack or refusal. A typed correction or a skip refused with `sealed`, or sent once the client has closed, goes to the corrections route under the same ids. A spoken one can't (its words are a turn's), and answers `sealed`.
- **The engine bridge** (`connectEngine`'s `takeCorrection`): at a turn's end, an armed correction takes the turn, which is sent as `correct` instead of `turn_end`. Its utterances went out as usual; the witness drops it.
- **The capture controller** (`spokenCorrections`): a card's microphone arms the next turn and presses push-to-talk; Done releases it. Only while `canSpeakCorrections`: live, push-to-talk (hands-free has no press to arm), not paused, not sealed. A turn never read gives the card its answer ("couldn't send") after two minutes, or when the screen goes. The turn's audio goes to the speech-to-text provider like any turn's, and its clip, with clips on, stays on the device (ADR-0036).

### The UI

- **c's panel** gains a field picker, "What's wrong" (the record preselected on a card about one, else the type's first field), and a text box whose Enter sends the words. With the record picked, the linker's candidates stay on 1–3 above the box, and focus lands on them as before; with a field picked, they go, and focus is in the box. On the capture screen, while the session captures in push-to-talk, a "Say it" button beside the box takes the next thing said. On a question's card, c opens the panel too where corrections can be written, so the rep can type a record none of the choices offers.
- **A failure** stays in the panel with the words kept, its line an inline alert: "I couldn't read a date in “whenever suits them”." The page quotes its own copy of the words, never a server's answer, and cuts them at 60 characters. A spoken correction says "in what you said".
- **The corrected card** takes the original's place in its group, down a chain of corrections (`inboxSections` sorts by the original's position), and its focus once it arrives: from the inbox's next read, or the session's events in the tray. One polite message says so.
- **Follow-up cards** sit right after their proposal's card ("When is it due? · Task · Pier Logistics"), as focus stops of the list's roving focus. Each is a group, not an `<article>`, so nothing counts it as a proposal. c answers it in a text box (Enter sends, Esc closes); r skips it, and focus moves on as when a card leaves. A card that leaves takes its questions' stops with it, so focus never lands on a question whose card is gone.
- **The pilot** passes no correction sink: its panel keeps only the candidates, it shows no questions, and its cards are unchanged. The shortcut list, which the pilot shares, is unchanged; a question's buttons show C and R.

### Limits (the security review's two findings, and the rest)

The first build had two medium issues. **Typed words skipped speech's limits:** they travelled as `utterance` messages a client could send without a correction, past the capture limit, uncounted, and each one pushed back the idle end. **Corrections had no rate limit and replayed the log:** a client could send them as fast as the socket allowed, chain them without end, and each one replayed the whole log. The fixes:

| Limit | Value | Where |
|---|---|---|
| Typed text per correction | 500 characters | The protocol and the route's contract |
| Words corrections carry, per session | 20,000 characters | `SessionDO` (`typed_chars`); the route, counting typed words, a dictation's segments, and every utterance written after the seal |
| Typed words after capture | At most 5 minutes past the 30-minute capture limit (`TYPED_CORRECTION_GRACE_MS`), refused `duration_limit` | `SessionDO` |
| Corrections in a window | 30 per 10 minutes, as turns are | `SessionDO`, counting every attempt that reaches the checks, read or not (`correction_starts`); the route, from the log's superseding proposals, and per viewer and session in Postgres before any work, in production (`CORRECTION_REQUEST_LIMIT`) |
| Corrections per session | 100 | Both writers |
| Corrections of one card | 5 over (the depth of its `supersedes` chain), refused `too_deep` | Both writers (`checkCorrection`) |
| Where typed words travel | Only on `correct`, written in the correction's own transaction | `SessionDO` |
| The idle end | Corrections and skips never push it back (`idle_anchor_ms`) | `SessionDO` |
| Checking a correction | A cached fold of the session's proposals, not a replay | `SessionDO` (`#fold()`) |
| A dictation | 1–8 segments, each up to 4,000 characters and 200 words; the body at most 64 KiB | The route |
| Questions | 2 a turn, texts fixed, at most 200 characters | `@earshot/understanding/followups`, the contract |

On the socket a limit is refused `turn_limit` (or `duration_limit`), with a fixed reason in the log; on the route, 429 `too_many`. The socket's token bucket and 64 KB message cap still apply.

### The bundle

`build:worker`'s dry-run upload, measured before the first change and at the end: 23,693.92 KiB raw and 5,126.53 KiB gzipped before; 23,960.90 KiB and 5,188.26 KiB after. Corrections add 266.98 KiB raw and 61.73 KiB gzipped, under the 250 KiB line, so they run in the web Worker. The route imports subpaths only: `@earshot/understanding/correct` (which brings the normalizers' chrono-node), `@earshot/agent/link-context`, `@earshot/events`, and `@earshot/db`. The page gains none of the reading code: the inbox's failure line names a field's kind from a small map rather than importing `@earshot/understanding/faithfulness`, so chrono-node stays out of the browser.

### Calls made where the spec was silent

- An unreadable correction appends nothing, and a refusal isn't recorded.
- Typed words ride on `correct`, never in an `utterance` message (the security review).
- Speech corrections aren't offered in hands-free: there's no press to arm.
- Failure lines are inline alerts in the panel, not urgent toasts: the error belongs by its field, and the toaster's urgent toast keeps a focusable close button inside an `aria-hidden` stack, which axe fails.
- The route's count of corrections includes every superseding proposal in the log, not only those a correction made. It can only be stricter.
- A dictation's words count against the same budget as typed words: they're the client's claim either way.
- The two-minute wait for a spoken correction's answer.

## Consequences

**Good**

- A silently wrong account, date, or amount is fixed in a few keys, with the rep's own words as the new field's evidence, and the corrected card goes back for review: nothing is decided for the rep.
- No key, no model call, and no cost: the same normalizers and linker as the turn path, so a correction is read as a turn would have read it.
- Resends are safe on both writers, by the derived id, across the seal.
- Questions ask only for what the rep left out, never on a card that already needs a check, and never touch the tiers, the evals, the pilot, or the KLM baseline.
- Typed words exist only with a correction that passed its checks, under the same kind of limits as speech.

**Bad**

- A correction can only say what the normalizers and the linker can read: "end of next quarter" reads, "after their board meeting" doesn't, and the rep gets "I couldn't read a date".
- A record only links if it's in the index: `start`'s records live, the mirror after the seal. A record the CRM doesn't have can't be typed into being; Edit or Reject remain.
- The inbox has no microphone. A rep who wants to speak a correction does it on the capture screen while the session is live.
- A dictation's words are the client's claim. Nothing proves they came from a speech-to-text provider; they're the rep's own words about their own debrief, under the typed words' budget.
- A corrected card loses its place in the tray's arrival order: it takes the original's spot, not the end.
- The web Worker grows by 61.73 KiB gzipped.

## More information

- Phase 5 build spec: decision 11, §4.3, WP13, cut lines 3 to 5, and the risk table's bundle row.
- ADR-0020, ADR-0021, ADR-0027, ADR-0028, ADR-0030, ADR-0032, ADR-0034, ADR-0035, ADR-0036, ADR-0039.
- The threat model's rows: "Corrections and follow-up questions (Phase 5 WP13, for v1.3)".
