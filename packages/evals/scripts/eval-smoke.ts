// The live smoke eval (Phase 4 WP11; gates G2c and G3b; ADR-0031): smoke.json's 30 debriefs as
// text through a live model (Claude Haiku 5.5 by default), the understanding pipeline, and the
// second witness, then each one's recap (Phase 5 WP10; ADR-0037), gated against
// baselines/smoke-<provider>.json. It spends money, so:
//
// - it estimates the run first and refuses to start above the budget (EVAL_SMOKE_BUDGET_USD);
// - it stops past the budget mid-run, and fails as incomplete;
// - it paces requests at 60 a minute at most, after a slow start;
// - it reads the key from EVAL_SMOKE_ANTHROPIC_KEY (or EVAL_SMOKE_GROQ_KEY), and prints numbers
//   only: never the key, a prompt, a transcript, or anything the model wrote.
//
//   pnpm --filter @earshot/evals eval:smoke --budget 0.10 [--provider anthropic] [--check]
//     [--estimate] [--offline] [--no-cache] [--scripts d033,d048] [--rpm 60]
//     [--summary ["$GITHUB_STEP_SUMMARY"]] [--out <dir>]
//
// - `--estimate` stops after the estimate: no key, no call, $0.
// - `--offline` runs the whole flow against the $0 understanding and recap cassettes instead of a
//   model, to check the plumbing; it can't pass the gate, which needs a live baseline.
// - `--check` exits 1 unless the gate passes (CI runs it).
// - `--out` writes smoke-report.json and smoke-report.md there (CI uploads them).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findLlmPrice, LLM_MODELS, LLM_PRICES } from "@earshot/agent";
import { createCassetteFetch, SCENARIO_API_KEY } from "@earshot/agent/testing";
import {
  createPacer,
  estimateSmokeSpend,
  parseSmokeBudget,
  SMOKE_PACE,
  smokeDetailsMarkdown,
  smokeEstimateMarkdown,
  smokeEval,
  smokeMarkdown,
} from "../src/smoke";
import { appendSummary, flag, parseArgs, userPath } from "./args";
import { readRecapCassettes } from "./recap-io";
import {
  chosenScripts,
  parseProvider,
  readSmokeBaseline,
  runSource,
  smokeBaselinePath,
  smokeIdentity,
  smokeKey,
} from "./smoke-io";
import { readUnderstandingCassettes } from "./understanding-io";

// The AI SDK's warnings go to the console; nothing it would say belongs in a CI log.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const usd = (amount: number) => `$${amount.toFixed(4)}`;

async function main(): Promise<void> {
  const args = parseArgs(
    process.argv.slice(2),
    ["check", "estimate", "offline", "no-cache"],
    ["summary"],
  );
  const offline = args.flags.has("offline");
  if (offline && args.flags.has("check")) {
    throw new Error("--offline runs check the plumbing, not the model: they can't take --check");
  }
  const provider = parseProvider(
    flag(args, "provider") || process.env.EVAL_SMOKE_PROVIDER || "anthropic",
  );
  const budgetUsd = parseSmokeBudget(flag(args, "budget") ?? process.env.EVAL_SMOKE_BUDGET_USD);
  const scripts = chosenScripts(flag(args, "scripts"));
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
  // The estimate is a live run's, offline too. The cassettes were recorded without cache
  // markers, so an offline run sends none.
  const cachePlan = provider === "anthropic" && !args.flags.has("no-cache");
  const promptCache = cachePlan && !offline;
  const estimate = estimateSmokeSpend(scripts, price, { promptCache: cachePlan });
  const estimateMd = smokeEstimateMarkdown(estimate, budgetUsd, `${provider}/${model}`);
  console.log(estimateMd);
  appendSummary(summaryFile, estimateMd);
  if (estimate.totalUsd > budgetUsd) {
    throw new Error(
      `The estimate, ${usd(estimate.totalUsd)}, is over EVAL_SMOKE_BUDGET_USD (${usd(budgetUsd)}). Run fewer scripts, or raise the budget.`,
    );
  }
  if (args.flags.has("estimate")) return;

  const rpm = Number(flag(args, "rpm") ?? SMOKE_PACE.maxPerMinute);
  if (!Number.isFinite(rpm) || rpm <= 0 || rpm > SMOKE_PACE.maxPerMinute) {
    throw new Error(`--rpm is between 1 and ${SMOKE_PACE.maxPerMinute}`);
  }
  let fetchFor: (script: (typeof scripts)[number]) => typeof globalThis.fetch;
  let recapFetchFor: ((script: (typeof scripts)[number]) => typeof globalThis.fetch) | undefined;
  let apiKey: string;
  let pacer: ReturnType<typeof createPacer>;
  if (offline) {
    const cassettes = readUnderstandingCassettes()[provider];
    fetchFor = (script) => {
      const cassette = cassettes.cassettes[script.id];
      if (!cassette) throw new Error(`no ${provider} understanding cassette for ${script.id}`);
      return createCassetteFetch(cassette) as typeof globalThis.fetch;
    };
    // The recap's request is the recap eval's, so its committed cassettes answer it.
    const recaps = readRecapCassettes()[provider];
    recapFetchFor = (script) => {
      const cassette = recaps.cassettes[script.id];
      if (!cassette) throw new Error(`no ${provider} recap cassette for ${script.id}`);
      return createCassetteFetch(cassette) as typeof globalThis.fetch;
    };
    apiKey = SCENARIO_API_KEY;
    // Paced on a virtual clock: the same code path, without the waits.
    let clock = 0;
    pacer = createPacer({
      maxPerMinute: rpm,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
  } else {
    fetchFor = () => globalThis.fetch;
    apiKey = smokeKey(provider);
    pacer = createPacer({
      maxPerMinute: rpm,
      startPerMinute: Math.min(rpm, SMOKE_PACE.startPerMinute),
    });
  }

  const identity = smokeIdentity(provider, scripts);
  const baselineFile = smokeBaselinePath(provider);
  const baseline = offline ? null : readSmokeBaseline(provider);
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => controller.abort(new DOMException("cancelled", "AbortError")));
  }
  const startedAt = new Date().toISOString();
  const { report, runs } = await smokeEval({
    identity,
    scripts,
    apiKey,
    fetchFor,
    ...(recapFetchFor ? { recapFetchFor } : {}),
    budgetUsd,
    estimate,
    promptCache,
    pacer,
    baseline,
    baselineFile,
    offline,
    source: runSource(),
    startedAt,
    signal: controller.signal,
    onScript: (progress) =>
      console.log(
        `${progress.script}: ${progress.turns} turns (${progress.done} of ${progress.of}); ${usd(progress.spentUsd)} of ${usd(progress.budgetUsd)} spent`,
      ),
  });
  const details = smokeDetailsMarkdown(runs[runs.length - 1] as (typeof runs)[number], offline);
  const markdown = [
    smokeMarkdown(report, baseline),
    ...(details
      ? ["", "<details><summary>Every metric</summary>", "", details, "", "</details>"]
      : []),
  ].join("\n");
  console.log(`\n${markdown}`);
  appendSummary(summaryFile, markdown);
  const out = flag(args, "out");
  if (out) {
    const dir = userPath(out);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "smoke-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(path.join(dir, "smoke-report.md"), `${markdown}\n`);
  }
  if (args.flags.has("check") && report.verdict !== "pass") process.exit(1);
}

main().catch((error: unknown) => {
  // The message only: errors here carry fixed codes, and a stack is no use in a CI log.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
