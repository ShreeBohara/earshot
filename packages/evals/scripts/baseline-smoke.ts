// Records the live smoke eval's baseline (Phase 4 WP11 step 5; ADR-0031): three runs of
// smoke.json's debriefs on the live model, each with its recaps (Phase 5 WP10), each within its own
// EVAL_SMOKE_BUDGET_USD, and their median and spread per gated metric, the recap drop rate's
// included, written to baselines/smoke-<provider>.json. It spends
// money: about three times one run's estimate, which it prints before it starts. Run it only
// with the user's approval (spec §9), then review the file and commit it.
//
//   pnpm --filter @earshot/evals baseline:smoke --budget 0.10 [--provider anthropic]
//     [--no-cache] [--rpm 60] [--summary ["$GITHUB_STEP_SUMMARY"]] [--out <file>]
//
// `--out` writes the baseline somewhere else (CI uploads it as an artifact to review). Every run
// must complete; if one doesn't, nothing is written.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findLlmPrice, LLM_MODELS, LLM_PRICES } from "@earshot/agent";
import {
  createPacer,
  estimateSmokeSpend,
  parseSmokeBudget,
  recordSmokeBaseline,
  SMOKE_BASELINE_RUNS,
  SMOKE_GATED_METRICS,
  SMOKE_PACE,
  SmokeBaseline,
  smokeEstimateMarkdown,
} from "../src/smoke";
import { appendSummary, flag, parseArgs, userPath } from "./args";
import {
  chosenScripts,
  parseProvider,
  runSource,
  smokeBaselinePath,
  smokeBaselineUrl,
  smokeIdentity,
  smokeKey,
} from "./smoke-io";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const usd = (amount: number) => `$${amount.toFixed(4)}`;
const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["no-cache"], ["summary"]);
  const provider = parseProvider(
    flag(args, "provider") || process.env.EVAL_SMOKE_PROVIDER || "anthropic",
  );
  const budgetUsd = parseSmokeBudget(flag(args, "budget") ?? process.env.EVAL_SMOKE_BUDGET_USD);
  // A baseline covers the whole set: the gate compares runs of smoke.json with it.
  const scripts = chosenScripts(undefined);
  const summaryFlag = args.flags.get("summary");
  const summaryFile =
    typeof summaryFlag === "string"
      ? summaryFlag
      : summaryFlag
        ? process.env.GITHUB_STEP_SUMMARY
        : undefined;
  const model = LLM_MODELS[provider];
  const price = findLlmPrice(LLM_PRICES, provider, model);
  if (!price) throw new Error(`no price for ${provider}/${model} in the ${LLM_PRICES.date} table`);
  const promptCache = provider === "anthropic" && !args.flags.has("no-cache");
  const estimate = estimateSmokeSpend(scripts, price, { promptCache });
  const estimateMd = [
    smokeEstimateMarkdown(
      estimate,
      budgetUsd,
      `Baseline, ${SMOKE_BASELINE_RUNS} runs of ${provider}/${model}`,
    ),
    "",
    `${SMOKE_BASELINE_RUNS} runs, each within the budget: at most ${usd(SMOKE_BASELINE_RUNS * estimate.totalUsd)} estimated in all.`,
  ].join("\n");
  console.log(estimateMd);
  appendSummary(summaryFile, estimateMd);
  if (estimate.totalUsd > budgetUsd) {
    throw new Error(
      `One run's estimate, ${usd(estimate.totalUsd)}, is over EVAL_SMOKE_BUDGET_USD (${usd(budgetUsd)}); raise the budget to record a baseline.`,
    );
  }
  const rpm = Number(flag(args, "rpm") ?? SMOKE_PACE.maxPerMinute);
  if (!Number.isFinite(rpm) || rpm <= 0 || rpm > SMOKE_PACE.maxPerMinute) {
    throw new Error(`--rpm is between 1 and ${SMOKE_PACE.maxPerMinute}`);
  }
  const apiKey = smokeKey(provider);
  const identity = smokeIdentity(provider, scripts);
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => controller.abort(new DOMException("cancelled", "AbortError")));
  }
  const { baseline } = await recordSmokeBaseline({
    identity,
    scripts,
    apiKey,
    fetchFor: () => globalThis.fetch,
    budgetUsd,
    estimate,
    promptCache,
    // One pacer for all three runs, so the limit holds across them.
    pacer: createPacer({
      maxPerMinute: rpm,
      startPerMinute: Math.min(rpm, SMOKE_PACE.startPerMinute),
    }),
    source: runSource(),
    recordedAt: new Date().toISOString().slice(0, 10),
    signal: controller.signal,
    onRun: (run, index) =>
      console.log(
        `Run ${index + 1} of ${SMOKE_BASELINE_RUNS}: ${run.complete ? "complete" : `incomplete (${run.stop?.detail ?? "unanswered turns"})`}, ${usd(run.spentUsd)} over ${run.calls} calls`,
      ),
  });
  SmokeBaseline.parse(baseline);
  const target = flag(args, "out");
  const file = target ? userPath(target) : smokeBaselineUrl(provider);
  if (typeof file === "string") mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
  const markdown = [
    `### Live smoke baseline: ${provider}/${model}`,
    "",
    `${SMOKE_BASELINE_RUNS} runs over ${scripts.length} debriefs, ${usd(baseline.spentUsd.reduce((a, b) => a + b, 0))} in all. Wrote ${target ?? smokeBaselinePath(provider)}: review it, then commit it.`,
    "",
    "| Metric | Median | Spread | Runs |",
    "|---|---|---|---|",
    ...SMOKE_GATED_METRICS.map(
      (name) =>
        `| ${name} | ${pct(baseline.median[name])} | ${pct(baseline.spread[name])} | ${baseline.runs.map((run) => pct(run[name])).join(", ")} |`,
    ),
    `| recapDropRate | ${pct(baseline.recapMedian.dropRate)} | ${pct(baseline.recapSpread.dropRate)} | ${baseline.recapRuns.map((run) => pct(run.dropRate)).join(", ")} |`,
  ].join("\n");
  console.log(`\n${markdown}`);
  appendSummary(summaryFile, markdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
