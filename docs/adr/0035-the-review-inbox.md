# ADR-0035: The review inbox: a list with roving focus, focus-scoped single-key shortcuts, one message per action, the batch checkpoint, likely-edit tiers, first-person uncertainty, and diff cards

## Status

Proposed (2026-11-20). Phase 5 WP4 drafted the likely-edit tiers and first-person uncertainty (below): `tierOf`, the tiers' $0 budgets in `checks`, the copy, and `tierOf` in place of WP1's stand-in in every writer. WP5 built the inbox's structure (below): `/inbox`, its loader, the list of cards with roving focus, the focus-scoped single-key shortcuts and Settings → Review's switch, one message per action, the focus rules, the review clock, and Reviewed, Snoozed, and Finishing. WP6 adds the "accept all" checkpoint and the tray on the inbox's card, and WP12 diff cards. Amends ADR-0031 (its "Phase 5: the likely-edit tiers").

## Context and problem

Phase 4 writes flags on proposals: fourteen kinds, from the linker, the normalizers, the faithfulness check, and the second witness. Phase 4's tray showed every flag as a badge, and on the 200 debriefs 45.8% of proposals carried at least one (ADR-0031), against a 35% guard. A sea of badges teaches reviewers to ignore them:

- Highlights helped only when precise. Edit-likelihood highlights in Vasconcelos et al. (TOCHI 2024) marked tokens of which 64.7% were edited, and cut review time; generation-probability highlights tuned to the same density had 26.1% edited, and gave no benefit. Raw speech-recognition confidence didn't help either (Kuhn et al., CHI EA 2025). QE4PE (TACL 2025) found the highlighted share drove editing time.
- Wrong accounts are recall-critical: a reviewer who learns that unmarked means safe will miss the one that isn't (Xu, Lien, and Höllerer, CHI 2023, on high-recall suggestions).
- Phrasing doubt in the first person cut agreement with a wrong AI and raised accuracy (Kim et al., FAccT 2024), but there it sat on a random half of the answers; over-flagging buys underreliance, since accuracy on right answers fell.

So the cards need marks that are rare where they're loud, still present where an error would otherwise hide, and computed the same way by every part of Earshot that decides what a reviewer sees or what "accept all" takes.

The inbox around them has to be fast from the keyboard (a 4 s median per proposal is the gate, and a keystroke saves about a second against the mouse), and usable with a screen reader and by speech input. Single-key shortcuts are what make review fast, and what WCAG 2.2 SC 2.1.4 constrains: they must be possible to turn off, or act only on focus. Screen readers in browse mode take letters and digits for themselves (NVDA: k, a, e, r, u, 1–6). The capture screen already binds Space to push-to-talk while a debrief is docked. Reviews are written by the web route after the seal (ADR-0032), so the page must survive a refusal, and the pilot needs each review's time (spec §4.8).

## Considered options

