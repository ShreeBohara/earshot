// The live smoke gate (Phase 4 WP11 step 4; gates G2c and G3b; ADR-0031), against
// baselines/smoke-<provider>.json: the median of three baseline runs, with each metric's spread.
// A run fails when:
//
// - key-field accuracy, target accuracy, or proposal F1 is more than max(3 points, 2 × the
//   metric's spread) below the baseline's median. Haiku 5.5 takes no sampling settings, so live
//   runs vary, and 30 scripts can't resolve 3 points alone (spec decision 14);
// - evidence coverage is under 100% (G2c);
// - the end-to-end wrong-account rate is above 2%;
// - the run is incomplete: stopped by the budget, by provider failures, or by a cancel;
// - there's no baseline. A live run with nothing to compare against can't pass, or a first run
//   would look like a pass by default. The absolute gates still run and are reported, and the
//   failure says to record one (`baseline:smoke`);
// - the baseline doesn't fit the run: another provider or model, another linker, or other
//   scripts. Its regression comparison is skipped, and the failure says to record it again;
// - and, for each script's recap (Phase 5 WP10; ./recap.ts): a recap that wasn't written (the
//   model's output failed validation on both attempts; a failed recap has no sentences, so the two
//   rates below can't see it), a kept sentence without evidence, or a drop rate more than
//   max(5 points, 2 × its spread) above the baseline's median (target).
//
// One automatic re-run within the budget (spec §8's answer to a flapping gate): when a complete
// run fails only on the noisy checks (a regression, the wrong-account rate, or a recap that wasn't
// written), and what's left of the budget covers another run's estimate, the run is repeated, and
// the job fails only if the repeat fails too. Evidence coverage is the pipeline's honesty, not the
// model's luck, so it never earns a re-run.
import { LlmProvider } from "@earshot/core";
import { z } from "zod";
import { summarize, UnderstandingSummary } from "../understanding/gate";
import type { UnderstandingMetrics } from "../understanding/metrics";
import { allowedRecapRise, SMOKE_RECAP_GATE, SmokeRecapSummary } from "./recap";

export const SMOKE_GATE = {
  /** The least a gated metric may fall below the baseline's median before it fails. */
  minDrop: 0.03,
  /** Or this many times the metric's spread across the baseline runs, if that's more. */
  spreadFactor: 2,
  minEvidenceCoverage: 1,
  maxWrongAccountRate: 0.02,
} as const;

/** The metrics the regression check guards (spec WP11 step 4), and how each is read. */
export const SMOKE_GATED = {
  keyFieldAccuracy: (m: UnderstandingMetrics) => m.keyFields.rate,
  targetAccuracy: (m: UnderstandingMetrics) => m.targets.rate,
  proposalF1: (m: UnderstandingMetrics) => m.proposals.f1,
} as const;
export type SmokeGatedMetric = keyof typeof SMOKE_GATED;
export const SMOKE_GATED_METRICS = Object.keys(SMOKE_GATED) as SmokeGatedMetric[];

/** One run's numbers: the understanding eval's summary, and proposal F1. */
export const SmokeSummary = UnderstandingSummary.extend({
  proposalF1: z.number().min(0).max(1).nullable(),
});
export type SmokeSummary = z.infer<typeof SmokeSummary>;

const round = (value: number | null) =>
  value === null ? null : Math.round(value * 1_000_000) / 1_000_000;

export function smokeSummary(metrics: UnderstandingMetrics): SmokeSummary {
  return { ...summarize(metrics), proposalF1: round(metrics.proposals.f1) };
}

const Rates = z.strictObject(
  Object.fromEntries(
    SMOKE_GATED_METRICS.map((name) => [name, z.number().min(0).max(1).nullable()]),
  ) as Record<SmokeGatedMetric, z.ZodNullable<z.ZodNumber>>,
);
export type SmokeRates = z.infer<typeof Rates>;

/**
 * 2 from Phase 5 WP10: the runs' recap numbers, and the recap drop rate's median and spread. No
 * format 1 baseline was ever recorded.
 */
export const SMOKE_BASELINE_FORMAT = 2;

/** The recap's gated rate across the baseline runs. */
const RecapRates = z.strictObject({ dropRate: z.number().min(0).max(1).nullable() });
export type SmokeRecapRates = z.infer<typeof RecapRates>;
export const SMOKE_BASELINE_RUNS = 3;

