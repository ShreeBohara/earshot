// Gate G1a (spec §6) and the regression check (WP5 step 4), and the committed baselines they
// compare against. `eval:linking --check` applies G1's thresholds to a linker meant to pass them
// (v1 and later), and the regression check to every linker that has a baseline: v0's
// (baselines/linking-v0.json) records Phase 3's matcher on confusable.v1, so a change to the set
// or to the matcher shows up as a diff.
import { z } from "zod";
import type { LinkingMetrics } from "./metrics";
import { ITEM_CLASSES, type ItemClass } from "./schema";

/** G1a, on the test split's final decisions. */
export const G1 = {
  maxWrongAccountRate: 0.02,
  minCoverage: 0.85,
  maxNewWhenExistingRate: 0.05,
} as const;

/** How far a metric may move against its baseline before `--check` fails. */
export const REGRESSION = {
  coverageDrop: 0.03,
  wrongAccountRise: 0.005,
} as const;

const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

/** G1a's failures, as messages; empty when it passes. */
export function gateFailures(metrics: LinkingMetrics): string[] {
  const failures: string[] = [];
  if (metrics.wrongAccountRate === null || metrics.wrongAccountRate > G1.maxWrongAccountRate) {
    failures.push(
      `G1: wrong-account rate ${pct(metrics.wrongAccountRate)} is above ${pct(G1.maxWrongAccountRate)}`,
    );
  }
  if (metrics.coverage < G1.minCoverage) {
    failures.push(`G1: coverage ${pct(metrics.coverage)} is below ${pct(G1.minCoverage)}`);
  }
  if ((metrics.newWhenExistingRate ?? 0) > G1.maxNewWhenExistingRate) {
    failures.push(
      `G1: new-when-existing ${pct(metrics.newWhenExistingRate)} is above ${pct(G1.maxNewWhenExistingRate)}`,
    );
  }
  return failures;
}

/** Regressions against a baseline's numbers for the same split, as messages. */
export function regressionFailures(metrics: LinkingMetrics, baseline: LinkingMetrics): string[] {
  const failures: string[] = [];
  if (metrics.coverage < baseline.coverage - REGRESSION.coverageDrop - 1e-9) {
    failures.push(
      `Regression: coverage ${pct(metrics.coverage)} fell more than 3 points from ${pct(baseline.coverage)}`,
    );
  }
  const now = metrics.wrongAccountRate ?? 0;
  const then = baseline.wrongAccountRate ?? 0;
  if (now > then + REGRESSION.wrongAccountRise + 1e-9) {
    failures.push(
      `Regression: wrong-account rate ${pct(now)} rose more than 0.5 point from ${pct(then)}`,
    );
  }
  return failures;
}

const Rate = z.number().min(0).max(1).nullable();
const Count = z.int().nonnegative();

export const LinkingMetricsSchema = z.strictObject({
  items: Count,
  decided: Count,
  coverage: z.number().min(0).max(1),
  linked: Count,
  wrongLinks: Count,
  wrongAccountRate: Rate,
  bound: Rate,
  newDecisions: Count,
  newWhenExisting: Count,
  newWhenExistingRate: Rate,
  correct: Count,
  accuracyOnDecided: Rate,
  asExpected: Count,
  aurc: Rate,
  ece: Rate,
  flagged: Count,
  hiddenErrors: Count,
  hiddenErrorRate: Rate,
  divergenceRecall: Rate,
});

const SplitSummary = z.strictObject({
  final: LinkingMetricsSchema,
  biasedOnly: LinkingMetricsSchema,
  perClass: z.record(z.enum(ITEM_CLASSES), LinkingMetricsSchema),
});
export type SplitSummary = z.infer<typeof SplitSummary>;

export const BASELINE_FORMAT = 1;

export const LinkingBaseline = z.strictObject({
  format: z.literal(BASELINE_FORMAT),
  linker: z.string().min(1),
  set: z.string().min(1),
  /** SHA-256 of the set file the numbers came from. */
  setSha256: z.string().regex(/^[0-9a-f]{64}$/),
  recordedAt: z.iso.date(),
  splits: z.strictObject({ calibration: SplitSummary, test: SplitSummary }),
});
export type LinkingBaseline = z.infer<typeof LinkingBaseline>;

/** Rounds every rate to 6 decimals, so a baseline's diff shows changes, not float noise. */
export function roundMetrics(metrics: LinkingMetrics): LinkingMetrics {
  const round = (value: number | null) =>
    value === null ? null : Math.round(value * 1_000_000) / 1_000_000;
  return {
    ...metrics,
    coverage: round(metrics.coverage) ?? 0,
    wrongAccountRate: round(metrics.wrongAccountRate),
    bound: round(metrics.bound),
    newWhenExistingRate: round(metrics.newWhenExistingRate),
    accuracyOnDecided: round(metrics.accuracyOnDecided),
    aurc: round(metrics.aurc),
    ece: round(metrics.ece),
    hiddenErrorRate: round(metrics.hiddenErrorRate),
    divergenceRecall: round(metrics.divergenceRecall),
  };
}

export function splitSummary(report: {
  final: LinkingMetrics;
  biasedOnly: LinkingMetrics;
  perClass: Readonly<Record<ItemClass, LinkingMetrics>>;
}): SplitSummary {
  return {
    final: roundMetrics(report.final),
    biasedOnly: roundMetrics(report.biasedOnly),
    perClass: Object.fromEntries(
      ITEM_CLASSES.map((itemClass) => [itemClass, roundMetrics(report.perClass[itemClass])]),
    ) as Record<ItemClass, LinkingMetrics>,
  };
}
