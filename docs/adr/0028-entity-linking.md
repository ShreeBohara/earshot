# ADR-0028: Entity linking: a fixed confusable-name set and its metrics first, then a calibrated linker that links, asks, or proposes a new record

## Status

Proposed (2026-11-19). Phase 4 WP3 drafted the problem and the metrics, and committed the measurement they rest on: the confusable-name set `confusable.v1`, its harness, and linker v0's baseline. The linker (WP4) and the witness threshold with gate G1a (WP5) fill in the decision. Until then, the sections on the linker are the plan in spec §4.4. Builds on ADR-0027 (contracts and the pipeline) and ADR-0026 (eval harness v0).

## Context and problem

From Phase 4, the extractor quotes the words that named a record and says what kind of record it is (ADR-0027). It no longer sees the CRM list. A deterministic linker in `SessionDO` turns that quote into a target. It sees the session's records (at most 250, each with a parent company), the account open in Earshot, the company said in the same breath, and earlier links. It decides one of four things:

- **link:** one record, with a calibrated probability;
- **ask:** the top candidates, so the rep chooses;
- **new:** a record the CRM doesn't have yet;
- **none:** no name was quoted.

Its errors don't cost the same:

- **A wrong account** writes a rep's note, task, or deal change onto someone else's record. It's the worst error, and the plan's gate caps it at 2%.
- **A "new" for a record that exists** makes a duplicate, which is annoying but recoverable.
- **An "ask"** costs the rep a keystroke.

So the linker abstains on purpose. The question is how much coverage it can keep while it does.

The demo CRM is built to make that hard (`packages/demo-crm`). It has 35 confusable groups of two or three names, of four kinds:

- spelling groups, which are true homophones: Acme, Akme, and Acmi Dynamics; Kathryn, Katherine, and Catherine Moore;
- phonetic groups: Atmos and Atmas sound the same, and Atlas doesn't;
- shared stems: three companies answer to "Northwind";
- shared abbreviations: "MSC" is both Meridian Supply Co and Midland Steel Corp.

A homophone can't be resolved by its spelling, because a keyterm-biased stream writes whichever boosted spelling it likes. Only context can resolve it, or nothing can, and then the right answer is to ask. A new name that sounds like a CRM name can also be snapped to the CRM's spelling by the biased stream. Then only the unbiased second witness can tell.

Two things follow:

- The measurement has to exist before the linker. Otherwise the linker gets tuned to whatever set happens to be at hand.
- The set's makeup has to be stated up front, never adjusted to pass. The share of items with no context to separate them sets a ceiling on coverage.

## Considered options

For the measurement:

- **A seeded generator over the demo CRM, with labels true by construction and checked by a ground-truth oracle (chosen).** It's reproducible, costs $0 in CI, and every label can be re-derived. Its weakness is that simulated mishearings may flatter the linker (see Consequences). WP6 tests the same linker on real speech-to-text errors.
- **Hand-written mentions.** At 600 items they can't be re-derived, and review can't keep up.
- **LLM-written mentions.** They aren't reproducible, and need the same machine checks.
- **Real recordings.** These need consent and come in Phase 8. WP6's mined set is the step in between.

For the class mix:

- **The spec's fixed shares (chosen).** The shares are a stated design. A perfect linker decides about 90%, which leaves 5 points of slack over the gate's 85%.
- **Whatever the channel's natural rates produce.** That would hide the mix inside simulator parameters.

## Decision

### The measurement (WP3)

**`packages/evals/linking/confusable.v1.jsonl`.** 600 explicit mentions, split 40/60 into calibration (240) and test (360). The split is stratified by class and confusable group, and labelled on each item. The shares are spec §4.5's:

| Class | What it is | Share | Items | Best decision |
|---|---|---|---|---|
| A | A CRM name heard exactly; all 18 accounts with no look-alike appear | 20% | 120 | link |
| B | A CRM name misheard, still unique by sound or by its distinguishing tail | 22% | 132 | link |
| C | A sound-alike that context separates: the company said with a contact (66), the open account (57), an earlier link (44), a deal's tail (49) | 36% | 216 | link |
| D | A sound-alike with nothing to separate it | 5% | 30 | ask |
| E1 | A new name that sounds like a CRM name, heard as itself | 8% | 48 | new |
| E2 | The same, snapped by the biased witness to a CRM spelling | 4% | 24 | ask, through the witness |
| F | A new name unlike any CRM name | 4% | 24 | new |
| G | The open account is the wrong sibling; only the unbiased witness heard the word that tells them apart | 1% | 6 | ask, through the witness |

**Each item holds:**

