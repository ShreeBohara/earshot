// The live smoke eval's report (Phase 4 WP11 step 3): JSON for the artifact, Markdown for the job
// summary. Both hold numbers, script ids, and fixed codes only. No prompt, transcript, quote, or
// model output goes in, so the artifact and the summary are safe to show on a public repository.
import { LlmProvider, TurnOutcome } from "@earshot/core";
import { z } from "zod";
import { understandingMetrics } from "../understanding/metrics";
import { understandingMarkdown } from "../understanding/report";
import type { SmokeEstimate } from "./budget";
import {
  allowedDrop,
  SMOKE_GATE,
  SMOKE_GATED_METRICS,
  type SmokeBaseline,
  type SmokeFailure,
  type SmokeGatedMetric,
  SmokeSummary,
  smokeSummary,
} from "./gate";
import { LIVE_LABELS, type SmokeRun, scoredRuns } from "./run";

export const SMOKE_REPORT_VERSION = 1;

const Count = z.int().nonnegative();
const Usd = z.number().nonnegative();
const Tally = z.strictObject({ n: Count, of: Count });

const Usage = z.strictObject({
  inputTokens: Count,
  cachedInputTokens: Count,
  cacheWriteTokens: Count,
  outputTokens: Count,
  reasoningTokens: Count,
});

/** One script's numbers in one attempt. */
const ScriptResult = z.strictObject({
  id: z.string().regex(/^d\d{3}$/),
  turns: Count,
  /** Every turn was answered, so the script counts in the metrics. */
  scored: z.boolean(),
  expected: Count,
  actual: Count,
  matched: Count,
  targets: Tally,
  keyFields: Tally,
});

const Attempt = z.strictObject({
  complete: z.boolean(),
  stop: z
    .strictObject({ reason: z.enum(["budget", "provider", "aborted"]), detail: z.string() })
    .nullable(),
  budgetUsd: Usd,
  spentUsd: Usd,
  usage: Usage,
  calls: Count,
  estimatedCalls: Count,
  requests: Count,
  outcomes: z.partialRecord(TurnOutcome, Count),
  failures: z.record(z.string(), Count),
  durationMs: Count,
  /** The scored scripts' numbers; null when none could be scored. */
  summary: SmokeSummary.nullable(),
  scripts: z.array(ScriptResult),
  gate: z.array(z.strictObject({ kind: z.string(), message: z.string() })),
});
export type SmokeAttempt = z.infer<typeof Attempt>;

export const SmokeReport = z.strictObject({
  version: z.literal(SMOKE_REPORT_VERSION),
  provider: LlmProvider,
  model: z.string(),
  linker: z.string(),
  startedAt: z.iso.datetime(),
  /** A commit and CI run, or "local". */
  source: z.string(),
  /** Whether it ran against the offline cassettes (a $0 plumbing run) instead of a live model. */
  offline: z.boolean(),
  scripts: z.array(z.string()),
  budgetUsd: Usd,
  /** The baseline the gate compares with, whether or not it exists yet. */
  baselineFile: z.string(),
  estimate: z.strictObject({
    turns: Count,
    promptCache: z.boolean(),
    inputTokens: Count,
    cachedInputTokens: Count,
    cacheWriteTokens: Count,
    outputTokens: Count,
    usd: Usd,
    totalUsd: Usd,
    uncachedTotalUsd: Usd,
  }),
  baseline: z
    .strictObject({
      recordedAt: z.string(),
      median: z.record(z.string(), z.number().nullable()),
      spread: z.record(z.string(), z.number().nullable()),
    })
    .nullable(),
  attempts: z.array(Attempt).min(1).max(2),
  verdict: z.enum(["pass", "fail"]),
  /** The last attempt's failures, which decide the verdict. */
  failures: z.array(z.string()),
});
export type SmokeReport = z.infer<typeof SmokeReport>;

