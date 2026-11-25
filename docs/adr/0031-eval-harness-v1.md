# ADR-0031: Eval harness v1 and the $0 gates: 200 debriefs from a seeded grammar, offline cassettes with seeded model-like errors, and the understanding gate in `checks`

## Status

Accepted (2026-11-20). Drafted by Phase 4 WP10, which built:

- debrief format v2;
- the generator and d031–d200;
- the extended ground-truth checks;
- the understanding cassettes, with seeded and labelled errors;
- the understanding report, and its gate in CI's `checks` job, with a baseline.

WP11 built the live smoke tier (below): its set, runner, noise band, and budget guards, off until the user turns it on (WP11b). WP12 accepted it, amended ADR-0026, and showed gate G3a: #49, which dropped the phonetic candidate sources, was blocked by `checks`. Builds on ADR-0026 (harness v0), ADR-0027 (contracts and the pipeline), ADR-0028 (the linker, the confusable set and its simulator), ADR-0029 (the second witness), and ADR-0030 (the normalizers).

Amended 2026-11-20 by Phase 5 WP4: option 2 below is adopted (`link_uncertain` beside the record's name, not a card flag); option 1 waits for Phase 4's mined set; the understanding report gains the likely-edit tiers' metrics, and the gate their budgets, with the loud share held to an interim ceiling of 18% because asks, conflicts, and unsupported values alone are 15.7% of proposals. See "Phase 5: the likely-edit tiers", and ADR-0035. Amended 2026-11-25 for Phase 5 WP10 and WP8: a third $0 gate in `checks`, `eval:recap`, the recap in the live smoke eval, and the scripted reviewer's tier. See "Phase 5: the recap's gate, the smoke eval's recap, and the scripted reviewer", ADR-0037, and ADR-0039.

## Context and problem

Phase 4's gate needs two things from the debrief evals (spec §6):

- **G2b:** across all 200 debriefs, 100% of fields and named targets have evidence whose span text is the quote, and no unquoted target is linked.
- **G3a:** a $0 understanding check in the required `checks` job that fails on regressions.

Harness v0's 30 hand-written scripts (ADR-0026) can't carry that alone. Each was written by hand, so 30 is the practical ceiling. They have no transcript other than what was said, so mishearings, snapped names, and conflicts between the witnesses never occur. At 30 scripts, one turn moves a rate by about a point.

The constraints:

- CI stays at $0, with no model, speech, or other paid call;
- the check is deterministic, and runs in seconds;
- labels are true by construction, and every one can be re-derived;
- the fake-microphone eval keeps rendering exactly the 30 scripts it renders today.

## Considered options

- **The 170 new scripts:**
  - *a seeded grammar over the demo CRM, labelled by the confusable set's oracle (chosen);*
  - LLM-written scripts, which aren't reproducible and need the same machine checks (spec decision 15);
  - more hand-written scripts, which can't be re-derived at 200.
- **Where they live:**
  - *`packages/evals/debriefs/generated/` (chosen);*
  - beside d001–d030, as the spec's layout draws it. The renderer, its pytest suite, and the WAV cache key all glob `debriefs/*.json`. The fake-microphone eval would start rendering 200 scripts with Kokoro, and every regeneration would change the WAV cache key.
- **The model's side:**
  - *cassettes built offline from the ground truth, with seeded and labelled model-like errors (chosen);*
  - live recordings, which need keys and money, and are WP11's;
  - error-free cassettes, which would test the plumbing and nothing else.
- **What the gate runs:**
  - *every turn replayed through the real LLM adapters, `runTurn`, and `witnessTurn` (chosen; about 3 s here);*
  - calling `understand()` directly, which would skip the adapters' parsing.

## Decision

### The tiers

| Tier | What | Runs in | Cost |
|---|---|---|---|
| (a) $0 deterministic gates | `eval:linking --check` (G1a, ADR-0028) and `eval:understanding --check` (G2b and the regression check, below) | `checks`, required, every PR | $0 |
| (b) $0 fake-microphone eval | The original 30 rendered scripts, end to end through the capture screen (ADR-0026) | `ui` (5 scripts) and `eval` (all 30) | $0 |
| (c) Live smoke eval | 30 scripts as text through a real model (WP11); off until the user turns it on | `eval-smoke`, opt-in | Budget-guarded |
| (d) `eval-live` | Real providers end to end, by hand (ADR-0026) | Manual | Budget-guarded |

### Debrief format v2 (`packages/evals/src/schema.ts`)

**Per turn:**

- `heard.biased` is what the keyterm-biased production stream wrote, and `heard.unbiased` is what the second witness wrote. Both default to `text`. Every quote must be a substring of `heard.biased`.
- `tags` gains `disfluency`, beside `negation` and `self_correction`. Each tag must be backed by the text.

**Per proposal:**

- The expected target is `{ id, decision }`: the record (null for a new record or none), and the decision after the second witness. An "ask" names the record the rep meant, or null for a new one, and the question must offer it.
- Optional `expectFlags`: risk kinds the pipeline must raise. Others may come too.
- The `meeting` type, with an `HH:MM` time.

**Per script:** optional `noise: { kind: "none" | "car" | "street" | "cafe", snrDb }`, with `snrDb` from −10 to 60. A test holds these to `lab/scripts/debrief_noise.py`'s constants. Absent means quiet.

**The v1 files.** The 30 hand-written files stay format v1 on disk, and `upgradeDebriefScript` upgrades them in code. Their bytes decide the WAV hashes and the e2e cassettes, so neither moves. The renderer reads `text`. The fake speech-to-text adapter emits `heard.biased`, which equals `text` for the 30 rendered scripts.

Swapping the fake-microphone set for a stratified 30 of the 200 (spec WP10 step 8) needs one more change. The renderer's `timing.json` has to carry `heard.biased`'s words while Kokoro speaks `text`, and the capture screen's fake voice has to stop requiring the two to match.

### The generator (`src/grammar/`, `scripts/gen-debriefs.ts`)

**Seeds.** The seed is SHA-256's sixth initial hash word; the confusable set uses the fifth. One stream plans every script: its account, voice, time zone, call time, noise, and turn count. Each script then gets its own stream, so editing how one script is written doesn't move another's draws. A test regenerates all 170 files and their import index, byte for byte.

**Scripts.** Each script is a debrief about one account. That account is open in Earshot in four scripts out of five.

- Accounts are dealt from shuffled rounds of the 60 companies, each counted once more for being in a confusable group and once more for having a deal to update.
- Each script has 3 to 5 turns.
- Calls fall on weekdays from 2026-11-02 to 2027-02-26, between 08:00 and 18:00 local time, in five time zones. Every call time is unique across all 200.
- The 28 Kokoro voices are dealt in rounds.
- 93 of the 170 scripts carry noise: car, street, or cafe, at 0 to 20 dB.

**Templates** (`templates.ts`): 17 to 22 phrasings per proposal type, counting those that name no record.

- In those, the open account stands in, with `implied_target` expected.
- Turns that propose nothing either end the debrief, or, more often, set a sound-alike account aside with a negation ("Not to be confused with Akme Dynamics, which is a different account.").
- Slots come from the demo CRM: names, aliases, deals, titles, and emails. Values come from phrase builders (`phrases.ts`), and the evals' own resolvers re-derive each one (decision 13). Dates are mostly relative ("by Friday", "in two weeks", "by the end of next month"), and some are dated. Amounts are said in words, and the streams write about two in five as digits ("$42,000"). Times always say their half of the day ("at 2 pm").

**Disfluency** (`disfluency.ts`), after LARD (arXiv 2201.05041): its repetitions, replacements ("for, uh, to"), and restarts, plus fillers.

- Disfluencies go into about a third of turns, only outside fields and names, and never next to a date, amount, time, stage, email, or phone. So every quote stays a substring, and the normalizers read every value the same way.
- 39 of the 170 scripts take back a date or an amount ("by March 6th, make that March 4th"). The correction's words are frozen against disfluency.

**Negations:**

- quiet turns that set an account aside;
- a stage the deal "isn't at yet";
- a note's clause or a promise that carries one. The field is then expected to be flagged `negation`.

**Names** (`mentions.ts`) go through WP3's mishearing simulator under the frozen keyterm policy `keytermListV1`, exactly as `confusable.v1`'s do.

- **Labels.** Each target is labelled by the confusable set's oracle, from what the biased witness heard, with the context the session has at that point. That context is the open account, the company said in the same breath, and earlier links, kept as `withRecentLinks` keeps them, the company linked beside a contact or inside a deal's words included.
- **Rejected draws.** A draw the label doesn't fit is thrown away and drawn again: a record the oracle doesn't link, or an "ask", accepted only 30% of the time.
- **Snapped names.** 48 of the 170 scripts name a new company or person that a forced snap puts onto a CRM spelling. The oracle must read the biased words as that record, and the unbiased words as new. Those expect "ask", through the witness, and `witness_conflict`.

**Coverage.** All 200 scripts, against the spec's minimums (targets):

| Rule | Minimum | Now |
|---|---|---|
| Scripts | 200 | 200 |
| Turns expecting a proposal | 600 | 729 |
| Each proposal type | 40 | note 190, task 174, deal update 122, meeting 117, commitment 80, contact 68 |
| Explicit mentions of a confusable-group member | 300 | 401 |
| Relative dates | 80 | 255 |
| Amounts | 80 | 88 |
| Negations (turns) | 40 | 93 |
| Self-corrections (turns) | 30 | 43 |
| Disfluent turns | 150 | 242 |
| Witness conflicts | 25 | 48 |
| Distinct voices | 20 | 28 |

That's 803 turns, 751 proposals, 24 implied targets, and 36 new contacts. Amounts have the least room: deal updates exist only for accounts with a deal.

### The ground-truth checks (`src/understanding/verify.ts`)

The checks extend `src/verify.ts`:

- Every quote is a substring of `heard.biased`. That covers fields, the target's words, and the company said with them.
- Every date, time, and amount is re-derived from its words.
- Names are written as heard. Stages, titles, emails, and phones appear word for word.
- Every tag is backed by the text.
- Every target of a generated script resolves by construction. The oracle is re-run with the session's context at that point, and it gives the label back. For a snapped name, the unbiased words are read off `heard.unbiased` by the words the two transcripts share, and must read as new.

The 30 hand-written scripts keep their own checks. Their asks are linker v1's decisions from WP8, not the oracle's. A conformance test runs the product's normalizers and faithfulness check over all 1,351 ground-truth fields. Every date, time, and amount agrees, every value passes unchanged, and the only flag is `negation`, exactly where the scripts expect it.

### Cassettes and seeded errors (`src/understanding/cassettes.ts`)

**What the cassettes are.** Cassettes for all 200 scripts on both adapters, built by `cassettes:gen` through the real adapters and `runTurn`, as ADR-0026's are. Each request carries `heard.biased`. One script's cassette sits on each line, about 1 MB per provider.

**The seeded errors.** The drafts carry errors chosen by a seeded shuffle, so the counts are exact, and labelled in `errors.json`:

| Error | Rate | Seeded |
|---|---|---|
| A wrong date, with the right words quoted (±1, 2, or 7 days) | 5% | 17 of 341 dates |
| A wrong amount, with the right words quoted | 3% | 3 of 88 amounts |
| A target quoted in words the transcript doesn't hold ("the Pier Logistics account") | 3% | 20 of 659 named targets |

The fake-microphone eval keeps its own error-free cassettes for the 30 (`cassettes/<provider>.json`).

### The metrics (`src/understanding/metrics.ts`)

These are written for any extractor, so WP11 can score a live model's runs the same way. Within a turn, each expected proposal is matched to the first unmatched actual proposal of its type.

| Metric | Definition |
|---|---|
| Key-field accuracy | `KEY_FIELDS` exactly right ÷ expected key fields |
| Proposal precision, recall | Matched ÷ actual, and ÷ expected, overall and per type |
| Joint action accuracy | Turns expecting a proposal whose proposals all match, with the right target and key fields and nothing extra, ÷ those turns |
| Target accuracy | Matched proposals whose final target is the expected decision ÷ expected proposals. A link must name the record; an ask must offer it. |
| End-to-end wrong-account rate | Final links to another record ÷ final decisions ("linked" or "new"), with the Clopper–Pearson bound, and the rate again with the witness off |
| Date, amount accuracy | Those key fields right ÷ expected |
| Negation accuracy | Turns tagged `negation` that are entirely right, a quiet one proposing nothing, ÷ those turns |
| Evidence coverage (G2b) | Fields and named targets whose evidence span is the model's quote once folded ÷ all of them. An unquoted target that's linked counts against it. |
| Conflict precision, recall | `witness_conflict` on proposals expected to conflict ÷ proposals flagged with it, and ÷ proposals expected to conflict |
| Flag share | Final proposals with any risk flag ÷ final proposals (the guard: 35% or less) |
| Seeded catches | A wrong date or amount replaced by its words' reading and flagged `value_mismatch`; a paraphrased target left unlinked and flagged `unsupported` |

### The gate (`src/understanding/gate.ts`)

CI's `checks` job runs `pnpm --filter @earshot/evals eval:understanding --check --summary` after the linking gate. For either provider, it fails on any of these:

- a key metric more than 3 points below `baselines/understanding.json`. The key metrics are key-field, proposal precision and recall, joint action, target, date, amount, and negation accuracy, conflict precision and recall, and the three seeded catch rates;
- an expected risk kind's catch rate more than 3 points below the baseline: of the proposals the scripts expect to carry `negation`, `new_entity`, `witness_conflict`, `ambiguous_target`, or `implied_target`, the share that did. Values and targets can stay right while a warning stops coming, and the accuracy metrics wouldn't notice; one lost `negation` flag of 26 fails it. Codex found the gap on #48;
- evidence coverage under 100%;
- an end-to-end wrong-account rate above 2%;
- a cassette miss;
- a baseline recorded on other scripts or other seeded errors. The baseline holds the files' SHA-256s, so it's re-recorded on purpose (`--write-baseline`).

### The baseline (both adapters score alike)

| Metric | Value |
|---|---|
| Key-field, date, amount accuracy | 100% (727, 341, and 88 fields) |
| Proposal precision and recall | 100% (751) |
| Joint action accuracy | 91.5% (664 of 726 turns) |
| Target accuracy | 91.7% (689 of 751) |
| End-to-end wrong-account rate | 0.3% (2 of 633 decided), bound 1.0% |
| The same with the witness off | 7.0% (49 of 699), bound 8.8% |
| Negation accuracy | 98.9% (92 of 93 turns) |
| Evidence coverage | 100% (2,010 items) |
| Conflict precision, recall | 67.6% (46 of 68), 95.8% (46 of 48) |
| Seeded catches | 17 of 17 dates, 3 of 3 amounts, 20 of 20 paraphrased targets |
| Flag share | 45.8% (344 of 751) |

**The 62 target misses:**

- 20 are the seeded paraphrases: left unlinked, as they should be.
- 20 are linker v1 asking where the oracle's context rule links: a sound-alike the open account, the company said, or an earlier link separates.
- 19 are false conflicts. The unbiased channel changed a sound, and a right link became an ask. A new record became an ask once.
- 2 are wrong accounts, both snapped new names whose unbiased reading the linker also links to the snapped record: "Priya Nash" to Priya Nair, and "Pierce Logistics" to Pier Logistics. That's ADR-0028's known gap, near-miss names that link anyway.

### The flag share is over the guard

45.8% of proposals carry a flag, against the 35% target. WP8 measured 41% on the 30 scripts; the 30 score 44% here, because their cassettes now carry seeded errors too.

**What carries it:**

- `link_uncertain` is on 129 proposals. 115 of those are links by context and 14 by sound, at a median p of 0.93; 90 are at 0.90 or more.
- 118 proposals carry `link_uncertain` and nothing else: 15.7 points.
- The seeded errors' `unsupported` and `value_mismatch` account for 4.5 points. Those flags are doing their job.
- The rest are designed in: 68 conflicts, 41 new records, 32 asks, 32 negations, and 24 implied targets.

**What WP10 changed:** nothing. The linker's thresholds and the flag rules are as WP4, WP5, WP7, and WP8 froze them.

**The remedy proposed** (WP10 applied none of it; Phase 5 WP4 adopted option 2 and left option 1 for the mined set, below):

1. **Raise `link_uncertain`'s bar for links by context to p below 0.90,** or put it only on links by sound. On this set the share falls to 34.9%, or 31.8%, with no decision changed: the flag is a badge, not a gate. Its 0.97 target came from the plan's first check, before calibration showed context links clustering at 0.93.
2. **Make the tray show `link_uncertain` beside the record's name rather than as a badge.** Leave the badge colors to Phase 5's likely-edit highlighting, as spec §8's own response says ("flags are data; the UI shows a subset"). With no `link_uncertain` badge the share is 30.1%.
3. **Before either, measure the flag's precision for likely edits on WP6's mined set,** which still waits for the user's approval. Synthetic context links may be more certain than real ones.

### Phase 5: the likely-edit tiers (amended 2026-11-20, WP4)

Phase 5's review cards mark proposals in two tiers, computed by one function, `tierOf` in `@earshot/understanding/tiers` (spec §4.4, decision 8; ADR-0035 has the rules). The eval measures them on the 200 debriefs, and the gate holds them to budgets.

**Option 2 is adopted.** `link_uncertain` is a note beside the record's name ("matched by sound" or "matched in context"), not a card flag; the tray dropped its badge. No decision changed: the flag is still raised where it was. The 35% guard against a sea of color now applies to the marked share (loud or a quiet note on the card), 30.1%; the raw flag share, 45.8%, is still reported. **Option 1** (moving `link_uncertain`'s rule for context links to p below 0.90) **waits for Phase 4's mined set** (WP6), which measures the flag's real precision first (option 3); synthetic context links cluster at p 0.93 and are mostly right, and real ones may not be.

