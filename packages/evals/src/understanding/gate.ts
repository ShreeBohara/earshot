// The $0 understanding gate (Phase 4 WP10 step 7; gate G2b, G3a) and its committed baseline.
// `eval:understanding --check` fails, for either provider's cassettes, when:
//
// - a key metric (`KEY_METRICS`) drops by more than 3 points against baselines/understanding.json;
// - evidence coverage is under 100% (a field or named target whose evidence isn't the words the
//   model quoted, or an unquoted target linked anyway: G2b);
// - the end-to-end wrong-account rate is above 2%;
// - a cassette couldn't answer a request (the cassettes are stale: regenerate them);
// - the baseline was recorded on other scripts or other seeded errors (re-record it on purpose).
import { z } from "zod";
import type { UnderstandingMetrics } from "./metrics";

export const UNDERSTANDING_GATE = {
  /** A key metric may fall this far below its baseline. */
  maxDrop: 0.03,
  minEvidenceCoverage: 1,
  maxWrongAccountRate: 0.02,
} as const;

/** The metrics the regression check guards, by name, and how each is read off the metrics. */
export const KEY_METRICS = {
  keyFieldAccuracy: (m: UnderstandingMetrics) => m.keyFields.rate,
  proposalPrecision: (m: UnderstandingMetrics) => m.proposals.precision,
  proposalRecall: (m: UnderstandingMetrics) => m.proposals.recall,
  jointActionAccuracy: (m: UnderstandingMetrics) => m.jointActions.rate,
  targetAccuracy: (m: UnderstandingMetrics) => m.targets.rate,
  dateAccuracy: (m: UnderstandingMetrics) => m.dates.rate,
  amountAccuracy: (m: UnderstandingMetrics) => m.amounts.rate,
  negationAccuracy: (m: UnderstandingMetrics) => m.negation.rate,
  conflictPrecision: (m: UnderstandingMetrics) => m.conflicts.precision,
  conflictRecall: (m: UnderstandingMetrics) => m.conflicts.recall,
  wrongDatesCaught: (m: UnderstandingMetrics) => m.seeded.wrong_date.rate,
  wrongAmountsCaught: (m: UnderstandingMetrics) => m.seeded.wrong_amount.rate,
  paraphrasedTargetsRefused: (m: UnderstandingMetrics) => m.seeded.paraphrased_target.rate,
} as const;
export type KeyMetric = keyof typeof KEY_METRICS;

/** What a baseline keeps per provider: every key metric, and the absolute gates' inputs. */
export const UnderstandingSummary = z.strictObject({
  ...(Object.fromEntries(
    Object.keys(KEY_METRICS).map((name) => [name, z.number().min(0).max(1).nullable()]),
  ) as Record<KeyMetric, z.ZodNullable<z.ZodNumber>>),
  evidenceCoverage: z.number().min(0).max(1).nullable(),
  wrongAccountRate: z.number().min(0).max(1).nullable(),
  wrongAccountBound: z.number().min(0).max(1).nullable(),
  biasedOnlyWrongAccountRate: z.number().min(0).max(1).nullable(),
  flagShare: z.number().min(0).max(1).nullable(),
  proposals: z.int().nonnegative(),
  decided: z.int().nonnegative(),
});
export type UnderstandingSummary = z.infer<typeof UnderstandingSummary>;

export const UNDERSTANDING_BASELINE_FORMAT = 1;

export const UnderstandingBaseline = z.strictObject({
  format: z.literal(UNDERSTANDING_BASELINE_FORMAT),
  /** SHA-256 over the 200 script files' bytes, in id order. */
  scriptsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** SHA-256 of cassettes/understanding/errors.json. */
  errorsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  linker: z.string().min(1),
  recordedAt: z.iso.date(),
  providers: z.strictObject({ anthropic: UnderstandingSummary, groq: UnderstandingSummary }),
});
export type UnderstandingBaseline = z.infer<typeof UnderstandingBaseline>;

const round = (value: number | null) =>
  value === null ? null : Math.round(value * 1_000_000) / 1_000_000;

/** A provider's metrics as the baseline keeps them, rounded to 6 decimals. */
export function summarize(metrics: UnderstandingMetrics): UnderstandingSummary {
  const keys = Object.fromEntries(
    (Object.entries(KEY_METRICS) as [KeyMetric, (m: UnderstandingMetrics) => number | null][]).map(
      ([name, read]) => [name, round(read(metrics))],
    ),
  ) as Record<KeyMetric, number | null>;
  return {
    ...keys,
    evidenceCoverage: round(metrics.evidence.rate),
    wrongAccountRate: round(metrics.wrongAccount.rate),
    wrongAccountBound: round(metrics.wrongAccount.bound),
    biasedOnlyWrongAccountRate: round(metrics.wrongAccountBiasedOnly.rate),
    flagShare: round(metrics.flags.rate),
    proposals: metrics.proposals.actual,
    decided: metrics.wrongAccount.of,
  };
}

const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

/** The gate's failures for one provider, as messages; empty when it passes. */
export function understandingGateFailures(
  provider: string,
  metrics: UnderstandingMetrics,
  baseline: UnderstandingSummary | null,
): string[] {
  const failures: string[] = [];
  const at = `${provider}:`;
  if (metrics.misses > 0) {
    failures.push(
      `${at} the cassettes couldn't answer ${metrics.misses} requests; regenerate them (pnpm --filter @earshot/evals cassettes:gen)`,
    );
  }
  const coverage = metrics.evidence.rate;
  if (coverage === null || coverage < UNDERSTANDING_GATE.minEvidenceCoverage) {
    failures.push(
      `${at} G2b: evidence coverage ${pct(coverage)} is under 100% (${metrics.evidence.of - metrics.evidence.n} items, ${metrics.evidence.unquotedLinked} unquoted targets linked)`,
    );
  }
  const wrong = metrics.wrongAccount.rate;
  if (wrong !== null && wrong > UNDERSTANDING_GATE.maxWrongAccountRate) {
    failures.push(
      `${at} the end-to-end wrong-account rate ${pct(wrong)} is above ${pct(UNDERSTANDING_GATE.maxWrongAccountRate)}`,
    );
  }
  if (baseline !== null) {
    for (const [name, read] of Object.entries(KEY_METRICS) as [
      KeyMetric,
      (m: UnderstandingMetrics) => number | null,
    ][]) {
      const now = read(metrics);
      const then = baseline[name];
      if (then === null) continue;
      if (now === null || now < then - UNDERSTANDING_GATE.maxDrop - 1e-9) {
        failures.push(
          `${at} regression: ${name} ${pct(now)} fell more than 3 points from ${pct(then)}`,
        );
      }
    }
  }
  return failures;
}
