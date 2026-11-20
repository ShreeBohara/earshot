// The $0 understanding gate (Phase 4 WP10 step 7; gate G2b, G3a) and its committed baseline.
// `eval:understanding --check` fails, for either provider's cassettes, when:
//
// - a key metric (`KEY_METRICS`) drops by more than 3 points against baselines/understanding.json;
// - so does the catch rate of any risk kind the scripts expect (`expectFlags`): the share of the
//   proposals expected to carry it that did. Values and targets can stay right while a warning
//   such as `negation` stops coming, and only this notices;
// - evidence coverage is under 100% (a field or named target whose evidence isn't the words the
//   model quoted, or an unquoted target linked anyway: G2b);
// - the end-to-end wrong-account rate is above 2%;
// - a cassette couldn't answer a request (the cassettes are stale: regenerate them);
// - the baseline was recorded on other scripts or other seeded errors (re-record it on purpose);
// - the likely-edit tiers break their budgets (Phase 5 WP4, spec §4.4): loud on more than the
//   interim ceiling's share of final proposals (18%, until false witness conflicts fall and the
//   spec's 15% can hold; tiers.ts), any card marker on more than 35%, or fewer than 95% of the
//   seeded errors marked, the name note included.
import { RiskKindV2 } from "@earshot/core";
import { z } from "zod";
import type { UnderstandingMetrics } from "./metrics";
import {
  LOUD_SHARE_INTERIM_CEILING,
  LOUD_SHARE_TARGET,
  MARKED_SHARE_BUDGET,
  SURFACING_RECALL_BUDGET,
} from "./tiers";

export const UNDERSTANDING_GATE = {
  /** A key metric may fall this far below its baseline. */
  maxDrop: 0.03,
  minEvidenceCoverage: 1,
  maxWrongAccountRate: 0.02,
  /**
   * The loud share's gate: the interim ceiling, not the spec's 15% (`LOUD_SHARE_TARGET`), which
   * asks, conflicts, and unsupported values alone exceed (`LOUD_SHARE_INTERIM_CEILING`).
   */
  maxLoudShare: LOUD_SHARE_INTERIM_CEILING,
  maxMarkedShare: MARKED_SHARE_BUDGET,
  minSurfacingRecall: SURFACING_RECALL_BUDGET,
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
  /** Each expected risk kind's catch rate: proposals expected to carry it that did. */
  expectedFlags: z.partialRecord(RiskKindV2, z.number().min(0).max(1).nullable()),
  proposals: z.int().nonnegative(),
  decided: z.int().nonnegative(),
  // The likely-edit tiers (Phase 5 WP4): recorded with the rest; gated by their budgets alone.
  loudShare: z.number().min(0).max(1).nullable(),
  markedShare: z.number().min(0).max(1).nullable(),
  nameNoteShare: z.number().min(0).max(1).nullable(),
  /** Asks, witness conflicts, and unsupported values: the floor under the loud share. */
  loudFloorShare: z.number().min(0).max(1).nullable(),
  surfacingRecall: z.number().min(0).max(1).nullable(),
  loudPrecision: z.number().min(0).max(1).nullable(),
  quietPrecision: z.number().min(0).max(1).nullable(),
  nameNotePrecision: z.number().min(0).max(1).nullable(),
  hiddenWrongAccounts: z.int().nonnegative(),
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
    expectedFlags: Object.fromEntries(
      Object.entries(metrics.expectedFlags).map(([kind, ratio]) => [
        kind,
        round(ratio?.rate ?? null),
      ]),
    ),
    proposals: metrics.proposals.actual,
    decided: metrics.wrongAccount.of,
    loudShare: round(metrics.tiers.loud.rate),
    markedShare: round(metrics.tiers.marked.rate),
    nameNoteShare: round(metrics.tiers.nameNoteOnly.rate),
    loudFloorShare: round(metrics.tiers.loudFloor.rate),
    surfacingRecall: round(metrics.tiers.surfacing.rate),
    loudPrecision: round(metrics.tiers.precision.loud.rate),
    quietPrecision: round(metrics.tiers.precision.quiet.rate),
    nameNotePrecision: round(metrics.tiers.precision.nameNote.rate),
    hiddenWrongAccounts: metrics.tiers.hiddenWrongAccounts,
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
  failures.push(...tierBudgetFailures(at, metrics));
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
    for (const [kind, then] of Object.entries(baseline.expectedFlags) as [
      RiskKindV2,
      number | null,
    ][]) {
      if (then === null) continue;
      const now = metrics.expectedFlags[kind]?.rate ?? null;
      if (now === null || now < then - UNDERSTANDING_GATE.maxDrop - 1e-9) {
        failures.push(
          `${at} regression: expected \`${kind}\` flags raised ${pct(now)}, more than 3 points below ${pct(then)}`,
        );
      }
    }
  }
  return failures;
}

/**
 * The tiers' budgets (spec §4.4): loud at most the interim ceiling, any card marker at most 35%,
 * and at least 95% of the seeded errors marked. A share with nothing to divide (no proposals, no
 * seeded errors, as in a hand-built run) isn't gated.
 */
function tierBudgetFailures(at: string, metrics: UnderstandingMetrics): string[] {
  const failures: string[] = [];
  const { tiers } = metrics;
  const loud = tiers.loud.rate;
  if (loud !== null && loud > UNDERSTANDING_GATE.maxLoudShare + 1e-9) {
    failures.push(
      `${at} the loud share ${pct(loud)} (${tiers.loud.n}/${tiers.loud.of}) is over its interim ceiling of ${pct(UNDERSTANDING_GATE.maxLoudShare)} (the spec's budget is ${pct(LOUD_SHARE_TARGET)}; asks, conflicts, and unsupported values alone are ${pct(tiers.loudFloor.rate)})`,
    );
  }
  const marked = tiers.marked.rate;
  if (marked !== null && marked > UNDERSTANDING_GATE.maxMarkedShare + 1e-9) {
    failures.push(
      `${at} the marked share ${pct(marked)} (${tiers.marked.n}/${tiers.marked.of}) is over ${pct(UNDERSTANDING_GATE.maxMarkedShare)}: a sea of color`,
    );
  }
  const surfacing = tiers.surfacing.rate;
  if (surfacing !== null && surfacing < UNDERSTANDING_GATE.minSurfacingRecall - 1e-9) {
    failures.push(
      `${at} surfacing recall ${pct(surfacing)} (${tiers.surfacing.n}/${tiers.surfacing.of} seeded errors marked) is under ${pct(UNDERSTANDING_GATE.minSurfacingRecall)}`,
    );
  }
  return failures;
}
