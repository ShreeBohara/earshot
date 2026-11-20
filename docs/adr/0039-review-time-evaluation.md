# ADR-0039: Review-time evaluation: the pilot kit (a seeded set from the 200 debriefs, a static page that keeps nothing about anyone, a results file with nothing else, and a pre-registered analysis), the scripted reviewer, and the KLM proxy

## Status

Proposed (2026-11-20). Phase 5 WP7 built the pilot kit (below): `pilot.v1` and its builder, `/pilot`, the results file, `pilot:analyze`, and Settings → Data's sample debriefs switched to the set. WP7b wrote the paperwork first (`docs/pilot/consent.md`, `pre-registration.md`, `protocol.md`). WP8 adds the scripted reviewer and the KLM proxy to this record.

## Context and problem

Two of Phase 5's three gates are about people: a median review time under 4 s per proposal (G1), and at least 90% of seeded wrong-account errors caught (G2). Neither can be measured at $0 in CI, so Phase 5 builds a kit for a five-person pilot that the project's owner runs (spec decision 13, WP15), and a scripted reviewer that runs the same path in CI (WP8).

What the kit has to work around:

- **The 200 debriefs seed no wrong accounts.** Their seeded errors are dates, amounts, and paraphrased targets (ADR-0031), so a set with wrong accounts has to be built, and built the same way every time: the pre-registration names it by its hash.
- **Two kinds of wrong account behave differently.** A snapped name that the second witness contradicts reaches the reviewer as a loud question; a wrong link nothing contradicts carries only the quiet name note. A reviewer who follows the marks catches the first kind and misses the second (WP8's flag-follower bound, 4 of 8), so the pilot has to measure both, separately.
- **Nothing is deployed, and participants have no accounts.** A per-participant account on a deployment needs a deploy, a sign-in, and a demo CRM each, and keeps data about each person on a server.
- **No personal data.** Consent (WP7b) promises decisions, input kinds, active times, and the card shown; when the session started and finished; the browser's engine and whether it was a phone or tablet. Nothing else: no name, email, account, address, user agent, or screen size, and no audio or screen recording. Closing the tab keeps nothing.
- **The card must be the inbox's.** Timing a lookalike would time the wrong thing, so the pilot runs the inbox's own review engine, card, keys, focus rules, messages, and "accept all".
- **The analysis is fixed in advance** (`docs/pilot/pre-registration.md`), and run as is.

## Considered options

- **Where the pilot runs:** **a static `/pilot` page with a local sink, like `/demo` (chosen)**; an account per participant on a deployment (needs a deploy, a sign-in, and a demo CRM each, and keeps data on a server); the real inbox over sample debriefs in a local workspace (needs a sign-in, and writes everything to a database).
- **The set:** **built from the 200 debriefs on the offline cassettes, with seeded wrong accounts, by a seeded builder that reproduces it byte for byte (chosen)**; hand-written debriefs (no ground truth beyond the author, and no pipeline output); the 200's cards alone (no wrong accounts to catch).
- **The silent errors' sibling:** **a seeded pick among the other members of a phonetic or spelling confusable group (chosen)**; the linker's own runner-up (often a deal or another kind of record, not a sound-alike); any confusable group (shared stems and abbreviations don't sound alike).
- **Orders:** **a seeded, balanced Latin rectangle: five rows of a 10 × 10 Williams square (chosen)**; independent shuffles (no balance of positions or carry-over); one order for everyone (fatigue and learning land on the same sessions).
- **Progress:** **`sessionStorage`, written only after "I agree" (chosen)**: a reload keeps the place, closing the tab keeps nothing; `localStorage` (outlives the tab, so something is kept); nothing (a reload loses the session).
- **The consent text:** **docs/pilot/consent.md bundled as text and read into blocks at build time (chosen)**, so the two can't differ; a copy in the page with a test comparing them.
- **Sample debriefs:** **Settings → Data's "Load sample debriefs" loads `pilot.v1`, and WP3's two debriefs stay as a development-only control for the inbox's end-to-end tests (chosen)**; rewriting the inbox's e2e against the set (its names come from a seeded draw, and WP3's seven cards hold one of every tier on purpose); keeping WP3's two as the samples (the spec moves them to the set, and WP16's screen-reader passes want the pilot's cards in the inbox).

## Decision

### The set, `pilot.v1`

`pnpm --filter @earshot/evals pilot:gen` runs all 200 debriefs through Phase 4's offline runner on the Anthropic understanding cassettes (`runScript`, with a fixed clock for the extractor's latency) and writes `packages/evals/pilot/pilot.v1/`. A test rebuilds it and fails on any byte of difference. Never regenerate it once the pilot has begun.

- **The logs** are what SessionDO writes: `session.started`; per turn the biased utterance, the proposals, the usage, `turn.completed`, then the second witness's utterance, its `proposal.flagged` events, and `turn.witnessed`; then `session.ended` and `session.sealed { by: "session" }`, 60 s later. Each session's ids are rewritten in a block of its own (`01a1c6e9-<session>-7000-8000-<n>`), and its times come from the script's call time and the runner's utterance offsets, so nothing reads a clock.
- **Flagged (4):** from the 48 snapped-name scripts, the proposal whose snapped name the pipeline's own witness conflict turned into a question with the snapped record first, as it came out. It must offer "New" among the card's numbered choices (p ≥ 0.05, the first four), so the right answer can be chosen, and carry no cassette error. **Caught:** "New" (an approval with a null record) or a rejection.
- **Silent (4):** a correct link, with no flag at all and no company named with it, to a company or contact in a phonetic or spelling confusable group, swapped to a sibling drawn from the group: `basis: "sound"`, p drawn from 0.88–0.93, the right record second at (1 − p) × U(0.5, 0.9), the link's own lesser candidates after it, and only `link_uncertain:target`. The quote stays what the rep said. **Caught:** the right record (c, then its number) or a rejection.
- **The draw:** a seeded lottery of 4 snapped-name scripts and 6 others, accepted when their proposals total 40 and at least 4 of the 6 can carry a silent error; one seeded error per session at most, so 8 of the 10 carry one. Two kinds of script are left out of the lottery, so the 8 seeded errors are the only wrong accounts a participant meets: the other snapped-name scripts (each holds an unseeded flagged wrong account), and any script whose run links a record other than the ground truth's (d037's hidden wrong account, for one). Nothing about tiers enters the draw.
- **The practice:** a seeded pick of the hand-written scripts (d001–d030) with exactly 3 proposals and no seeded error of any kind.
- **The orders:** rows of the 10 × 10 Williams square (row 0 is 0, 1, 9, 2, 8, 3, 7, 4, 6, 5; row r adds r), the sessions relabelled and five rows chosen by the seed. Across the five orders no session takes a position twice, and no session directly follows another twice. CI's order (`?p=ci`) is s01 to s10.
- **The manifest** (`manifest.json`) holds each log's file, SHA-256, session id, open account, call time, time zone, and proposals; every seeded error with its kind, place, what the card shows, and the right answer; the orders; and the tier mix of every card. Its `sha256` is the set's hash: SHA-256 of the file's text without that line, which covers every log by its own hash. The pre-registration names it, and every results file carries it.
- **The builder refuses to bend.** If the 200 can't supply 4 flagged and 4 silent errors as written, or `tierOf` reads a flagged one as anything but loud or a silent one as anything but the name note alone, it throws.

As built (SHA-256 `fb1ab8247ac781689f8924d902bc54a701f41da402f937f747c24430dc24b5ed`):

| Session | Script | Cards | Seeded |
|---|---|---|---|
| s01 | d002 | 4 | silent: Donna Lee shown for Dana Li |
| s02 | d023 | 3 | — |
| s03 | d030 | 4 | silent: Atmos Industrial shown for Atlas Freight |
| s04 | d056 | 4 | silent: Knight Security shown for Nite Security Group |
| s05 | d057 | 5 | flagged: Delta Crossing Rail first; right answer new |
| s06 | d061 | 4 | flagged: Oakmont Insurance first; right answer new |
| s07 | d065 | 5 | flagged: Owen Moreau first; right answer new |
| s08 | d080 | 3 | — |
| s09 | d086 | 4 | silent: Globalex Systems shown for Glovex Systems |
| s10 | d097 | 4 | flagged: Marshal Medical first; right answer new |
| practice | d010 | 3 | — |

The tier mix, reported and never tuned (spec §8):

| Cards | Loud | Quiet (card note) | Name note only | None |
|---|---|---|---|---|
| All 40 | 8 (20.0%) | 5 (12.5%) | 11 (27.5%) | 16 (40.0%) |
| The 8 seeded | 4 | 0 | 4 | 0 |
| The other 32 | 4 (12.5%) | 5 (15.6%) | 7 (21.9%) | 16 (50.0%) |
| Practice | 0 | 0 | 2 | 1 |

### The page, `/pilot`

- **Static,** like `/demo` (`force-static`): the set's logs and manifest are bundled as text and read at build time into the inbox's data shape (`lib/pilot/data.ts`), with the demo CRM's records as a mirror would hold them. No database, account, edge Worker, or provider. `?p=1` to `?p=5` pick a participant's order (`?p=ci` CI's); without one, the page asks for a number and starts nothing.
- **Consent first.** The first screen is docs/pilot/consent.md, bundled by a `*.md` text rule and read into headings, paragraphs, lists, and emphasis (`lib/pilot/consent.ts`), which throws at build time on Markdown it would show wrongly. Nothing is written before "I agree", which records `startedAt`.
- **The inbox's own review.** `useReviewList` (surface `"pilot"`, every session reviewable), `ProposalCard`, the keys, the focus rules, the toasts, "accept all" and its checkpoint, Reviewed, and Snoozed, over the practice and then the 10 sessions in the participant's order, each headed "Debrief 3 of 10", its account, and the call's time in the rep's own time zone (what "tomorrow" on a card counts from). The first card takes focus as each list starts, so the keys work without a click. Every card says it has no audio. The shortcuts dialog doesn't send anyone to Settings, and the app's theme hotkey (d) is stopped on its way to the window, so a stray d neither changes the screen nor writes the theme down.
- **A local sink** (`LocalReviewLog`, `lib/pilot/progress.ts`) does in the page what the review route does on the server: it fills `by` (`{ userId: "P1", auth: null }`: the label, and nobody signed in) and `syncEligibleAt`, validates each review against `ProposalReviewedV2`, checks the request with `checkReviews` and `checkSnooze` (with `tierOf`), and folds it into the session's proposals with `proposalsProjection`. Every write goes to `sessionStorage` under the participant's label, with the set's hash, so a reload restores the place and a build of another set starts over.
- **The results file,** `earshot-pilot-<participant>-<local date>.json`, from a blob in the page: `format`, `set`, `setSha256`, `participant`, `order`, `startedAt`, `finishedAt` (the download's time), `browser: { engine, mobile }`, `reviews` (every review of the 40, reopens included, in order), and `practice`, and nothing else. The engine and "phone or tablet" are read from the user agent, which isn't kept. Snoozes aren't reviews, so they aren't in the file. "Stop and download results" is there before the end, for a participant who stops early.
- **It requests nothing but static files.** The `pilot` Playwright project records every request of a full run, reload included: GETs on the page's own origin for `/pilot` and `/_next/static/` scripts, styles, and fonts (72 on this machine: 2 documents, 60 scripts, 2 stylesheets, 8 fonts), and no fetch, XHR, POST, or API route. Two things are `next dev`'s own and absent from the built page: its hot-reload socket, the only socket allowed, and the font files it serves from `/__nextjs_font/` until they're in `/_next/static/media/`.

### The analysis, `pilot:analyze`

`pnpm --filter @earshot/evals pilot:analyze results/*.json > docs/pilot/results.md` runs the pre-registration's analysis as is, as markdown. Where the pre-registration leaves a definition open, the code fixes it here:

- **A decision** is a card whose final state is approved, edited, or rejected; a participant with fewer than 30 is reported but left out of the medians, and only the medians (as written).
- **Review time:** each participant's median `handlingMs` over single-mode decisions (approvals, edits, rejections; an accept that was later undone still counts as a decision and a time), the median of those medians (the mean of the middle two for an even count), with the minimum and maximum, against 4,000 ms.
- **Pooled 90th percentile:** nearest rank, by the tier each review says its card showed (`seen.tier`), over every participant's single-mode decisions.
- **Batches:** the share of decided cards whose final decision is a batch approval, and the time per batch, each `batchId` once, from its approvals; a batch's undo writes zero-time reopens under the same id, which never count.
- **Catch rate:** final decisions, pooled as x of 8 per participant with a two-sided 95% Clopper–Pearson interval (36 of 40 gives 76.3–97.2%), flagged and silent apart, each participant's count, and "caught after accepting" (an accept that missed, then a fix); the flag-follower bound beside it.
- **Checks:** a file for another set, or that isn't a results file, is left out and named; an order other than the manifest's, reviews of cards outside the set, and practice reviews are reported.

## Consequences

**Good**

- The pilot needs no deploy, no accounts, and no server: `pnpm dev` on one laptop, or any static host, and a file per person.
- Nothing about anyone is kept: the tab's `sessionStorage` until it closes, and a results file the participant hands over, with the fields consent lists.
- The set is reproducible to the byte, named by its hash, and its right answers and orders are inside that hash.
- The cards are the inbox's, through the inbox's own engine, so G1b times the real review, and a change to the card shows up in both.
- Flagged and silent errors are measured apart, which is what tells whether the quiet name note is noticed (spec §8's risk).
- Settings → Data's samples are now the pilot's 40 cards, so the inbox can be tried, and screen-reader-checked (WP16), on exactly what participants see.

**Bad**

- **The mix may miss the clock.** Unmarked cards are 40% of the 40 (50% of the other 32, close to the 200's 54.2%), against the 60–70% of short, unmarked, keyboard-decided cards a 4 s median needs (spec §8). The loud tier is 20% with the seeded errors (12.5% without). It's reported, not thinned.
- **The silent errors are synthetic.** Some swap a name the rep said exactly, or one of the session's own accounts, which linker v1 wouldn't link by sound; a careful reader can see the spelling differ. That's the design (the record is wrong and only the name note says so), but real silent errors are subtler.
- **A small set.** 40 seeded errors give a point estimate, not a bound (40 of 40 is needed for the interval to clear 90%), and five participants' [min, max] covers the median with probability 93.75%. The pilot checks the direction; Phase 8's E6 measures.
- **Progress is per tab.** A participant who opens the page in a second tab starts over there, and a closed tab loses the session (the consent's promise, and the protocol's "fresh window").
- **The network check runs on `next dev`,** whose page is rendered on request; the built page is prerendered static (`next build` lists `/pilot` as static), which the check doesn't load.
- **The shortcuts follow the device's switch** (Settings → Review, in `localStorage` on the same origin): leave it on, the default, on the pilot laptop.
- **The page carries the set:** its 43 cards travel as props in the prerendered HTML, 105 KB against `/demo`'s 79 KB.

## More information

- Spec: Phase 5 build spec, decision 13, §4.8, WP7, WP7b, WP8, §6 (G1, G2), §8.
- `packages/evals/src/pilot/`: `build.ts` (the builder), `set.ts` (the manifest and results shapes, and the set's hash), `latin.ts` (the orders), `analyze.ts` and `stats.ts` (the analysis), `describe.ts` (what `pilot:gen` prints).
- `apps/web/app/pilot/page.tsx`, `components/pilot/`, `lib/pilot/` (the data, the local sink and progress, the results file, the consent text, `?p=`).
- Tests: `packages/evals/test/pilot-set.test.ts` (the rebuild, the seeded errors, the tiers, the hashes, the orders), `pilot-analyze.test.ts` (hand-made results files), `apps/web/test/pilot.test.ts`, and the `pilot` Playwright project (`e2e/pilot/`).
- Related: ADR-0031 (the 200 debriefs and their cassettes), ADR-0032 (reviews and the writers' rules), ADR-0035 (the inbox, the tiers, "accept all").