- the proposal type, which decides the kinds the linker may link;
- what was said, and its kind;
- both witnesses' transcripts of the turn, each with the mention's span and the company's span;
- the context: the open account, the company said in the same breath with its gold id, and earlier links;
- `gold`, a demo CRM id or `NEW`;
- `expect`, the best possible decision;
- bookkeeping: the confusable group, class C's cue, and the simulator's notes.

The harness strips the labels before a linker sees an item (`linkingCase`). Ids are the demo CRM's own, as `DEMO_SESSION_ENTITIES` has them, plus parent ids (`LINKING_ENTITIES`). The set uses 239 of the 250 records and 77 of the 80 decoys.

**The mishearing simulator** (`packages/evals/src/channel`, seeded mulberry32 as the demo CRM uses). Its rules:

- homophones from a list: the spec's examples, the demo CRM's spelling groups, and the heads its phonetic groups share;
- vowel swaps, and consonant swaps that keep the sound;
- consonant swaps that change it, used only by the unbiased witness;
- compounds split ("Glow Vex"), words joined, and the last word dropped.

The biased witness is primed with the session's keyterms, built as `apps/web/lib/voice/keyterms.ts` builds them: the open account, its contacts and deals, then the other companies, cut at AssemblyAI's 100 terms.

- An in-list spelling that sounds exactly like what it heard always wins. When several do, it picks uniformly: that's how a confusable group's spellings appear.
- One a word away wins with probability `pSnap` = 1/3. That's E2's rate, and the spec's shares imply it (4% snapped against 8% unsnapped).
- Its own mistakes keep each word's sound, or drop a word.

The unbiased witness never snaps. It writes unusual names the common way ("Akme" as "Acme"), and changes a consonant's sound in about 3% of mentions. Those are the false conflicts WP5's θ_d must absorb. The parameters are stated in `src/channel/params.ts`, and WP6 can refit them.

**Decoys** (`src/linking/decoys.ts`): 80 invented names, 54 sound-alikes and 26 unrelated, 48 companies and 32 contacts. A test checks three things:

- each is absent from the demo CRM;
- none sounds the same as a record;
- each sound-alike sounds like the record it names, and each unrelated one sounds like nothing.

Whether a name is fictional is checked by review. The rule is the demo CRM's: generic and invented, with no real company, no well-known brand, and no public figure.

**The ground truth** (`src/linking/oracle.ts`). This is the rule each label must agree with:

1. A mention names the records whose spoken forms it sounds the same as, word by word, from the start of the form. "Sounds the same" means sharing a Double Metaphone code or being listed homophones. A form is a name, an alias, or a deal's company and tail.
2. One record: link it.
3. None: new, for a company or contact. A deal can't be new in Phase 4, so it asks.
4. Several: the company said, the open account, and earlier links narrow them. One left: link it. Otherwise: ask.

The generator throws away any attempt the oracle doesn't place in its class, and a test re-runs the oracle over the committed file.

**Versioning.** v1 is frozen. A test regenerates the file and fails on any byte of difference. A change to the simulator, the decoys, the templates, the oracle, or the name toolkit that alters the file becomes `confusable.v2`, with its own baseline. It's never an edit to v1.

### The metrics (WP3)

On a named split (`src/linking/metrics.ts`):

| Metric | Definition |
|---|---|
| Decided | The final decision is "linked" or "new", after any witness downgrade |
| Coverage | Decided ÷ items |
| Wrong-account rate | Links to a record other than gold, links when gold is `NEW` included, ÷ decided |
| Bound | The one-sided 95% Clopper–Pearson upper limit on the wrong-account rate (exact binomial tail, bisection) |
| New-when-existing | "New" when gold is a CRM record, ÷ decided. It's capped, so that "new" can't buy a lower wrong-account rate. |
| Accuracy on decided | Correct decisions ÷ decided |
| Risk–coverage and AURC | Links are admitted in order of falling p, as raising τ_link from 1 would admit them, with every "new" counted from the start; tied links go in together. Risk is the wrong-account rate. AURC is the mean risk over the admitted links. |
| ECE | On links with a probability: 10 equal-mass bins, \|mean p − accuracy\| weighted by bin size, plus the reliability table |
| Divergence recall | Of the decisions wrong with the witness off, the share the witness flagged or downgraded |
| Hidden error rate | Wrong final decisions the witness didn't flag, ÷ decided |
| Biased-only numbers | Every metric again, with the witness off |

**The gate (G1a, spec §6), on the test split's final decisions:**

- wrong-account rate at most 2.0% (the point estimate);
- coverage at least 85%;
- new-when-existing at most 5%.

The report shows the bound, the per-class table, and the biased-only numbers beside it. At 306 decided, 2 wrong gives a bound of 2.04%, 4 give 2.97%, and 6 give 3.83%. A bound of 2% or less needs 149 decided with no errors, or 313 with two. The report claims only the point estimate.

**The regression check.** `eval:linking --check` (WP5 wires it into `checks`) fails in three cases:

