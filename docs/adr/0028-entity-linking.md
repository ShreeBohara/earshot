# ADR-0028: Entity linking: a fixed confusable-name set and its metrics first, then a calibrated linker that links, asks, or proposes a new record

## Status

Proposed (2026-11-19). Phase 4 WP3 drafted the problem and the metrics, and committed the measurement they rest on: the confusable-name set `confusable.v1`, its harness, and linker v0's baseline. WP4 (2026-11-20) wrote linker v1, fit it on the calibration split, and recorded its biased-only numbers. WP5 (2026-11-20) added the second witness's comparison and its threshold θ_d, refit the thresholds with the witness, and ran gate G1a on the test split: it passes, at 86.9% coverage and a 0.6% wrong-account rate. CI's `checks` job now runs it. Builds on ADR-0027 (contracts and the pipeline) and ADR-0026 (eval harness v0).

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

The unbiased witness never snaps. It writes unusual names the common way ("Akme" as "Acme"), and changes a consonant's sound in about 3% of mentions. Those are the false conflicts the witness has to tolerate; WP5 found no θ_d that tells them from snaps. The parameters are stated in `src/channel/params.ts`, and WP6 can refit them.

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

### The linker (WP4)

**Where it runs.** `@earshot/understanding/link`: pure TypeScript, no DOM, no Node APIs, so `SessionDO` can link in memory (WP8 wires it in). It bundles for workerd with its parameters inside; a test runs the bundle on its own.

**The API** is spec §5 WP4's, with one optional field:

```ts
const index = buildLinkIndex(entities); // once per session, and again when the object wakes
link(
  mention: { text: string; kind: EntityKind | null; companyText?: string | null },
  ctx: { index; focusEntityId: string | null; recent: readonly string[];
         turnMentions: readonly MentionInput[]; params: LinkerParams;
         kinds?: readonly EntityKind[] }, // the kinds the proposal type allows; all when absent
): { decision; entityId; p; basis; candidates; features? } // features: tests and evals only
```