export const SmokeBaseline = z.strictObject({
  format: z.literal(SMOKE_BASELINE_FORMAT),
  provider: LlmProvider,
  model: z.string().min(1),
  /** The linker the runs went through (`LINKER_PARAMS_V1.version`). */
  linker: z.string().min(1),
  /** The scripts every run covered, and the SHA-256 over their files' bytes, in id order. */
  scripts: z.array(z.string().regex(/^d\d{3}$/)).min(1),
  scriptsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  recordedAt: z.iso.date(),
  /** Where the runs happened: a commit and CI run, or "local". */
  source: z.string().min(1),
  runs: z.array(SmokeSummary).length(SMOKE_BASELINE_RUNS),
  /** What each run spent, in USD. */
  spentUsd: z.array(z.number().nonnegative()).length(SMOKE_BASELINE_RUNS),
  /** Each gated metric's median across the runs, and its spread (the largest minus the smallest). */
  median: Rates,
  spread: Rates,
  /** Each run's recap numbers (Phase 5 WP10), and the drop rate's median and spread. */
  recapRuns: z.array(SmokeRecapSummary).length(SMOKE_BASELINE_RUNS),
  recapMedian: RecapRates,
  recapSpread: RecapRates,
});
export type SmokeBaseline = z.infer<typeof SmokeBaseline>;