/** One attempt's report entry: the run's numbers, its scripts', and its gate failures. */
export function smokeAttempt(run: SmokeRun, gate: readonly SmokeFailure[]): SmokeAttempt {
  const scored = new Set(scoredRuns(run).map((script) => script.script.id));
  const metrics = scored.size === 0 ? null : understandingMetrics(scoredRuns(run), LIVE_LABELS);
  return {
    complete: run.complete,
    stop: run.stop ? { ...run.stop } : null,
    budgetUsd: run.budgetUsd,
    spentUsd: run.spentUsd,
    usage: { ...run.usage },
    calls: run.calls,
    estimatedCalls: run.estimatedCalls,
    requests: run.requests,
    outcomes: { ...run.outcomes },
    failures: { ...run.failures },
    durationMs: run.durationMs,
    summary: metrics === null ? null : smokeSummary(metrics),
    scripts: run.runs.map((script) => {
      const m = understandingMetrics([script], LIVE_LABELS);
      return {
        id: script.script.id,
        turns: script.turns.length,
        scored: scored.has(script.script.id),
        expected: m.proposals.expected,
        actual: m.proposals.actual,
        matched: m.proposals.matched,
        targets: { n: m.targets.n, of: m.targets.of },
        keyFields: { n: m.keyFields.n, of: m.keyFields.of },
      };
    }),
    gate: gate.map((failure) => ({ kind: failure.kind, message: failure.message })),
  };
}

const usd = (amount: number) => `$${amount.toFixed(4)}`;
const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
const pts = (value: number | null | undefined) =>
  value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)} pts`;
const n = (value: number) => value.toLocaleString("en-US");

const LABELS: Readonly<Record<SmokeGatedMetric, string>> = {
  keyFieldAccuracy: "Key-field accuracy",
  targetAccuracy: "Target accuracy",
  proposalF1: "Proposal F1",
};

/** The estimate as Markdown, for the budget step's summary. */
export function smokeEstimateMarkdown(
  estimate: SmokeEstimate,
  budgetUsd: number,
  label: string,
): string {
  const over = estimate.totalUsd > budgetUsd;
  return [
    `### Live smoke eval budget: ${over ? "over budget, not starting" : "within budget"}`,
    "",
    `${label}: ${estimate.scripts} debriefs, ${estimate.turns} requests. Estimated at ${usd(estimate.totalUsd)}, the price table plus a quarter${estimate.promptCache ? ", with the prompt cache" : ""}, against a budget of ${usd(budgetUsd)} (EVAL_SMOKE_BUDGET_USD).${estimate.promptCache ? ` With no cache hit at all it would be ${usd(estimate.uncachedTotalUsd)}; the in-run guard stops the run if it passes the budget.` : ""}`,
    "",
    `Estimated tokens: ${n(estimate.inputTokens)} in (${n(estimate.cachedInputTokens)} cache reads, ${n(estimate.cacheWriteTokens)} cache writes), ${n(estimate.outputTokens)} out.`,
  ].join("\n");
}