- **What decides a mark:** **two tiers from Phase 4's flags and decisions, by one rule table (chosen)**; one confidence threshold (raw confidence didn't help); a learned likely-edit model (Phase 8, from approve, edit, and reject signals); token-level marks (they raised agreement with the AI in Villavicencio et al., FAccT 2026).
- **`link_uncertain`** (ADR-0031's options): **option 2, a note beside the record's name, now (chosen)**; option 1, moving its bar for context links to p below 0.90, after Phase 4's mined set measures its real precision; leaving it a badge.
- **The loud budget, when display rules can't meet it:** **gate an interim ceiling at the measured floor plus 2 points, and fix the false conflicts later (chosen; the orchestrator's decision under spec §9)**; changing the witness threshold now; leaving loud ungated until the floor falls.
- **The first-person line:** **templates on loud cards only (chosen)**; hedges written by the model; the general phrasing ("It's not clear…"), whose effects were weaker and not significant.
- **The inbox's structure (WP5):** **an `<ol>` of `<article>` cards with native buttons and roving focus (chosen)**; `feed` (for reading in browse mode, with Page Up and Down); `listbox` (an option can't hold buttons); `grid` (verbose, and two dimensions the inbox doesn't need yet).
- **Single-key shortcuts:** **on by default, active only while focus is in the list and not in a text field, with a per-device switch (chosen)**; off by default, as Gmail's are (it hides the fastest path from everyone); global, as Gmail's are once on.
- **Announcing actions:** **one polite toast per action through Base UI's toaster, urgent for a failure, and no other live region (chosen)**; a status region of the inbox's own beside the toaster (two announcements per action).
- **Undo's home:** **the toast, u, and a Reviewed section that keeps Undo until the sync window closes, then Reopen (chosen)**; the toast alone (gone in 5 s, so it fails WCAG 2.2.1 for anyone slower).

## Decision

### The tiers

`tierOf(proposal)` in `@earshot/understanding/tiers` returns `{ tier, reasons, nameNote }` (spec §4.4). It reads the proposal as the projection folds it (witness downgrades and later flags included) or as it was written: its flags, its target's decision, basis, and candidates, and each field's `norm`.

| Tier | When | Shown as | Counts toward |
|---|---|---|---|
| **Loud** | The target is an ask, the linker's (`ambiguous_target`) or a witness downgrade; any `witness_conflict`; `unsupported` on the target or a field; `ambiguous_value`; a `value_mismatch` nothing fixed (no `norm.llmValue`: a self-correction whose retracted value the model kept, a name or email spelled otherwise, an amount in another currency); a `new_entity` with a sound-alike, a record candidate at p ≥ 0.05 (the tray's `ASK_MIN_P`) | Amber, a first-person line, choices on 1/2/3, kept out of "accept all" and policies | Loud share, marked share, surfacing |
| **Quiet, on the card** | `implied_target`; a `value_mismatch` a unique reading fixed ("corrected from …"); `negation`; `low_confidence`; `weak_support`; a `new_entity` with no sound-alike; v1's `date` and `number` | A short note on the field or the card, no color | Marked share, surfacing |
| **Quiet, by the name** | `link_uncertain` on a linked target | "matched by sound" or "matched in context", beside the record's name | Name-note share, surfacing; not the marked share |
| **None** | No flag, or only `self_correction` (the model took the correction) | Nothing | — |