`kinds` carries spec §4.4's "filtered to the kinds the proposal type allows", which the spec's signature has no other way to pass. `p` is the linked record's probability; for "new", the probability no candidate claims; for "ask", the best candidate's, so the risk–coverage sweep can admit it (WP3's finding); null for "none". `candidates` holds at most 4, most likely first: the top 3 records, plus "new" (a null id) for an ask below τ_link that may be new. `basis` is "exact", "sound", or "context": context when the words alone wouldn't have linked the same record (scored again without the context features), and for a deal named only by its company (spec §4.3). `isLinkUncertain` marks links that aren't exact with p below 0.97.

**The index** holds, per record:

- forms: the name and aliases in matching form, and for a deal the way it's said. The CRM writes "Atmos Industrial - Onboarding package", which nobody says (WP3's finding), so a deal is indexed as its company's name or alias followed by its tail ("atmos onboarding package"), and as its company alone, for a deal named by its company;
- per word, its Double Metaphone codes, and a key for its homophone set;
- trigram sets, a company's initials and abbreviation aliases, how many records share each form, and the parent map;
- the words that tell it from its sound-alike siblings (records of its kind whose name, alias, or company starts with the same sound): those not every sibling shares ("Labs" against "Logistics"; a deal's tail).

It builds in about 4–8 ms for the demo CRM's 250 records in Node, around the 5 ms target (the first, cold build is the slow one).

**Candidates** come from six sources, the spec's five with "shared token codes" split in two: an exact form; a shared Double Metaphone code ("Nite" and "Knight"); the homophone list ("Sean" SN and "Shawn" XN share no code, so ten items in the set depend on it; the list moved from the evals to `@earshot/understanding/names`, unchanged, so the product and the ground truth share it); pg_trgm `similarity` or `word_similarity` at 0.2 or more; initials or an abbreviation alias ("MSC", "M. S. C."); and the open account's family, for a one-word mention. They're filtered to the allowed kinds, and the top 8 by a prefilter score are kept. On calibration the gold record was among the candidates for all 199 mentions whose gold is a CRM record.

**Features.** The spec's 13, as §4.4 defines them, with these readings:

- `phonFull` compares the codes run together two ways (word by word, each homophone as its set's first spelling; and the words written as one, for "Yara Under Hill"), against each form and each proper prefix of its words, since a rep may stop early ("Summit Ridge").
- `tailCover` counts a record's distinguishing words heard in the mention, splits and joins included; for a deal, its tail's words. Where siblings share every word (true homophones), every word counts.
- `parentCtx` is signed: 1 when a company said in the turn sounds like the record's parent, falling to −1 as it sounds less like it, and 0 when no company was said. A contact at a company nobody named is evidence against it.
- `tieCount` counts ties among candidates of the same kind.

The first fits got two things wrong, and two changes fixed them. Both are departures from the spec's list:

1. **A 14th feature, `rivalContext`:** a candidate tied with this one on `phonFull` has more context (the company said names its parent, it's in the open account's family, or it was linked earlier). A per-candidate model can't otherwise tell the two ways a homophone loses: as the sibling of a record context picked out, or in a group nothing separates. The first is far commoner in the set, so without the feature every member of an unseparated group scored about 0.1. "Northwind" or "MSC" alone then summed under τ_new and came out "new", a duplicate of a record the CRM has.
2. **Spelling can't separate sound-alikes.** Among candidates tied on `phonFull`, `exact`, `trgm`, and `jw` take the group's best. This section's own premise is that a keyterm-biased stream writes whichever homophone spelling it likes. Without the change the model trusted the spelling, and linked 4 of the test split's 18 class D items, wrongly.

**The model** is an L2 logistic regression fit by Newton's method (Decision 4), deterministic, λ = 1, the bias unpenalized. The penalty applies to standardized features (each column centred and scaled), and the weights are mapped back to the raw features. On the raw columns, the same λ made rare binary features pay many times more for the same effect. The fit came out underconfident: a perfect, unique exact match scored 0.906, and the grid's loosest thresholds decided 83% of the test split. The candidates' probabilities are scaled to sum to 1 when they sum past it, because they're rival answers that the model scores one at a time. "MSC" then reads 50/50 rather than 79/79.

**The decision rule** is §4.4's, with one change. "New" needs the candidates' total p below τ_new, not p1 alone. With one candidate the two agree. On a tie they part: three homophones at 0.25 each have a low p1, yet the mention almost surely names one of them. Ties ask, as the spec's tests require. A deal is never new, and neither is a mention whose kind is unknown. With no candidate at all, the decision is new where it may be, and none otherwise.

**The fit** (`pnpm --filter @earshot/evals linker:fit`, `src/linking/fit.ts`) reads the calibration split only; a test shows the test split can't change it:

- **Classes E2 and G stay out of the model.** Their biased readings are, by construction, correct-looking links: a CRM name written exactly, or the open account's sibling. To a single-witness model they're label noise that only the second witness can explain. The threshold search counts them as asks, as an ideal witness would leave them. WP5 refits on every class with the real witness.
- **Thresholds come from out-of-fold probabilities**: five folds, stratified by class. In-sample probabilities would set them too loose.
- **The grid is spec §4.4's**: τ_link 0.70–0.98 by 0.02, δ 0.05–0.40 and τ_new 0.10–0.40 by 0.05, 840 points. It maximizes coverage subject to a wrong-account rate of at most 1.5% and new-when-existing of at most 5%.

**Fitted** on 228 mentions, 1,401 candidate rows, 199 positive:

- thresholds τ_link = 0.72, δ = 0.40, τ_new = 0.40;
- weights: `phonFull` 12.7, `kindMatch` 6.0, `rivalContext` −5.5, `recent` 5.0, `phonHead` 3.2, `tieCount` −2.6, `trgm` 2.5, `parentCtx` 2.1, `focus` 2.1, `tailCover` 1.6, `initials` 0.9, `exact` 0.6, `aliasShared` 0.4, `jw` −0.4, and a bias of −22.8.

Every one of the 840 grid points met both limits: out of fold, coverage 86.3%, 1 wrong link, and no duplicates. So coverage alone chose the thresholds, which sit at the top of δ's and τ_new's ranges and near τ_link's floor. Everything is frozen in `link/params.v1.json`, with the calibration split's SHA-256 (`155e430c…`) and the date. `linker:fit --check`, and a test, refit and compare.

### Linker v1's numbers (WP4, biased witness only)

Test split, 360 items. v1 has no second witness yet, so its final decisions are its biased-only ones:

| | v0 | v1 | Oracle, biased only | Oracle, two witnesses |
|---|---|---|---|---|
| Coverage | 60.0% (216) | 93.3% (336) | 95.0% (342) | 88.3% (318) |
| Wrong-account rate | 21.3% (46) | 5.4% (18) | 5.3% (18) | 0.0% (0) |
| Bound (95%, one-sided) | 26.4% | 7.8% | 7.7% | 0.9% |
| New-when-existing | 15.3% (33) | 0.0% (0) | 0.0% (0) | 0.0% (0) |
| Accuracy on decided | 63.4% | 94.6% | 94.7% | 100% |
| AURC | 0.213 | 0.055 | 0.053 | 0.000 |
| ECE (links) | n/a | 0.075 | 0.060 | 0.000 |

Per class, v1 decides:

| A | B | C | D | E1 | E2 | F | G |
|---|---|---|---|---|---|---|---|
| 72/72 linked right | 79/79 linked right | 129/130 linked right | 0/18 (all ask) | 24/29 new (5 ask) | 14/14 linked wrong | 14/14 new | 4/4 linked wrong |

- **Every wrong link is in E2 or G.** Those are exactly the oracle's biased-only errors, the ones only the second witness can catch. v1 makes no wrong link and no duplicate of its own.
- **G1's thresholds, biased only:** wrong-account 5.4% fails the 2.0%; coverage 93.3% and new-when-existing 0.0% pass. G1 itself is judged after WP5.
- **With an ideal witness**, turning every E2 and G item into an ask, v1 would decide 88.3% with no wrong link and no duplicate. The oracle's ideal is 90.0%; its real two-witness run loses 1.7 points of that to false conflicts.
- **ECE** is 0.063 without E2 and G. The reliability table runs underconfident in the middle, at p 0.85–0.93.
- **Calibration split** (in sample for the model): coverage 92.1%, wrong-account 5.9% (13: 10 in E2, 2 in G, and 1 E1 name linked), new-when-existing 0.0%. WP4 recorded both splits in `baselines/linking-v1.json`; WP5 replaced it with `baselines/linking.json`, recorded with the witness.

**Ablations** (spec WP4 step 8; `eval:linking --linker v1` prints them). Each variant is refit on calibration without the signal, then scored on the test split, biased only. A removed input is cleared from what the linker is shown, in fitting and in prediction, so nothing derived from it (the prefilter's bonus, `rivalContext`) still carries it. The rows are as WP5's fit sets them, with its objective and θ_d; biased-only numbers don't use θ_d. Under WP4's objective, without sound decided 44.2%:

| Variant | Removes | τ_link / δ / τ_new / θ_d | Coverage | Wrong-account | Own wrong links (not E2, G) | New-when-existing |
|---|---|---|---|---|---|---|
| v1 | nothing | 0.72 / 0.40 / 0.40 / 0.02 | 93.3% | 5.4% | 0 | 0.0% |
| Without sound | both sound sources, and every feature or tie built on codes or the homophone list | 0.86 / 0.40 / 0.15 / 0.02 | 35.0% | 5.6% | 3 | 1.6% |
| Without trigrams | the trigram source, `trgm` | 0.72 / 0.40 / 0.40 / 0.02 | 93.3% | 5.4% | 0 | 0.0% |
| Without context | the open account, earlier links, and the company said: the family source, `parentCtx`, `focus`, `recent`, `rivalContext` | 0.72 / 0.40 / 0.40 / 0.02 | 63.1% | 4.8% | 0 | 0.0% |
| Without the open account | the open account, wherever it's read: the family source, the prefilter's bonus, `focus`, and its part in `rivalContext` | 0.70 / 0.40 / 0.35 / 0.02 | 82.5% | 5.1% | 1 | 0.0% |

Sound carries the linker, and context separates the homophones. The open account alone is worth 11 points of coverage, and without it one item outside E2 and G links to the wrong record. Trigrams add nothing on this set: its mishearings keep their codes by construction (see Consequences). They stay, because they're cheap, and because real speech-to-text errors that change a code are what they're for. WP6's mined set will say whether that holds.

**Speed.** 1,000 mentions against the 250 records take about 0.2 s in Node, including the index (target: under 1 s). That's about 0.13 ms per mention at the median and 0.5 ms at p95, against the understanding step's 20 ms budget.

### The second witness (WP5)

**Where it runs.** `@earshot/understanding/witness`, pure like the linker. `SessionDO` will call it once a turn's proposals and its unbiased transcript both exist (WP9). Reading a mention and its company by alignment, linking the reading, and comparing take about 0.4 ms at the median and 0.8 ms at p95 in Node, against the understanding step's 20 ms.

**The API.** Its outputs are the pieces of `proposal.flagged`: `flags`, `target` (the downgrade), and `conflict.unbiased` (the reading).

```ts
readUnbiased(
  quote: { text; span: [start, end]; audioMs?: [t0, t1] | null }, // the biased utterance, the quote's evidence
  unbiased: { utteranceId; text; startMs; endMs; words?: { w; startMs; endMs }[] },
): { text; utteranceId; audioMs; method: "time" | "alignment" } | null // null: unavailable

compareWitnesses(
  input: { field?: string; mention: MentionInput; biased: LinkResult;
           unbiased: { text; companyText? } | null },
  ctx: LinkContext, // the biased link's index and context
): { field; outcome: "agree" | "conflict" | "unavailable"; distance; unbiased: LinkResult | null;
     flags: { kind: "witness_conflict"; field }[]; downgrade: { decision: "ask"; candidates } | null }
```

**Reading** (spec §4.6 steps 1 and 2). Both ways align the two transcripts word by word (`alignTokens`). They keep the unbiased words between the quote's aligned neighbours: the ones aligned with the quote, plus any the alignment inserted at its edges. Fillers ("uh", "um") are trimmed from the ends, and at most two inserted words count on each side.

- **The edges matter.** A tail the biased stream dropped ("Summit Ridge" against "Summit Ridge Capital") is an insertion, and it's exactly what class G turns on. `alignedRange` alone leaves insertions out: it read 24 of the 600 mentions short, every G item among them.
- **By time,** the reading keeps those of the words that overlap the quote's audio window widened by 150 ms on each side. When no unbiased word overlaps the window itself, the witness heard nothing there, and the reading is unavailable. The spec's rule alone (the words that overlap the widened window) would take in the neighbouring words of continuous speech. They'd sound different, and conflict.
- **By alignment,** when either side has no timings, as in the confusable set. There it reads every unbiased mention (600 of 600) and company (169 of 169) exactly as the set has it, and a test holds it there.

**Linking the reading.** With the same index and context, the mention's kind, and the unbiased reading of the company said with it. When the witness has no reading of the company, the biased one stands, since it's context.

**Sounding different.** `readingDistance` is 1 minus `codeSimilarity` of the two readings' codes run together, which is what `phonFull` compares: homophones as their set's first spelling, and split and joined words alike. "Shawn Murphy" and "Sean Murfy" are 0 apart; "Atmos Industrial" and "Atmos Industries" are 1/11.

**Different outcomes.** One reading links a record and the other links another record, says "new", or doesn't decide; or one says "new" and the other doesn't. Two undecided readings (ask or none) are alike. This departs from spec §4.6's "another record, or new against linked":

- On calibration, the spec's reading misses 4 of the 10 snapped names (E2) and 1 of the 2 wrong siblings (G). Their unbiased reading is a near miss the linker asks about, between the CRM record and "new": "Juniper Bay Telecare" at 0.61 against "new" at 0.39.
- Counting an undecided unbiased reading as different catches all 12, for one more false conflict (5 instead of 4).

**What a conflict does.**

- **On a target decided "linked" or "new":** a downgrade to "ask". The candidates are the old target first (`proposalsProjection` keeps it there), then the unbiased reading's choice, then the rest of both readings' candidates by p, at most 3 records plus "new".
- **On an undecided target, or a field such as a contact's `name`:** a `witness_conflict` flag, and no downgrade.
- An unavailable reading is never a conflict, and agreement never raises p.

**The refit** (WP5 step 3, `linker:fit`):

- **E2 and G stay out of the model.** Fit with their biased rows, it lost about 3 points of out-of-fold coverage on calibration (81.3% against 84.2%; in sample, class C fell to 88%). Those rows teach it to doubt an exact name and the open account, which every other class relies on. The weights are WP4's, unchanged.
- **They join the threshold search with their real witness outcomes,** replacing WP4's abstain flag. Every calibration mention's unbiased reading is scored by the same fold's model and compared at each grid point, as `compareWitnesses` compares; a test checks the two agree on all 600 items. E2 and G are dealt into folds of their own, so the other classes' folds are WP4's.
- **The grid gains θ_d,** 0.02 to 0.40 by 0.02: 16,800 points.
- **The objective changed, another departure:** the most correct decisions within the limits, rather than the most decisions. Counting every decision, the search set θ_d = 0.10, because there one snapped name (cf-0568, 0.091 apart) gets through as a wrong link: one more decision, still within the 1.5% limit. That θ_d also sat exactly on three other E2 distances (0.100). Counting correct decisions, those points tie, and the cautious tie-break takes the lowest θ_d. τ_link, δ, and τ_new come out as before.

**Fitted:** τ_link = 0.72, δ = 0.40, τ_new = 0.40 (WP4's), and θ_d = 0.02. In effect, any difference in the codes is a different sound.

- Nothing on calibration separates θ_d 0.02 from 0.08.
- No θ_d separates the false conflicts from the snaps. On calibration the false conflicts sit 0.125 to 0.54 apart, and the snaps 0.091 to 0.333. A sound-changed reading of a CRM name and a new name heard right look the same to the comparison, as the simulator's notes say.
- 4,480 of the 16,800 points met the limits (all 840 did in WP4). Out of fold on calibration, after the witness: coverage 84.2% (202/240), 1 wrong link, no duplicates.

### Gate G1a (WP5)

Test split, 360 items, run once, after the refit was frozen:

| | Final, two witnesses | Biased only |
|---|---|---|
| Coverage | 86.9% (313) | 93.3% (336) |
| Wrong-account rate | 0.6% (2) | 5.4% (18) |
| Bound (95%, one-sided) | 2.0% | 7.8% |
| New-when-existing | 0.0% (0) | 0.0% (0) |
| Accuracy on decided | 99.4% | 94.6% |
| AURC | 0.014 | 0.055 |
| ECE (links) | 0.068 | 0.075 |
| Divergence recall | 88.9% (16 of 18) | n/a |
| Hidden error rate | 0.6% (2) | 5.4% (18) |
| Flagged | 24 | n/a |

**G1a passes:** wrong-account 0.6% against 2.0%, coverage 86.9% against 85%, and new-when-existing 0.0% against 5%. At 313 decided with 2 wrong, the bound is 1.998%. The report claims only the point estimate. For reference, v0 decides 60.0% at 21.3% wrong, and the oracle's two-witness run 88.3% at none.

Per class:

| Class | Items | Decided | Wrong links | Flagged | Biased only: decided, wrong links |
|---|---|---|---|---|---|
| A | 72 | 70 | 0 | 2 | 72, 0 |
| B | 79 | 77 | 0 | 2 | 79, 0 |
| C | 130 | 127 | 0 | 2 | 129, 0 |
| D | 18 | 0 | 0 | 1 | 0, 0 |
| E1 | 29 | 23 | 0 | 1 | 24, 0 |
| E2 | 14 | 2 | 2 | 12 | 14, 14 |
| F | 14 | 14 | 0 | 0 | 14, 0 |
| G | 4 | 0 | 0 | 4 | 4, 4 |

- **The witness caught 16 of the 18 biased-only wrong links:** all 4 wrong siblings, and 12 of the 14 snapped names.
- **The two it missed** are contacts whose unbiased reading the linker also links to the snapped record: "Sara Conn" to Sara Cohen (p 0.77), and "Callum Whitford" to Callum Whitfield (p 0.96). The readings sound different, but their outcomes agree. That's the linker's generosity with near-miss names, not θ_d.
- **Seven false conflicts cost 1.9 points.** In each, the unbiased witness changed a sound, and a right link or new record became an ask: "Pekra Kowalski", "Northwimd", "Pleeya Nair", "Zenykh starter", and three more. One more flag landed on a class D ask. An ideal witness would decide 88.3%.
- **θ_d mattered on test.** Two snapped names there are under 0.10 apart: "Granite State Builders" for "Granite Slate Builders" (1/12), and "Atmos Industrial" for "Atmos Industries" (1/11). The decision-count objective's θ_d = 0.10 would have let both through: 4 wrong links, 1.3%. The objective was chosen on calibration before the test split was run.
- **Calibration** (in sample for the model): coverage 85.0% (204/240) and 1 wrong link, the E1 name "Atlas Flit", which both witnesses link to Atlas Freight. Biased only, 92.1% at 13 wrong.

**The baseline** is re-recorded with the witness, as `baselines/linking.json`: the spec's name, which replaces WP4's `linking-v1.json`. The gated linker has one baseline file whatever its version, so a linker v2 is checked against v1's numbers. v0 keeps `linking-v0.json`.

**The CI check.** The required `checks` job runs `pnpm --filter @earshot/evals eval:linking --linker v1 --split test --check --summary` after the build, and writes the report to the job summary. It fails on G1a, or on a regression against `baselines/linking.json`: coverage down more than 3 points, or the wrong-account rate up more than 0.5 point. Run locally without the sound and homophone sources, it fails on four counts: coverage 58.9%, wrong-account 2.4%, and both regressions. G3a's test PR, which removes the phonetic source, should fail the same way.

## Consequences

**Good**

- The linker is judged on a set fixed before it was written, with stated shares and a stated simulator. The test split is never tuned on.
- Every label is re-derived by a test, and the file reproduces byte for byte.
- v0's numbers say plainly why Phase 3's matcher can't stay: one decision in five is a wrong account.
- The ceiling shows the gate is reachable, and how much the second witness is worth: 5.3 points of wrong-account rate, at about 7 points of coverage.
- Linker v1 comes within 1.7 points of the oracle's biased-only coverage, and makes no wrong link or duplicate of its own on the test split. What's left for the second witness is exactly E2 and G.
- The second witness does what it's for. It takes the test split's wrong-account rate from 5.4% to 0.6%, for 6.4 points of coverage, and passes G1a with 1.9 points to spare.
- The threshold search and the product apply one rule (`witnessConflict`), and a test checks that the search's decision is the linker's on every item.
- The linker is testable at $0 and deterministic: the parameters are a reproducible fit, and a test refits them.

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
- **The fit's limits barely bind.** WP4's search counted E2 and G as asks, and every grid point met the 1.5% and 5% limits. With the witness in the search, 4,480 of 16,800 points do, but τ_link, δ, and τ_new still sit at the grid's edges (δ and τ_new at their tops, τ_link near its floor). Real speech in WP6 may move them.
- **Coverage is thin.** 86.9% on test against the gate's 85%. On calibration, in sample, it's exactly 85.0%, and 84.2% out of fold. The unbiased witness's sound changes cost about 2 points in false conflicts, and no θ_d can tell them from snaps.
- **θ_d sits at the grid's floor.** Any difference in the codes is a different sound. Real Whisper output may change codes more often than the simulator does, with more false conflicts. WP6's mined set and WP9's live check will show it.
- **Near-miss names that link anyway escape the witness.** Both test misses are contacts whose unbiased reading still links the snapped record. Only a stricter linker, or real speech showing how often it happens, would change that.
- **The set has no word timings.** It tests reading by alignment; reading by time is tested only on fixtures until WP9.
- **A reading takes in up to two words inserted at the quote's edges.** That keeps a dropped tail, but a word the unbiased witness heard beside the name, other than a filler, joins the reading and may cause a conflict.
- **The fit uses class labels to leave E2 and G out of the model.** That's legitimate on the calibration split, but it means v1's probabilities assume a faithful biased reading: an exact CRM name scores near 0.97 even when a snap put it there. The witness, not p, is what guards against snaps; on the test split it caught 12 of the 14.
- **Near-miss new names ask.** A new name one sound away from a CRM name ("Opal Strant Studios", "Owen Moran") lands at p 0.55–0.66: no link, but not "new" either. That's the safe side, and it's where real mishearings, which can change a sound, will sit too.
- **The features lean on the set's cues.** `recent` (5.0) and `kindMatch` (6.0) weigh heavily because in the set an earlier link always decides, and the extractor's kind is always right. Real sessions will be noisier. Recalibration on real speech is Phase 8's.
- **Three departures from spec §4.4:** a 14th feature (`rivalContext`); spelling shared among sound-alikes; and "new" on the candidates' total p rather than p1. The ablation and fixture tests pin down what each one fixes.
- **Three more from §4.6 and Decision 5 (WP5):** an undecided unbiased reading counts as a different outcome; the reading keeps words inserted at the quote's edges, and by time keeps only aligned words within the window; and the threshold search maximizes correct decisions rather than all of them. Fixture tests pin down each.

## More information

- **Spec:** `reports/Earshot Phase 4 build spec.md`, Decisions 3 to 7, §4.4 to §4.6, WP3 to WP5, and §6.
- **Code:**
  - `packages/understanding/src/link/` (the linker: index, candidates, features, model, decide with the witness's rule, link, params) and `packages/understanding/src/names/homophones.ts`;
  - `packages/understanding/src/witness/` (reading the unbiased transcript, and the comparison);
  - `packages/evals/src/channel/` (the simulator);
  - `packages/evals/src/linking/` (schema, generator, oracle, decoys, metrics, report, gate, linkers, the fit, and the ablations);
  - `packages/evals/scripts/{gen-confusable,eval-linking,fit-linker}.ts`.
- **Data:** `packages/evals/linking/confusable.v1.jsonl`, `packages/understanding/src/link/params.v1.json`, and `packages/evals/baselines/linking.json` (the gated linker, v1 with the witness) and `linking-v0.json`.
- **Commands:**
  - `pnpm --filter @earshot/evals linking:gen` (regenerate; only for a new version);
  - `pnpm --filter @earshot/evals linker:fit` (refit v1 on calibration; `--check` compares with the committed parameters);
  - `pnpm --filter @earshot/evals eval:linking --split test` (or `calibration`; `--linker v1` or `oracle`; `--check`, `--summary [file]`, `--json <file>`, `--write-baseline`). CI runs `--linker v1 --split test --check --summary`.