/** The report as Markdown, for the job summary. */
export function smokeMarkdown(report: SmokeReport, baseline: SmokeBaseline | null): string {
  const last = report.attempts[report.attempts.length - 1] as SmokeAttempt;
  const verdict = report.verdict === "pass" ? "passes" : "fails";
  const lines = [
    `## Live smoke eval: ${report.provider}/${report.model} ${verdict}${report.offline ? " (offline cassettes, not a live model)" : ""}`,
    "",
    `${report.scripts.length} debriefs as text through ${report.offline ? "the offline cassettes" : "the live model"}, ${report.linker}, the normalizers, and the second witness (smoke.json).`,
    "",
  ];
  report.attempts.forEach((attempt, index) => {
    const name = report.attempts.length > 1 ? `Run ${index + 1}` : "The run";
    const status = attempt.complete
      ? `complete, ${attempt.gate.length === 0 ? "passing" : "failing"}`
      : `incomplete (${attempt.stop?.detail ?? "unanswered turns"})`;
    lines.push(
      `**${name}:** ${status}. Spent ${usd(attempt.spentUsd)} of ${usd(attempt.budgetUsd)} over ${n(attempt.calls)} calls and ${n(attempt.requests)} requests${attempt.estimatedCalls > 0 ? ` (${attempt.estimatedCalls} charged at the estimate)` : ""}, in ${(attempt.durationMs / 1000).toFixed(0)} s. Tokens: ${n(attempt.usage.inputTokens)} in (${n(attempt.usage.cachedInputTokens)} cache reads, ${n(attempt.usage.cacheWriteTokens)} cache writes), ${n(attempt.usage.outputTokens)} out.`,
      "",
    );
  });
  lines.push(
    `Estimated beforehand at ${usd(report.estimate.totalUsd)} with the margin${report.estimate.promptCache ? ` (no cache hits: ${usd(report.estimate.uncachedTotalUsd)})` : ""}.`,
  );
  if (report.estimate.promptCache && !report.offline && last.calls > 1) {
    if (last.usage.cachedInputTokens === 0) {
      lines.push(
        "",
        "**The prompt cache didn't take: no call read from it.** The next run may meet the budget.",
      );
    }
  }
  lines.push("", "### The gate", "");
  const summary = last.summary;
  if (baseline === null) {
    lines.push(
      `No baseline: ${report.baselineFile} hasn't been recorded${report.offline ? ", and an offline run is never compared with one" : ""}.`,
      "",
    );
  } else {
    lines.push(
      `Against ${report.baselineFile}, recorded ${baseline.recordedAt} over ${baseline.runs.length} runs (${baseline.source}).`,
      "",
    );
  }
  lines.push(
    "| Metric | Baseline median | Spread | Allowed drop | This run |",
    "|---|---|---|---|---|",
  );
  for (const name of SMOKE_GATED_METRICS) {
    const now = summary?.[name] ?? null;
    lines.push(
      `| ${LABELS[name]} | ${pct(baseline?.median[name])} | ${pts(baseline?.spread[name])} | ${baseline ? pts(allowedDrop(baseline.spread[name])) : "n/a"} | ${pct(now)} |`,
    );
  }
  lines.push(
    `| Evidence coverage (G2c) | 100% required | | | ${pct(summary?.evidenceCoverage)} |`,
    `| End-to-end wrong-account rate | at most ${pct(SMOKE_GATE.maxWrongAccountRate)} | | | ${pct(summary?.wrongAccountRate)} (${summary?.decided ?? 0} decided) |`,
    "",
  );
  if (report.attempts.length > 1) {
    lines.push(
      "Run 1 failed only on checks live sampling can trip by chance, and the budget covered one re-run (spec §8). The verdict is run 2's.",
      "",
    );
  }
  if (report.failures.length === 0) lines.push("**Passes.**");
  else lines.push(...report.failures.map((failure) => `- **${failure}**`));
  const scored = report.attempts.flatMap((attempt) => (attempt.summary ? [attempt] : []));
  if (scored.length > 0) {
    lines.push(
      "",
      "### Scripts",
      "",
      "| Script | Turns | Proposals matched | Targets right | Key fields right |",
      "|---|---|---|---|---|",
    );
    for (const script of last.scripts) {
      lines.push(
        `| ${script.id}${script.scored ? "" : " (not scored)"} | ${script.turns} | ${script.matched} of ${script.expected} (${script.actual} made) | ${script.targets.n} of ${script.targets.of} | ${script.keyFields.n} of ${script.keyFields.of} |`,
      );
    }
  }
  return lines.join("\n");
}

/** Every metric for the run, in the understanding report's layout, for the summary's details. */
export function smokeDetailsMarkdown(run: SmokeRun, offline: boolean): string | null {
  const runs = scoredRuns(run);
  if (runs.length === 0) return null;
  const metrics = understandingMetrics(runs, LIVE_LABELS);
  return understandingMarkdown(
    { [run.provider]: metrics },
    {
      title: "Every metric",
      ran: offline
        ? "through the offline cassettes, linker v1, the normalizers, and the second witness."
        : `through ${run.provider}/${run.model} live, linker v1, the normalizers, and the second witness.`,
      seeded: false,
      evidenceGate: "G2c",
    },
  );
}
