# ADR-0035: The review inbox: a list with roving focus, focus-scoped single-key shortcuts, one message per action, the batch checkpoint, likely-edit tiers, first-person uncertainty, and diff cards

## Status

Proposed (2026-11-20). Phase 5 WP4 drafted the likely-edit tiers and first-person uncertainty (below): `tierOf`, the tiers' $0 budgets in `checks`, the copy, and `tierOf` in place of WP1's stand-in in every writer. WP5 adds the inbox's structure (the list, roving focus, the shortcuts, messages, focus), WP6 the "accept all" checkpoint and the tray on the inbox's card, and WP12 diff cards. Amends ADR-0031 (its "Phase 5: the likely-edit tiers").

## Context and problem

Phase 4 writes flags on proposals: fourteen kinds, from the linker, the normalizers, the faithfulness check, and the second witness. Phase 4's tray showed every flag as a badge, and on the 200 debriefs 45.8% of proposals carried at least one (ADR-0031), against a 35% guard. A sea of badges teaches reviewers to ignore them:

- Highlights helped only when precise. Edit-likelihood highlights in Vasconcelos et al. (TOCHI 2024) marked tokens of which 64.7% were edited, and cut review time; generation-probability highlights tuned to the same density had 26.1% edited, and gave no benefit. Raw speech-recognition confidence didn't help either (Kuhn et al., CHI EA 2025). QE4PE (TACL 2025) found the highlighted share drove editing time.
- Wrong accounts are recall-critical: a reviewer who learns that unmarked means safe will miss the one that isn't (Xu, Lien, and Höllerer, CHI 2023, on high-recall suggestions).
- Phrasing doubt in the first person cut agreement with a wrong AI and raised accuracy (Kim et al., FAccT 2024), but there it sat on a random half of the answers; over-flagging buys underreliance, since accuracy on right answers fell.

So the cards need marks that are rare where they're loud, still present where an error would otherwise hide, and computed the same way by every part of Earshot that decides what a reviewer sees or what "accept all" takes.

## Considered options

- **What decides a mark:** **two tiers from Phase 4's flags and decisions, by one rule table (chosen)**; one confidence threshold (raw confidence didn't help); a learned likely-edit model (Phase 8, from approve, edit, and reject signals); token-level marks (they raised agreement with the AI in Villavicencio et al., FAccT 2026).
- **`link_uncertain`** (ADR-0031's options): **option 2, a note beside the record's name, now (chosen)**; option 1, moving its bar for context links to p below 0.90, after Phase 4's mined set measures its real precision; leaving it a badge.
- **The loud budget, when display rules can't meet it:** **gate an interim ceiling at the measured floor plus 2 points, and fix the false conflicts later (chosen; the orchestrator's decision under spec §9)**; changing the witness threshold now; leaving loud ungated until the floor falls.
- **The first-person line:** **templates on loud cards only (chosen)**; hedges written by the model; the general phrasing ("It's not clear…"), whose effects were weaker and not significant.

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

### The inbox (WP5), "accept all" (WP6), and diff cards (WP12)

To be written by those packages: the list, roving focus, focus-scoped single-key shortcuts and their switch, one message per action, focus after a card leaves, the batch checkpoint (which takes only what `tierOf` leaves unmarked), the tray on the inbox's card, and before → after and 3-way cards.

## Consequences

**Good**

- One rule table decides what every surface marks and what "accept all" and policies take; the writers can't disagree with the cards.
- The marks are measured and gated at $0 on every PR: loud, marked, surfacing, with precision and hidden wrong accounts reported.
- Loud marks are precise on the synthetic set (65.5%), and every seeded error carries a marker.
- The badge share falls from 45.8% to 30.1% without changing a decision, since `link_uncertain` moved beside the name.
- Doubt is phrased in the first person only where Earshot has something to settle, and the copy is testable.

**Bad**

- **The loud budget isn't met:** it's gated at an interim 18%, against the spec's 15%, until false witness conflicts fall, which needs the mined set and a linker or witness change.
- Synthetic precision flatters: the cassettes are the ground truth plus seeded errors, so quiet notes are 0% precise by construction, and loud precision says nothing yet about real speech (spec Appendix B, #12).
- A wrong account linked by context or sound above p 0.97 carries no marker at all (d037). Making sound links loud, or a sensitivity setting, are candidates after the pilot (spec §8), not before.
- Linker asks are imprecise here (37.5%): linker v1 asks where the scripts' context rule links. They stay loud, since an ask can't be accepted as it stands.
- An unsupported target's line can't quote the model's words, which the proposal doesn't keep.
- The name note makes 118 proposals (15.7%) ineligible for "accept all" though only one of them was wrong: recall for wrong accounts, bought with review time.

## More information

- Spec: `reports/Earshot Phase 5 build spec.md`, decisions 8 and 9, §4.4, WP4, §8, and §9. Research: `research_notes/Earshot Phase 5 tooling check/notes.md`, sections 3 and 9.
- `tierOf`: `packages/understanding/src/tiers/index.ts`, tested in `packages/understanding/test/tiers.test.ts`, with its bundle and no-DOM checks.
- The metrics and gates: `packages/evals/src/understanding/{tiers,metrics,gate,report}.ts`, tested in `packages/evals/test/{tiers,understanding}.test.ts`; the baseline in `packages/evals/baselines/understanding.json`. Run `pnpm --filter @earshot/evals eval:understanding`.
- The writers: `TIER_OF` in `apps/edge/src/session-do.ts`, `writeSessionReviews` in `packages/db/src/reviews.ts`, `apps/web/lib/reviews/routes.ts`, and `packages/voice/src/testing/fake-session-server.ts`.
- The copy: `apps/web/lib/inbox/voice.ts` and `apps/web/lib/capture/copy.ts`, tested in `apps/web/test/inbox-voice.test.ts`; the tray in `apps/web/components/capture/proposals-tray.tsx`.