- coverage falls more than 3 points against the linker's committed baseline;
- the wrong-account rate rises more than 0.5 point;
- the baseline was taken on a different set file (by its SHA-256).

G1's thresholds apply only to a linker meant to pass them. v0 is a reference.

### Baselines

**Linker v0** is Phase 3's exact matcher (`matchEntity`), applied to the biased transcript's words for the mention. A match links. No match makes a contact proposal new, and leaves anything else with no target. It has no probability and no witness. `baselines/linking-v0.json` records:

| v0 | Calibration (240) | Test (360) |
|---|---|---|
| Coverage | 52.9% (127) | 60.0% (216) |
| Wrong-account rate | 25.2% (32/127), bound 32.3% | 21.3% (46/216), bound 26.4% |
| New-when-existing | 11.0% (14/127) | 15.3% (33/216) |
| Accuracy on decided | 63.8% | 63.4% |
| Hidden error rate | 36.2% | 36.6% |

Where v0 goes wrong:

- **Class C:** it links whichever homophone spelling the stream wrote (25 wrong links on test).
- **Class E2:** it links every snapped new name (14 of 14).
- **Class B:** it makes every misheard contact new (30 duplicates on test).
- **Deals:** it can't match a spoken deal name at all, because the CRM's name has a dash nobody says.

**The ceiling.** The oracle, run as a two-witness linker (`--linker oracle`, a reference), knows the simulator's rules and the homophone list.

- On both splits it decides 88.3% with no wrong account.
- With the witness off it decides 95.0%, at 5.3% wrong. Those wrong links are exactly the E2 and G items.
- About 2 points of the spec's 90% go to false conflicts from the unbiased witness's sound changes.

So G1 is reachable on this set, with about 3 points of slack.

### The linker (WP4, to be written)

The plan, in spec §4.4:

- candidates from five sources;
- 13 features, scored by an L2 logistic regression fit on the calibration split;
- link, ask, or new by τ_link, δ, and τ_new, chosen on calibration for a wrong-account rate of 1.5% or less and new-when-existing of 5% or less, then frozen in `link/params.v1.json` with the calibration set's hash;
- the ablation table.

WP5 adds θ_d, refits on calibration, and runs the test split once, for G1a.

## Consequences

**Good**

- The linker is judged on a set fixed before it was written, with stated shares and a stated simulator. The test split is never tuned on.
- Every label is re-derived by a test, and the file reproduces byte for byte.
- v0's numbers say plainly why Phase 3's matcher can't stay: one decision in five is a wrong account.
- The ceiling shows the gate is reachable, and how much the second witness is worth: 5.3 points of wrong-account rate, at about 7 points of coverage.

**Bad, and what the simulated set can't tell**

- **The biased witness's mistakes on CRM names keep their sound by construction.** So a misheard CRM name and a new name are separable by sound alone, which real streams won't always allow. This is the main way simulated mishearings may flatter the linker. WP6's mined set (G1b) measures it on real errors, and a miss goes into this ADR and Phase 8.
- **The ground truth uses the homophone list as well as Double Metaphone.** "Sean" (SN) and "Shawn" (XN) sound the same to it, but not to the product's phonetic keys. Ten items involve that group, so a linker that relies on Double Metaphone alone will lose them.
- **Keyterms follow production, cap included.** With no account open, the alphabetically last companies, from Summit Ridge Medical on, aren't boosted at all. That's a finding about the product, not only the eval.
- **Some things are simpler than in life:**
  - the two transcripts differ only at the mention and the company;
  - the extractor's kind is always right;
  - every mention is explicit.

  WP10's generated debriefs add disfluency and implied targets.
- **Class G's "ask" is reachable only through the second witness.** A wrong open account with nothing else to contradict it looks the same as class C's open-account cue.
- **The keyterm rule and its cap are copied from the web app.** If the web app changes, the simulator doesn't follow, and v1 shouldn't.

## More information

- **Spec:** `reports/Earshot Phase 4 build spec.md`, Decisions 3 to 5, §4.4, §4.5, WP3 to WP5, and §6.
- **Code:**
  - `packages/evals/src/channel/` (the simulator);
  - `packages/evals/src/linking/` (schema, generator, oracle, decoys, metrics, report, gate, linkers);
  - `packages/evals/scripts/{gen-confusable,eval-linking}.ts`.
- **Data:** `packages/evals/linking/confusable.v1.jsonl` and `packages/evals/baselines/linking-v0.json`.
- **Commands:**
  - `pnpm --filter @earshot/evals linking:gen` (regenerate; only for a new version);
  - `pnpm --filter @earshot/evals eval:linking --split test` (or `calibration`, `--linker oracle`, `--check`, `--summary <file>`, `--json <file>`, `--write-baseline`).