/** The recap drop rate's median and spread across runs; null when a run wrote no sentence. */
export function baselineRecapRates(runs: readonly SmokeRecapSummary[]): {
  median: SmokeRecapRates;
  spread: SmokeRecapRates;
} {
  const values = runs.map((run) => run.dropRate);
  if (values.length === 0 || values.some((value) => value === null)) {
    return { median: { dropRate: null }, spread: { dropRate: null } };
  }
  const numbers = values as number[];
  return {
    median: { dropRate: round(median(numbers)) },
    spread: { dropRate: round(Math.max(...numbers) - Math.min(...numbers)) },
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Each gated metric's median and spread across runs; null for a metric some run couldn't score. */
export function baselineRates(runs: readonly SmokeSummary[]): {
  median: SmokeRates;
  spread: SmokeRates;
} {
  const medianOut = {} as Record<SmokeGatedMetric, number | null>;
  const spreadOut = {} as Record<SmokeGatedMetric, number | null>;
  for (const name of SMOKE_GATED_METRICS) {
    const values = runs.map((run) => run[name]);
    if (values.length === 0 || values.some((value) => value === null)) {
      medianOut[name] = null;
      spreadOut[name] = null;
      continue;
    }
    const numbers = values as number[];
    medianOut[name] = round(median(numbers));
    spreadOut[name] = round(Math.max(...numbers) - Math.min(...numbers));
  }
  return { median: medianOut, spread: spreadOut };
}

/** The drop a gated metric is allowed below the median: max(3 points, 2 × its spread). */
export function allowedDrop(spread: number | null): number {
  return Math.max(SMOKE_GATE.minDrop, SMOKE_GATE.spreadFactor * (spread ?? 0));
}

/** What a run is, for checking that a baseline fits it. */
export interface SmokeIdentity {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly linker: string;
  readonly scripts: readonly string[];
  readonly scriptsSha256: string;
}

export type SmokeFailureKind =
  | "incomplete"
  | "evidence"
  | "recap_failed"
  | "wrong_account"
  | "regression"
  | "no_baseline"
  | "stale_baseline";

export interface SmokeFailure {
  readonly kind: SmokeFailureKind;
  /** Numbers and fixed words only: never a prompt, transcript, or model output. */
  readonly message: string;
}

export interface SmokeGateInput {
  /** The scored scripts' metrics; null when nothing could be scored. */
  readonly metrics: UnderstandingMetrics | null;
  /** The run's recap numbers (Phase 5 WP10); null when it wrote none. */
  readonly recap?: SmokeRecapSummary | null;
  readonly complete: boolean;
  /** Why an incomplete run stopped, as a fixed code. */
  readonly stopDetail?: string | null;
  readonly baseline: SmokeBaseline | null;
  readonly identity: SmokeIdentity;
  /** The baseline file, as the failure messages name it. */
  readonly baselineFile: string;
}

const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const points = (value: number) => `${(value * 100).toFixed(1)} points`;

/** Why a baseline doesn't fit a run, or null when it does. */
export function baselineMismatch(baseline: SmokeBaseline, identity: SmokeIdentity): string | null {
  if (baseline.provider !== identity.provider || baseline.model !== identity.model) {
    return `it was recorded on ${baseline.provider}/${baseline.model}, and this run is ${identity.provider}/${identity.model}`;
  }
  if (baseline.linker !== identity.linker) {
    return `it was recorded with ${baseline.linker}, and this run uses ${identity.linker}`;
  }
  if (baseline.scripts.join(",") !== identity.scripts.join(",")) {
    return "it was recorded on another set of scripts";
  }
  if (baseline.scriptsSha256 !== identity.scriptsSha256) {
    return "a script it was recorded on has changed since";
  }
  return null;
}

/** The gate's failures for one run; empty when it passes. */
export function smokeGateFailures(input: SmokeGateInput): SmokeFailure[] {
  const failures: SmokeFailure[] = [];
  const { metrics, baseline, identity } = input;
  const record = `pnpm --filter @earshot/evals baseline:smoke --provider ${identity.provider}`;
  if (!input.complete) {
    failures.push({
      kind: "incomplete",
      message: `the run is incomplete (${input.stopDetail ?? "not every turn was answered"}): it can't be scored as a pass, and isn't a regression`,
    });
  }
  if (metrics !== null) {
    const coverage = metrics.evidence.rate;
    if (coverage === null || coverage < SMOKE_GATE.minEvidenceCoverage) {
      failures.push({
        kind: "evidence",
        message: `G2c: evidence coverage ${pct(coverage)} is under 100% (${metrics.evidence.of - metrics.evidence.n} of ${metrics.evidence.of} items, ${metrics.evidence.unquotedLinked} unquoted targets linked)`,
      });
    }
    const wrong = metrics.wrongAccount.rate;
    if (wrong !== null && wrong > SMOKE_GATE.maxWrongAccountRate) {
      failures.push({
        kind: "wrong_account",
        message: `the end-to-end wrong-account rate ${pct(wrong)} (${metrics.wrongAccount.n} of ${metrics.wrongAccount.of} decided) is above ${pct(SMOKE_GATE.maxWrongAccountRate)}`,
      });
    }
  }
  const recap = input.recap ?? null;
  if (
    recap !== null &&
    recap.evidenceCoverage !== null &&
    recap.evidenceCoverage < SMOKE_RECAP_GATE.minEvidenceCoverage
  ) {
    failures.push({
      kind: "evidence",
      message: `recap evidence ${pct(recap.evidenceCoverage)} is under 100% (${recap.kept - recap.withEvidence} of ${recap.kept} kept sentences without evidence)`,
    });
  }
  if (recap !== null && recap.created < recap.recaps) {
    failures.push({
      kind: "recap_failed",
      message: `${recap.recaps - recap.created} of ${recap.recaps} recaps weren't written: every script needs one, and a recap whose output fails validation twice has no sentences to score`,
    });
  }
  if (baseline === null) {
    failures.push({
      kind: "no_baseline",
      message: `no ${input.baselineFile}: a live run has nothing to be compared with, so it can't pass. Record one with \`${record}\` (three runs; needs approval), review it, and commit it`,
    });
    return failures;
  }
  const mismatch = baselineMismatch(baseline, identity);
  if (mismatch !== null) {
    failures.push({
      kind: "stale_baseline",
      message: `${input.baselineFile} doesn't fit this run: ${mismatch}. Record it again with \`${record}\``,
    });
    return failures;
  }
  const dropThen = baseline.recapMedian.dropRate;
  if (recap !== null && dropThen !== null) {
    const allowed = allowedRecapRise(baseline.recapSpread.dropRate);
    const dropNow = recap.dropRate;
    if (dropNow !== null && dropNow > dropThen + allowed + 1e-9) {
      failures.push({
        kind: "regression",
        message: `regression: the recap drop rate ${pct(dropNow)} is more than ${points(allowed)} above the baseline's median ${pct(dropThen)} (the allowance is max(5 points, 2 × the spread of ${points(baseline.recapSpread.dropRate ?? 0)}))`,
      });
    }
  }
  if (metrics === null) return failures;
  for (const name of SMOKE_GATED_METRICS) {
    const then = baseline.median[name];
    if (then === null) continue;
    const allowed = allowedDrop(baseline.spread[name]);
    const now = SMOKE_GATED[name](metrics);
    if (now === null || now < then - allowed - 1e-9) {
      failures.push({
        kind: "regression",
        message: `regression: ${name} ${pct(now)} is more than ${points(allowed)} below the baseline's median ${pct(then)} (the allowance is max(3 points, 2 × the spread of ${points(baseline.spread[name] ?? 0)}))`,
      });
    }
  }
  return failures;
}

/** The failures a re-run can clear: the checks live sampling can trip by chance. */
const NOISY: ReadonlySet<SmokeFailureKind> = new Set([
  "regression",
  "wrong_account",
  "recap_failed",
]);

/**
 * Whether to run once more (see the top of the file): the run failed only on noisy checks, and
 * what's left of the budget covers another run's estimate.
 */
export function shouldRerun(input: {
  readonly failures: readonly SmokeFailure[];
  readonly spentUsd: number;
  readonly budgetUsd: number;
  readonly estimateUsd: number;
}): boolean {
  if (input.failures.length === 0) return false;
  if (!input.failures.every((failure) => NOISY.has(failure.kind))) return false;
  return input.spentUsd + input.estimateUsd <= input.budgetUsd + 1e-12;
}