**The new metrics** (`src/understanding/tiers.ts`), per provider:

| Metric | Definition | Budget |
|---|---|---|
| Loud share | Final proposals with a loud reason ÷ final proposals | 15% (target); gated at the interim ceiling, 18% |
| Loud floor | Final proposals with an ask, a witness conflict, or an unsupported value ÷ final proposals | Reported; sets the interim ceiling |
| Marked share | Final proposals with a loud reason or a quiet note on the card ÷ final proposals | 35%, gated |
| Name-note share | Final proposals whose only marker is the name note ÷ final proposals | Reported |
| Surfacing recall | Seeded errors (`errors.json`'s 40) whose proposal carries any marker, the name note included ÷ 40 | 95%, gated |
| Precision, per tier | Proposals in the tier the ground truth says need a choice, an edit, or a rejection ÷ proposals in the tier | Reported; aim 50% on loud |
| Hidden wrong accounts | Matched proposals linked to a record the ground truth doesn't name, with no marker | Reported |

"Needs a change" reads the ground truth: an extra proposal (a rejection); an expected ask, or a record the ground truth doesn't name, or a question that doesn't offer the record meant (a choice); a value stated differently or missing (an edit). A question that offers the record the ground truth names outright is a false alarm, so the 19 false conflicts count against loud precision rather than for it.

**Measured** (both adapters alike; 751 final proposals):

| Metric | Value |
|---|---|
| Loud share | 15.8% (119) |
| Loud floor | 15.7% (118): 32 asks, 68 conflicts, 20 unsupported targets; 2 proposals are both an ask and a conflict |
| Marked share | 30.1% (226) |
| Name-note share | 15.7% (118) |
| Surfacing recall | 100% (40 of 40) |
| Precision: loud; quiet card notes; the name note alone | 65.5% (78 of 119); 0% (0 of 107); 0.8% (1 of 118) |
| Loud precision by reason | unsupported 100% (20/20), conflicts 69.1% (47/68), asks 37.5% (12/32), new with a sound-alike 0% (0/1) |
| Hidden wrong accounts | 1 (d037: a snapped new name linked by context at p 0.998, so no `link_uncertain`); the other wrong account, d193, carries the name note |

Quiet precision is 0% by construction: the cassettes are the ground truth plus seeded errors, so a quiet note sits on a right value (a date the normalizers already fixed, a negation, an implied target, a new record). Real speech is Phase 4's mined set and Phase 8's question (spec Appendix B, #12).

**The new gates.** `eval:understanding --check` also fails, for either provider, when:

- the loud share is over **18%, an interim ceiling**, not the spec's 15%. Asks, conflicts, and unsupported values alone are over 15% (the floor above), and no display rule can quiet them, so the ceiling is the floor plus 2 points, rounded up to a whole percent (`LOUD_SHARE_INTERIM_CEILING`). The real fix is fewer false witness conflicts (22 of the 68 aren't conflicts the scripts expect, and 19 of those turned right links into asks): a linker or witness change once Phase 4's mined set has run, which WP4 didn't make. A test fails when the floor moves, so the ceiling is set again, or dropped for 15%, on purpose;
- the marked share is over 35%;
- surfacing recall is under 95%.

A share with nothing to divide (no proposals or no seeded errors) isn't gated. Because the floor is over 15%, spec WP4 step 2's other remedy, raising a loud `new_entity`'s bar from p 0.05 to 0.20, wasn't applied: it would quiet one proposal of 751 and still leave loud over 15%.

**The baseline**, re-recorded on purpose: every existing value is unchanged, and each provider gains `loudShare` 0.158455, `markedShare` 0.300932, `nameNoteShare` 0.157124, `loudFloorShare` 0.157124, `surfacingRecall` 1, `loudPrecision` 0.655462, `quietPrecision` 0, `nameNotePrecision` 0.008475, and `hiddenWrongAccounts` 1. The new values are recorded, not compared: the gate holds them to their budgets alone.

### Phase 5: the recap's gate, the smoke eval's recap, and the scripted reviewer (amended 2026-11-25, WP14)

Phase 5 WP10 added the session's recap (ADR-0037), and with it a third $0 gate and a second gated output in the live tier. WP8 added a tier that isn't about the model at all.

**The recap's cassettes** (`cassettes/recap/`). Recaps for all 200 debriefs, built offline from the ground truth, as the understanding cassettes are: a headline, a next step per task, a commitment per commitment, each quoting the script's own words, and a lens by rotation (none, MEDDIC, SPICED, BANT). Seeded errors are labelled in `seeded.json`: 10% of the ground truth's sentences (target) get a bad twin whose quote isn't in the transcript, invented or paraphrased, and 10% of the lens fields the rep never answered get an invented quote. `pnpm --filter @earshot/evals recap:gen` rebuilds them from seed `0x5be0cd19` by running the real adapters against provider responses built from the ground truth, and a test fails if the committed files drift.

**`eval:recap --check`**, in `checks` beside `eval:linking` and `eval:understanding`, replays them through `runRecap` and its checks on both providers. It fails unless every kept sentence carries evidence, every seeded bad sentence was dropped, every recap has a headline, every ground-truth sentence was kept, every invented lens quote came back "not mentioned", no request missed its cassette, and the weak-support share is within 3 points of `baselines/recap.json` (target). Measured, on both providers alike: 454 of 454 kept sentences with evidence, 45 of 45 seeded bad sentences dropped (9.0% of 499 written), 200 of 200 headlines, 454 of 454 ground-truth sentences kept, 53 of 53 invented lens quotes not mentioned, and weak support 47 of 454 (10.4%). The recap is given the ground truth's proposals as context, so an extraction mistake can't move its numbers. Like the understanding gate, it guards the checks after the model, not the model.

**The smoke eval's recap.** Each smoke script's run also writes its recap on the live model after its turns, through the same pacer and budget meter, on the same request as its cassette, so `--offline` replays the recap cassettes. It's gated on every script's recap being written, on 100% recap evidence, and on the drop rate against the baseline's median by max(5 points, 2 × the spread) (target); a recap whose output fails validation twice has no sentences, so the first check is there for it, and it allows the one re-run as a regression does. The estimate and the in-run guard include the recaps, never cached: Haiku 5.5's run rises from about $0.030 to $0.045 with the cache, and gpt-oss-20b's from about $0.102 to $0.117, over the $0.10 default budget, so a Groq run needs a budget set. The smoke baseline's format is 2, and none is recorded yet: the live tier is still off until the user sets it up (WP11b).

**The recap's live check** (`recap:live`): one recap per provider on a synthetic debrief, under $0.01, refused without `EARSHOT_RECAP_LIVE=1` and the user's keys. It waits for the user's approval.

**The scripted reviewer** (WP8, ADR-0039). A new $0 tier in `ui`: the review pilot's set, `pilot.v1`, decided by keyboard on a fake clock with the manifest's right answers, gating every card's markers, the keys per decision, focus, axe, and a KLM estimate per card against `baselines/pilot-klm.json`. It measures the cards a reviewer sees, not the model, and it's gates G1a and G2a's $0 half.

### The live smoke tier (WP11)

Tier (c): 30 debriefs as text through the live model, scored by the metrics above. It's $0 until the user sets it up (WP11b). WP11 made no live call.

**The set (`smoke.json`, `src/smoke/select.ts`).** A seeded greedy pick, re-run by a test against the committed file.

- **Strata:** the spec's (each type, confusable names, numbers, dates, negations, conflicts), plus misheard names, self-corrections, disfluencies, implied targets, and some hand-written scripts. Misheard names are named records the production stream heard wrong. They're where a model that "corrects" spellings loses the evidence, which is what the G3b test PR exercises.
- **What it holds:** 121 turns and 122 proposals, including 30 misheard names and 11 conflicts.
- **Left out:** d037 and d193, where linker v1 links a snapped name wrongly even from perfect drafts (the two wrong accounts above). With about 96 targets decided, each would be a point of wrong-account rate against a 2% gate. A test confirms a perfect model passes the absolute gates on the set.

**The runner (`src/smoke/run.ts`).** It reuses WP10's loop (`runScriptWith`):

- the biased transcript carries spread word timings;
- the unbiased one has none, so the witness reads by alignment, as in the $0 runs;
- retries get 90 s, not the product's 8 s deadline;
- a provider failure past the retries, or a refused key, stops the run as incomplete. Invalid output twice counts as the model's miss.

**Pacing:** at most 60 requests in any minute, after a slow start from 10 a minute over the first ten gaps (about 24 s).

**Prompt caching.** The extractor's opt-in `promptCache` puts breakpoints on the tool definition and the system prompt. Nothing the model sees changes; a test compares the bodies.

- **The minimum:** the claude-api skill's prompt-caching reference gives Haiku 5.5's minimum cacheable prefix as 512 tokens, and says to confirm it in Anthropic's docs, which WP11 didn't fetch.
- **The prefix:** the tool definition alone is 13,298 characters, at least 2,000 tokens at any plausible ratio (about 5,300 at the estimate's 2.5 characters a token). That clears 512 by far, and clears every minimum in that table (4,096 at most) at 3.2 characters a token or fewer.
- **The rates:** the price row's cache rates are $0.01 a million read and $0.125 written.
- **Verification:** each report shows cache-read tokens, and flags a run where none came.

**The budget guard (`src/smoke/budget.ts`).** Before the run, every turn is estimated from the characters it sends and the proposals it should get back, at 2.5 characters a token. The tool-use prompt adds 500 tokens, output gets ×1.5 plus 50 tokens, and the whole run ×1.25.

| Run | With the cache plan | No cache hit at all |
|---|---|---|
| One run, 121 requests | $0.0303 | $0.1147 |
| `baseline:smoke`, 3 runs | $0.0909 | $0.3441 |

- **Why the cache is needed:** an uncached request is about 6,500 tokens, not the spec's 2,000. The v2 tool schema is most of it. So the default $0.10 budget fits only with the cache.
- **During the run,** each call's measured cost is summed (the provider's usage at the price row's rates), and the run stops past the budget, incomplete. A call that timed out with no usage is charged the estimate.
- **The ceiling:** `EVAL_SMOKE_BUDGET_USD` is refused above $1, as a typo guard.

**The gate (`src/smoke/gate.ts`)**, against `baselines/smoke-<provider>.json`. The baseline is three complete runs: each gated metric's median and spread (the largest minus the smallest), tied to the provider, model, linker, and the scripts' bytes. A run fails on:

- key-field accuracy, target accuracy, or proposal F1 more than max(3 points, 2 × spread) below the median;
- evidence coverage under 100% (G2c);
- wrong accounts above 2%;
- an incomplete run;
- no baseline. The absolute gates still run and are reported, but an unbaselined run can't pass, and the message says to run `baseline:smoke`;
- a baseline that doesn't fit (other scripts, model, or linker). It isn't compared, and must be recorded again.

**The re-run.** One automatic re-run within the budget (spec §8's answer to flapping). A complete run that fails only on a regression or the wrong-account rate is repeated if the rest of the budget covers another run's estimate, and the job fails only if the repeat fails too. Evidence, incompleteness, and a missing baseline never earn one.

**The workflow (`.github/workflows/eval-smoke.yml`).**

- **Triggers:** every pull request, plus `workflow_dispatch`. A `changes` job runs it when a PR touches anything the live run executes or reads. That's the spec's paths, plus the contracts, the demo CRM, the price table, the evals code the runner and scoring share with WP10, the debriefs, the smoke CLI, its baseline, and the workflow itself. Tests and the offline cassettes don't trigger it. Codex found that the first filter missed the shared runner (#50).
- **Gating:** both jobs carry the spec's `if:`, so with `EVAL_SMOKE_ENABLED` unset everything is skipped, and a skipped `eval-smoke` passes a required check. The key reaches only the step that calls the model, in the `eval-smoke` environment.
- **Steps:** the budget guard runs first, with no key. The report goes to the job summary and an artifact, as numbers, ids, and fixed codes only.
- **The baseline by hand:** `workflow_dispatch` with `baseline` records the three runs as an artifact to review and commit.

## Consequences

**Good**

- The pipeline is measured on 200 debriefs, 803 turns, and 751 proposals, at $0 and in seconds. The 30 rendered scripts and their WAVs are untouched.
- Every label is re-derived. The generated files, their index, the cassettes, and the error labels all reproduce byte for byte, and tests hold them to it.
- The two-witness effect is measured end to end: the wrong-account rate goes from 7.0% to 0.3%.
- The normalizers' catches are measured against labelled errors rather than asserted.
- WP11's live smoke eval scores a real model with the same metrics and the same matching, through the same runner.
- The live tier can't spend by accident: it's off by default, refuses an estimate over the budget, stops past it mid-run, and can't pass without a baseline.

**Bad**

- **The cassettes' drafts are the ground truth plus seeded errors.** So proposal precision and recall and key-field accuracy are 100% by construction. The gate guards the pipeline after the model (linking, the witness, the normalizers, evidence), not the model itself. That's WP11's job.
- **The understanding gate barely notices the phonetic candidate source.** Run locally with both sound sources removed, target accuracy falls from 91.7% to 91.6%, and the wrong-account rate rises from 0.3% to 0.5%: it passes. The biased stream snaps most names in a debrief onto keyterm spellings, and exact forms and trigrams find those. `eval:linking --check` is what blocks spec §6's G3a test PR (ADR-0028).
- **Three seeded amounts make a coarse rate.** One miss there moves the catch rate 33 points, and fails the gate. The test keeps it honest, but noisy for any change to amounts.
- **The set isn't independent of the linker's calibration distribution.** It reuses `confusable.v1`'s simulator, decoys, and oracle, and linker v1 was fit on that set's calibration split. So the set measures the pipeline in the linker's own world. WP6's mined set, and Phase 8's recordings, are the counterweights.
- **Conflict precision is 67.6%.** The unbiased channel's sound changes (about 2% of names) are the false conflicts that cost 19 right links. That's ADR-0028's finding again, at debrief scale.
- **The baseline must be re-recorded whenever a script or the error seed changes,** even when nothing regressed. That's on purpose: the SHA binding makes a regenerated set a reviewed change.
- **The flag share is 10.8 points over the guard,** pending the remedy above. Phase 5 WP4 adopted option 2, so the guard now reads the marked share, 30.1%.
- **The loud share is gated at an interim ceiling, 18%, not the spec's 15%** (Phase 5 WP4): the loud floor is 15.7% until false witness conflicts fall. The 200 debriefs over-represent hard cases by design (48 snapped names, 20 paraphrased targets), so their loud share is an upper reference for real use.
- **Thirty live scripts can't resolve small effects** (spec decision 14). If the three baseline runs happen to agree, the band is 3 points, about 4 targets. If they don't, it's twice their spread. A test PR that only drops "quote names exactly" from the prompt may not move a model that quotes exactly anyway. The tool schema's descriptions repeat the rule, so the demonstration should drop it there too, or invert it.
- **At about 96 targets decided, the 2% gate allows one wrong account.** Two fail the run.
- **The smoke estimate's token count is an estimate.** The first live run's report shows the real usage.

## More information

- Spec: `reports/Earshot Phase 4 build spec.md`, WP10, §4.5, §6, and decisions 13 to 15.
- Format and coverage: `packages/evals/src/{schema,coverage,verify}.ts`.
- The generator: `packages/evals/src/grammar/`. Regenerate with `pnpm --filter @earshot/evals debriefs:gen`, then `cassettes:gen`, then `eval:understanding --write-baseline`, and review the diffs.
- The eval: `packages/evals/src/understanding/`, and `scripts/{eval-understanding,gen-cassettes,understanding-io}.ts`. The tiers' metrics and budgets: `src/understanding/tiers.ts` (Phase 5 WP4); `tierOf`: `packages/understanding/src/tiers/`.
- Files: `debriefs/generated/`, `cassettes/understanding/{anthropic,groq,errors}.json`, and `baselines/understanding.json`.
- Run locally: `pnpm --filter @earshot/evals eval:understanding [--provider anthropic] [--json out.json]`.
- The lab: `lab/tests/test_debrief_noise.py` checks that the renderer accepts every generated script's noise.
- The live smoke tier (WP11): `packages/evals/src/smoke/`, `scripts/{eval-smoke,baseline-smoke,select-smoke,smoke-io}.ts`, `smoke.json`, and `.github/workflows/eval-smoke.yml`. Run `pnpm --filter @earshot/evals eval:smoke --budget 0.10 --estimate` for the estimate, or `--offline` for the plumbing against the cassettes, both $0. `eval:smoke --check` and `baseline:smoke` call the model and need the user's approval.
