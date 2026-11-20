// @earshot/evals/understanding: eval harness v1's 200 debriefs (Phase 4 WP10; ADR-0031): the 30
// hand-written scripts and the 170 the seeded grammar generated, and their extended ground-truth
// checks.
//
// A separate entry point from `@earshot/evals`: it holds the 170 generated scripts, which the
// e2e edge Worker never needs to bundle.
export { ALL_DEBRIEFS, anyDebrief, GENERATED_DEBRIEFS, GENERATED_FILES } from "./debriefs";
export { groundTruthProblems, unbiasedReadingOf } from "./verify";
