# The review pilot: pre-registration

**Status: draft.** Three things are filled in before the first session, in one commit, and nothing else changes after it:
- the commit the pilot runs on;
- `pilot.v1`'s SHA-256, from its `manifest.json`;
- the decision on reporting (the last section).

| | |
|---|---|
| Commit the pilot runs on | *to be filled in before the first session* |
| Set | `pilot.v1`, SHA-256 *to be filled in from `manifest.json`* |
| Analysis | `pilot:analyze` in `packages/evals`, at that commit |

## Participants
- **Who:** five volunteers, ideally people who sell. They are labelled P1 to P5, and each gets their own order of the same set (`/pilot?p=1` to `?p=5`).
- **Consent:** `docs/pilot/consent.md`, shown on the pilot page's first screen.

## Materials
`pilot.v1`, built from the 200 synthetic debriefs (ADR-0039):
- 10 sessions holding 40 proposals, the same for everyone;
- 4 **flagged** wrong-account errors, which reach the reviewer as a question with the wrong record first;
- 4 **silent** wrong-account errors, a correct link swapped to a sound-alike, which carry only the name note;
- 3 practice cards with no seeded errors.

The set's tier mix is reported as built. It is never thinned to help the clock.

## Primary measure: review time
- **Measure:** each participant's median `handlingMs` over single-mode decisions, then the median of the five.
- **Threshold:** under 4,000 ms (Phase 5 gate G1b).
- **Reported with** the five medians' minimum and maximum. For five independent participants, that range covers the population median with probability 93.75%.

## Secondary measures
- **Pooled 90th percentile** of `handlingMs`, for loud cards and for the rest.
- **Batches:** the share of cards decided by "accept all", and the time per batch. Each batch counts once, by its `batchId`, never spread over its cards.

## Catch rate
- **Measure:** seeded errors caught, pooled over the five participants, out of 40 (Phase 5 gate G2b).
  - A **flagged** error is caught when its final decision is "New" or a rejection.
  - A **silent** error is caught when its final decision is the right record or a rejection.
- **Final decisions count.** An error accepted and then reopened and fixed counts as caught, and is also reported separately, as "caught after accepting".
- **Threshold:** at least 90% (36 of 40), as a point estimate.
- **Reported with:**
  - a two-sided 95% Clopper–Pearson interval (36 of 40 gives 76.3–97.2%);
  - each participant's count;
  - flagged and silent errors separately.
- **The limit:** with 40 seeded errors, the interval's lower end clears 90% only with no misses at all (40 of 40 gives 91.2–100%; 39 of 40 gives 86.8–99.9%). At the threshold, 36 of 40, the result is a point estimate, not a bound.
- **The flag-follower bound:** a reviewer who accepts everything unmarked or quiet catches only the 4 flagged errors, 4 of 8 per participant. It is reported beside the result.

## Exclusions
- The practice cards.
- Paused time: the clock stops while the page is hidden, the card is less than half visible, or there has been no input for 30 s.
- **Short sessions:** a participant with fewer than 30 decisions is reported, but left out of the medians.

## Analysis
- `pilot:analyze` runs as is, on the five results files, at the commit above.
- There are no interim looks: nothing is analyzed until all five files are in.
- Any deviation from this plan, such as an interrupted session, is reported with the results.

## Reporting
*To be decided by the project's owner before the first session, and written here:*
- whether the project's Phase 8 technical report uses these results;
- if it does, whether an ethics review applies. As an independent project there may be no board to ask, and if so the report says so.

Until this is decided, the results are for the project's own gate only.
