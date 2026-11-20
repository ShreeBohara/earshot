// The live smoke eval end to end, short of files and the environment (Phase 4 WP11): a run, its
// gate, the one re-run the budget may allow, and the report; and the three runs a baseline is
// recorded from. The CLIs (scripts/eval-smoke.ts, scripts/baseline-smoke.ts) add the key, the
// files, and the printing, so everything here runs in a test against a scripted provider.
import type { LlmProvider } from "@earshot/core";
import { understandingMetrics } from "../understanding/metrics";
import type { SmokeEstimate } from "./budget";
import {
  baselineRates,
  SMOKE_BASELINE_FORMAT,
  SMOKE_BASELINE_RUNS,
  type SmokeBaseline,
  type SmokeFailure,
  type SmokeIdentity,
  shouldRerun,
  smokeGateFailures,
  smokeSummary,
} from "./gate";
import { SMOKE_REPORT_VERSION, type SmokeReport, smokeAttempt } from "./report";
import { LIVE_LABELS, runSmoke, type SmokeRun, type SmokeRunOptions, scoredRuns } from "./run";

export interface SmokeEvalOptions
  extends Omit<SmokeRunOptions, "budgetUsd" | "perCallUsd" | "provider"> {
  readonly identity: SmokeIdentity;
  readonly budgetUsd: number;
  /** The estimate the run was allowed on: its per-call charge, and the re-run's price. */
  readonly estimate: SmokeEstimate;
  readonly baseline: SmokeBaseline | null;
  /** The baseline's path, as messages and the report name it. */
  readonly baselineFile: string;
  /** A $0 run against the offline cassettes rather than a live model. */
  readonly offline: boolean;
  readonly source: string;
  readonly startedAt: string;
}

export interface SmokeEvalResult {
  readonly report: SmokeReport;
  readonly runs: readonly SmokeRun[];
  readonly failures: readonly SmokeFailure[];
}

function gateOf(run: SmokeRun, options: SmokeEvalOptions): SmokeFailure[] {
  const scored = scoredRuns(run);
  return smokeGateFailures({
    metrics: scored.length === 0 ? null : understandingMetrics(scored, LIVE_LABELS),
    complete: run.complete,
    stopDetail: run.stop?.detail ?? null,
    baseline: options.baseline,
    identity: options.identity,
    baselineFile: options.baselineFile,
  });
}

/** One gated smoke eval: a run, its gate, and at most one re-run within the budget. */
export async function smokeEval(options: SmokeEvalOptions): Promise<SmokeEvalResult> {
  const runOptions = {
    ...options,
    provider: options.identity.provider,
    perCallUsd: options.estimate.perCallUsd,
  };
  const first = await runSmoke({ ...runOptions, budgetUsd: options.budgetUsd });
  const firstGate = gateOf(first, options);
  const runs = [first];
  const gates = [firstGate];
  if (
    shouldRerun({
      failures: firstGate,
      spentUsd: first.spentUsd,
      budgetUsd: options.budgetUsd,
      estimateUsd: options.estimate.totalUsd,
    })
  ) {
    const second = await runSmoke({
      ...runOptions,
      budgetUsd: Math.max(0, options.budgetUsd - first.spentUsd),
    });
    runs.push(second);
    gates.push(gateOf(second, options));
  }
  const failures = gates[gates.length - 1] as SmokeFailure[];
  const { estimate, baseline, identity } = options;
  const report: SmokeReport = {
    version: SMOKE_REPORT_VERSION,
    provider: identity.provider,
    model: identity.model,
    linker: identity.linker,
    startedAt: options.startedAt,
    source: options.source,
    offline: options.offline,
    scripts: [...identity.scripts],
    budgetUsd: options.budgetUsd,
    baselineFile: options.baselineFile,
    estimate: {
      turns: estimate.turns,
      promptCache: estimate.promptCache,
      inputTokens: estimate.inputTokens,
      cachedInputTokens: estimate.cachedInputTokens,
      cacheWriteTokens: estimate.cacheWriteTokens,
      outputTokens: estimate.outputTokens,
      usd: estimate.usd,
      totalUsd: estimate.totalUsd,
      uncachedTotalUsd: estimate.uncachedTotalUsd,
    },
    baseline: baseline
      ? {
          recordedAt: baseline.recordedAt,
          median: { ...baseline.median },
          spread: { ...baseline.spread },
        }
      : null,
    attempts: runs.map((run, index) => smokeAttempt(run, gates[index] ?? [])),
    verdict: failures.length === 0 ? "pass" : "fail",
    failures: failures.map((failure) => failure.message),
  };
  return { report, runs, failures };
}

export interface SmokeBaselineOptions
  extends Omit<SmokeRunOptions, "budgetUsd" | "perCallUsd" | "provider"> {
  readonly identity: SmokeIdentity;
  /** Each run's budget: the per-run EVAL_SMOKE_BUDGET_USD. */
  readonly budgetUsd: number;
  readonly estimate: SmokeEstimate;
  readonly source: string;
  /** `YYYY-MM-DD`. */
  readonly recordedAt: string;
  /** After each run: numbers only. */
  readonly onRun?: (run: SmokeRun, index: number) => void;
}

/**
 * Three runs and the baseline they make (spec WP11 step 5). Every run must complete within its
 * own budget; one that doesn't throws, and no baseline is made.
 */
export async function recordSmokeBaseline(
  options: SmokeBaselineOptions,
): Promise<{ baseline: SmokeBaseline; runs: SmokeRun[] }> {
  const provider: LlmProvider = options.identity.provider;
  const runs: SmokeRun[] = [];
  for (let index = 0; index < SMOKE_BASELINE_RUNS; index++) {
    const run = await runSmoke({
      ...options,
      provider,
      budgetUsd: options.budgetUsd,
      perCallUsd: options.estimate.perCallUsd,
    });
    runs.push(run);
    options.onRun?.(run, index);
    if (!run.complete) {
      throw new Error(
        `baseline run ${index + 1} of ${SMOKE_BASELINE_RUNS} is incomplete (${run.stop?.detail ?? "unanswered turns"}); no baseline was written`,
      );
    }
  }
  const summaries = runs.map((run) => smokeSummary(understandingMetrics(run.runs, LIVE_LABELS)));
  const { median, spread } = baselineRates(summaries);
  const { identity } = options;
  return {
    runs,
    baseline: {
      format: SMOKE_BASELINE_FORMAT,
      provider: identity.provider,
      model: identity.model,
      linker: identity.linker,
      scripts: [...identity.scripts],
      scriptsSha256: identity.scriptsSha256,
      recordedAt: options.recordedAt,
      source: options.source,
      runs: summaries,
      spentUsd: runs.map((run) => run.spentUsd),
      median,
      spread,
    },
  };
}