- **Reasons** come loud first, each tier in a fixed order (a conflict, then the linker's question, unsupported words, a sound-alike, two readings, an unfixed mismatch; then the quiet ones), then in the flags' order. The first loud reason picks the card's line. A downgrade is a conflict, not a second question; a target that's an ask with no flag saying so is loud anyway.
- **The name note** belongs beside a record's name, so only a target still linked carries it; a downgraded one is a question, and loud already. It makes the tier quiet, so "accept all" and policies leave the card, but the evals count it apart.
- **Every kind has a role.** `tierOf` restates `RiskKindV2` (the package can't import `@earshot/core` without Web Crypto types), and a type test in `@earshot/evals` fails when the two differ, as does an exhaustive switch: a new kind can't arrive without a tier.
- **One function everywhere.** `SessionDO` (`TIER_OF`: what its own reviews record as seen, and the rules for the socket's reviews), the web Worker's review route (`writeSessionReviews`' `tierOf`, which also defaults to it), the in-memory `SessionDO` in `@earshot/voice/testing`, the tray, the evals, and later the inbox, the pilot builder, and policies. WP1's stand-in, `anyFlagTier` (any flag loud), survives only as a test helper in `@earshot/events/testing`, for the writer rules' own tests. With the real tiers a lone `self_correction` is unmarked, so "accept all" takes it.
- **Pure.** It imports types alone from the linker and the faithfulness check, so its bundle is its own file (about 3.4 KB unminified, 1.8 KB minified), for the edge Worker, the web Worker, and the browser.
- A record offered at review time (WP12) also makes a card loud, so "accept all" leaves it; it isn't a flag, and the evals don't count it.

### The budgets, measured before anything changed

On the 200 debriefs' 751 final proposals, both adapters alike (spec WP4 step 2):

| Share | Value |
|---|---|
| Loud | 15.8% (119) |
| The loud floor: asks, conflicts, and unsupported values alone | **15.7% (118)**: 68 witness conflicts (9.1%), 32 linker asks (4.3%), 20 unsupported targets (2.7%), with 2 proposals both an ask and a conflict |
| Loud from the rest | 1 proposal: a new record with a sound-alike at p between 0.05 and 0.20 |
| Marked (loud or a card note) | 30.1% (226) |
| The name note alone | 15.7% (118) |
| Quiet card notes, by reason | 40 new records with no sound-alike, 32 negations, 24 implied targets, 20 values the normalizers fixed |
| Surfacing (seeded errors marked) | 100% (40 of 40) |

**The floor is over 15%,** so no display rule can bring loud under the spec's budget. Spec §9 would stop and ask; the orchestrator decided instead (2026-11-20):

- **The loud gate is an interim ceiling, 18%:** the floor plus 2 points, rounded up to a whole percent (`LOUD_SHARE_INTERIM_CEILING` in `packages/evals/src/understanding/tiers.ts`). A test fails when the floor moves, so the ceiling is set again, or dropped for 15%, on purpose.
- **The real fix is fewer false witness conflicts:** 22 of the 68 conflicts aren't ones the scripts expect, and 19 of those turned right links into asks (ADR-0031). That's a linker or witness change, after Phase 4's mined set runs (its WP6). WP4 changed no linker or witness threshold.
- **The loud `new_entity` bar stays at p ≥ 0.05.** The spec raises it to 0.20 only when the floor is under 15% and loud isn't; here it would quiet one proposal and change nothing about the budget.
- The 200 debriefs over-represent hard cases by design (48 snapped names, 20 paraphrased targets), so their loud share is an upper reference for real use.

**The gates** (`eval:understanding --check`, in `checks`): loud ≤ 18% (interim; target 15%), marked ≤ 35%, surfacing ≥ 95%, for each provider. **Reported:** the floor, the name-note share, per-tier precision, and wrong accounts with no marker.

**Precision** (the share the ground truth says needs a choice, an edit, or a rejection; a question offering the record the ground truth names outright is a false alarm):

| Tier | Precision |
|---|---|
| Loud | 65.5% (78 of 119), over the 50% aim. By reason: unsupported 100% (20/20), conflicts 69.1% (47/68), asks 37.5% (12/32: 20 are linker v1 asking where the scripts' context rule links), the sound-alike 0% (0/1) |
| Quiet, card notes | 0% (0 of 107): by construction, since the cassettes' quiet notes sit on right values |
| The name note alone | 0.8% (1 of 118): the d193 wrong account, marked only by its note |

**Hidden wrong accounts: 1**, d037's snapped new name, linked by context at p 0.998, above `link_uncertain`'s 0.97, so nothing marks it (ADR-0028's known gap, near-miss names that link anyway).

### First-person uncertainty

`apps/web/lib/inbox/voice.ts` holds one template per loud reason, in the UI's words, never written by a model, and never on a quiet or unmarked card (spec decision 9). The line's first sentence is also the card's accessible description: "Task, Acme Corp, needs a check: I'm not sure I caught the company."

| Reason | Line |
|---|---|
| Witness conflict on the target | "I'm not sure I caught the company. Acme or Akme?" (the name, the deal, the record, by the target's kind) |
| Witness conflict on a field | "I'm not sure I caught the name. “Dana Lee” or “Dana Li”?" |
| The linker asked | "I'm not sure which company you meant. Acme Dynamics or Akme Dynamics?" ("who you meant" for a person) |
| Unsupported target | "I couldn't find the company's name in what you said, so I haven't picked a record." |
| Unsupported field | "I couldn't find the words for the due date in what you said." |
| Ambiguous value | "I heard “next Friday”. Did you mean the 27th or the 4th?" |
| Mismatch not fixed, after a self-correction | "You corrected yourself here, and I may have kept the first date: March 6." |
| Mismatch not fixed, otherwise | "I may not have written the email the way you said it: dana@acme.io." |
| New, with a sound-alike | "I didn't find “Atmo Systems” in your CRM. Did you mean Atmos Industrial, or is it new?" |
| Re-link offer (WP12) | "Acme Robotics was added to your CRM after you spoke. Is it this one?" |

Two lines depart from the spec's examples, for the data's sake: an unsupported target names its kind, not the model's words, because the words the transcript doesn't hold aren't kept on the proposal; and an unfixed mismatch with no self-correction (a name, an email, a stage, or another currency) gets its own line, since the spec's covers only the correction.

The quiet notes sit beside `RISK_LABELS` (`apps/web/lib/capture/copy.ts`): "Open account assumed", "Corrected from March 6" (the value a reading replaced), "Said in a negation: “…”" (the words), "Creates a record", and the rest; the name notes are "matched by sound" and "matched in context". The capture tray already shows the name note in the card's heading and no longer shows `link_uncertain` as a badge; WP5 and WP6 put the rest on the inbox's card.

### The inbox (WP5)

**Where it is.** `/inbox` (`apps/web/app/(app)/inbox/page.tsx`) reads the inbox on the server and hands it to one client view, `InboxView` (`components/inbox/inbox-view.tsx`). `GET /api/inbox` (same-site, `no-store`) reads it again, for polling and "Load older". Both run `readInbox` (`lib/inbox/read.ts`): the repair path first (`repairUnsealedSessions`, ADR-0032, with `sealSessions` given at most 3 s so an unreachable edge Worker can't hold the page), then the loader.

**The loader** (`lib/inbox/load.ts`, in the viewer's `withTenant` transaction): the viewer's own latest 20 debriefs that have proposals (target), newest first, with a cursor for "Load older" (start time and id). For each: its `proposals` rows, which `rebuildProjections` writes one `ProposalView` each, read back as views with only the parts of the latest review the page needs (id, decision, record, mode, batch, what it undoes, `syncEligibleAt`, time); the utterances their quotes come from; and every record the cards name (targets, candidates, the company said with a target, the focus account), each with its account (a contact's or deal's company, found as the session routes find parents) and the values an update compares against (a deal's stage, amount, and close date; a contact's title, email, and phone). One query per kind of thing, never one per session.

**The sections and groups** (`lib/inbox/groups.ts`, pure, rerun on every render so the page's own reviews move cards at once):

| Section | What's in it |
|---|---|
| Needs review | A sealed debrief's proposals still `proposed` and not snoozed: one group per debrief, headed "Acme Corp · today, 2:14 pm" by its focus account, else the account its proposals name most, else "Debrief"; a sub-heading per account when its cards name more than one (a question's account is the one company all its records belong to, else none) |
| Finishing | A debrief that isn't sealed yet: "Finishing, usually under a minute" once ended, "Still being recorded" before; polled every 10 s (target) while the page is visible, each poll running the repair path |
| Reviewed | Every decided proposal, newest first, with Undo until its `syncEligibleAt` (a rejection: 30 s after it), then Reopen; both reopen the proposal |
| Snoozed | Proposals snoozed into the future, soonest first, with "Review now" (a snooze with no time) |

The time is the reviewer's own: the server renders it in UTC, saying so, and the page swaps in "today, 2:14 pm" as it hydrates (`useSyncExternalStore`), so the two never disagree mid-hydration.

**The list.** Each group's cards are an `<ol>` labelled by its heading (with the account's sub-heading when there is one), so a screen reader announces "list, Acme Corp · today, 2:14 pm, 4 items". Each card is a `<li><article tabindex aria-labelledby aria-describedby>` (`components/inbox/proposal-card.tsx`): the heading names the type and the record ("Task · Acme Corp", with the name note beside a near link); a loud card adds the amber marker ("Needs a check") and its first-person line, which is also its description ("Task, Acme Corp, needs a check: I'm not sure I caught the company."); quiet notes are short muted lines, on their field or the card; unmarked cards are plain. Fields are diff rows: the CRM's value, an arrow, the proposed value for an update ("Appointment scheduled → proposal"), and "Heard: …" under every field. The actions are a Base UI Toolbar of native buttons (Accept, Edit, Reject, and More: three snoozes and Correct), each with `aria-keyshortcuts` while the shortcuts are on.

**Choices, and why a digit never changes a record.** A card's numbered choices (`lib/inbox/card.ts`, a Base UI Radio Group, 1–3, and 4 when the linker offered three records and "New") appear only where its first loud reason has something to choose: a question's records with their odds, a new record's sound-alikes and "New", a field's two readings when the witnesses disagree, or an ambiguous value's readings. Picking one with the pointer or the arrow keys only selects it; a digit, or Accept, decides. A linked card shows no records at all: its other candidates appear only in the correction panel (c, or More → Correct), where a digit chooses one and approves with it (`target` set). Accept on a question with nothing picked says "Choose a record first" and moves focus to the choices; a card with no record can't be accepted and says why.

**Roving focus** (`use-roving-focus.ts`): one card is in the tab order (`tabIndex` 0), the rest -1. j and k move across groups and don't wrap; Tab goes into the active card's toolbar (one stop, arrows inside); focus arriving in a card any other way makes it the active one. Every move lands on a card or the "All caught up" heading, never `<body>`.

**Focus after a card leaves** (`lib/inbox/focus.ts`, pure): the next card in its group; the previous, if it was the last; the next group's first card; then, departing from the spec's list, the last card of the group before when only earlier groups have cards left (going straight to "All caught up" would say nothing's left while something is); then the "All caught up" heading, which takes focus. Undo brings the card back and focuses it. Focus moves in the same render the card leaves in, before paint (within the 100 ms target). A card's menu would return focus to its trigger as it closes; the page tells it not to when the action moved focus on (`finalFocus`).

**The shortcuts** (`lib/inbox/keys.ts`, `use-inbox-keys.ts`): j and k move; a accepts; e edits; r rejects; s snoozes until tomorrow at 9:00 local time (More offers three hours or next Monday at 9:00); c opens the correction panel (on a question, its choices); u undoes the latest thing done here that still stands; 1–4 choose and accept; ? opens the help, which carries the NVDA+Space advice. No Space, no ⌘↵, no modifiers. One handler sits on the element holding the lists and the "All caught up" heading, so a key acts only while focus is inside it. It ignores keys from text fields and anything editable, from inside an open editor (which keeps Enter and Esc), from portals React bubbles up (a card's menu), and, inside the correction panel, everything but its digits. Settings → Review (`app/(app)/settings/review/page.tsx`) turns them off per device (`earshot.inbox.shortcuts` in localStorage, read through `useSyncExternalStore`); off, no single key acts, the keys leave the buttons, and so does `aria-keyshortcuts`.

**Editing** (`edit-form.tsx`, `lib/inbox/edit.ts`): the fields become labelled inputs (dates and times the browser's own controls, an ambiguous value's readings as radio choices, long text a textarea). Each error is tied to its field (`aria-invalid`, `aria-describedby`): a number that isn't one, a day that doesn't exist, a time that isn't `HH:MM`, or an edit that changes nothing. Enter saves as `edited` with the changed fields as `editDiff`; Esc cancels; focus returns to the card either way.

**Messages.** Each action says one polite thing through Base UI's toaster (priority `low`), replacing the last: "Accepted: task for Acme Corp. 4 left. Press U to undo." (the key only while the shortcuts are on), with an Undo button. A refusal says one urgent thing (priority `high`). The inbox has no live region of its own: the e2e checks `main` holds none. A focused card keeps clear of the toast and the header as it scrolls in (`scroll-margin`).

**Sinks, and optimism** (`lib/inbox/sinks.ts`): every action goes through a `ReviewSink`, here `routeSink`, `POST /api/sessions/:id/reviews`; WP6's tray passes the socket, WP7's pilot a local sink. `OptimisticReviews` applies each change to the page at once, sends the changes one at a time in order (so an undo never overtakes the review it reverses), and on a refusal brings the card back as it was, drops anything queued after it for the same proposal, and reports it once. The page asks before the tab closes while anything is still on its way. A fresh load reconciles what it already holds.

**What each review records** (`lib/inbox/review.ts`): a UUIDv7 `reviewId` from the page; `mode: "single"`; the record chosen, if any; `seen` (the card's tier, each field's proposed value with the CRM's value as `base` for an update, since there's no history yet to tell it from `current` (WP12), the record shown and the records offered, and `clip: "none"` until WP9); `timing` from the review clock; `input` from the event that made it (a key, a click with no pointer type for Enter or Space on a button, a pointer, or touch); `surface: "inbox"`. Undo and Reopen send a reopen naming the latest review, `reason: "undo"`, with zero timing, since no card is on screen to time. The route adds `by` and `syncEligibleAt`.

**The review clock** (`lib/inbox/clock.ts`, pure on an injected clock; `use-review-clock.ts` feeds it). It runs for the active card (the first on load) while it's at least half visible (an IntersectionObserver), the page is visible, and the reviewer has given a key, pointer, wheel, scroll, or touch input in the last 30 s (target); the 30 s before a pause count, the gap after doesn't. Each card keeps its own time across moves. `decisionMs` is its time at the first decision key or click (a, e, r, s, c, a digit, or their buttons); `handlingMs` at the commit: the same moment for a, r, s, and digits, the save for e, the choice for c. A commit hands both over and starts the card at zero. It arms nothing until the page mounts, so it renders on the server.

**Development's "Finishing".** Zero-setup development runs no flush, so nothing ever finishes there. Under `next dev` only, Settings → Data offers "Load a finishing debrief", which imports a third sample unsealed (`importSessionLog`'s `seal: false`, ending it now), so the state can be seen and tested; the repair path seals it after 10 minutes.

### "Accept all" (WP6) and diff cards (WP12)

To be written by those packages: the batch checkpoint (which takes only what `tierOf` leaves unmarked), the tray on the inbox's card, and before → after with history and 3-way cards.

## Consequences

**Good**

- One rule table decides what every surface marks and what "accept all" and policies take; the writers can't disagree with the cards.
- The marks are measured and gated at $0 on every PR: loud, marked, surfacing, with precision and hidden wrong accounts reported.
- Loud marks are precise on the synthetic set (65.5%), and every seeded error carries a marker.
- The badge share falls from 45.8% to 30.1% without changing a decision, since `link_uncertain` moved beside the name.
- Doubt is phrased in the first person only where Earshot has something to settle, and the copy is testable.
- The inbox works by key, pointer, and screen reader alike: every action is a native button, the keys are only a faster way to them, and they act only where focus says they should.
- A stray digit can't relink a record: only a card that asks offers numbered records, and a linked card's others live behind c.
- One region speaks, once per action; failures interrupt, nothing else does.
- Each review carries what the pilot and Phase 6 need (`seen`, `timing`, `input`, `surface`), from one clock with fake-clock tests.
- The page's own reviews show at once and survive refusals: the card comes back with a message, and nothing queued behind it is sent.

**Bad**

- **The loud budget isn't met:** it's gated at an interim 18%, against the spec's 15%, until false witness conflicts fall, which needs the mined set and a linker or witness change.
- Synthetic precision flatters: the cassettes are the ground truth plus seeded errors, so quiet notes are 0% precise by construction, and loud precision says nothing yet about real speech (spec Appendix B, #12).
- A wrong account linked by context or sound above p 0.97 carries no marker at all (d037). Making sound links loud, or a sensitivity setting, are candidates after the pilot (spec §8), not before.
- Linker asks are imprecise here (37.5%): linker v1 asks where the scripts' context rule links. They stay loud, since an ask can't be accepted as it stands.
- An unsupported target's line can't quote the model's words, which the proposal doesn't keep.
- The name note makes 118 proposals (15.7%) ineligible for "accept all" though only one of them was wrong: recall for wrong accounts, bought with review time.
- Keys need focus in the list: arriving on the page, a keyboard user tabs to the first card (or clicks one) before j and a do anything. That's SC 2.1.4's price for keys that are on by default.
- NVDA's browse mode keeps several of the letters and the digits; its users press NVDA+Space or Tab to the buttons. Whether NVDA and JAWS stay in focus mode as j and k move between non-widget cards is WP16's to find out (spec Appendix B, #3).
- Base UI 1.9 announces an urgent toast through its own visually hidden `role="alert"` copy and hides the visible toast with `aria-hidden` until focus enters the region, though it stays focusable; axe flags that (`aria-hidden-focus`). No state the gate lists shows a failure, and the one story that does turns that rule off, with the reason. Upstream, or a toast that leaves the tab order while hidden, would fix it.
- `seen.fields[].base` is the CRM's value when the card was shown, not when the proposal was made, until WP12's history can tell them apart.
- An undo or a reopen records zero timing.
- Optimism means a review can be lost if the tab closes in the instant it's sent; the page asks first while anything is on its way.

## More information

- Spec: `reports/Earshot Phase 5 build spec.md`, decisions 8 and 9, §4.4, WP4, §8, and §9. Research: `research_notes/Earshot Phase 5 tooling check/notes.md`, sections 3 and 9.
- `tierOf`: `packages/understanding/src/tiers/index.ts`, tested in `packages/understanding/test/tiers.test.ts`, with its bundle and no-DOM checks.
- The metrics and gates: `packages/evals/src/understanding/{tiers,metrics,gate,report}.ts`, tested in `packages/evals/test/{tiers,understanding}.test.ts`; the baseline in `packages/evals/baselines/understanding.json`. Run `pnpm --filter @earshot/evals eval:understanding`.
- The writers: `TIER_OF` in `apps/edge/src/session-do.ts`, `writeSessionReviews` in `packages/db/src/reviews.ts`, `apps/web/lib/reviews/routes.ts`, and `packages/voice/src/testing/fake-session-server.ts`.
- The copy: `apps/web/lib/inbox/voice.ts` and `apps/web/lib/capture/copy.ts`, tested in `apps/web/test/inbox-voice.test.ts`; the tray in `apps/web/components/capture/proposals-tray.tsx`.
- The inbox (WP5): spec decision 7, §4.8, and WP5; research sections 3 and 4. `apps/web/app/(app)/inbox/page.tsx`, `apps/web/app/api/inbox/route.ts`, `apps/web/components/inbox/`, and `apps/web/lib/inbox/{load,read,groups,card,focus,keys,clock,sinks,review,edit,time,copy}.ts`; Settings → Review in `apps/web/app/(app)/settings/review/page.tsx`. Tested in `apps/web/test/inbox.test.ts` (grouping, focus, keys, the card, the sink's rollback, the clock on a fake clock) and `apps/web/test/inbox-load.test.ts` (the loader and `GET /api/inbox` on PGlite); stories with axe in `apps/web/components/inbox/*.stories.tsx`; and the Playwright `inbox` project (`apps/web/e2e/inbox/`, in CI's `ui` job): keyboard and pointer review, the shortcuts' scope and switch, focus never on `<body>`, and axe (WCAG 2.2 AA, serious and critical) in light and dark in every state.
