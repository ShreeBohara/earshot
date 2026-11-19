// The live eval's budget guard (spec WP11 step 8): estimates the run's spend from the rendered
// fixtures' durations, the price table, and the provider pairs, and exits 1 above the budget, so
// `eval-live` never starts a run it can't afford.
//
//   pnpm --filter @earshot/evals eval:budget --manifest lab/.cache/wavs/manifest.json
//     --budget "$EVAL_LIVE_BUDGET_USD" [--pairs "$EVAL_LIVE_PAIRS"] [--scripts d001,d002]
//     [--summary "$GITHUB_STEP_SUMMARY"]
import { readFileSync } from "node:fs";
import { DEBRIEFS } from "../src/debriefs";
import { estimateLiveSpend, pairName, parseBudget, parsePairs } from "../src/live";
import { isStubRender, RenderManifest } from "../src/timing";
import { appendSummary, flag, parseArgs, run, userPath } from "./args";

const usd = (amount: number) => `$${amount.toFixed(4)}`;

run(() => {
  const args = parseArgs(process.argv.slice(2));
  const manifestFile = flag(args, "manifest");
  if (!manifestFile) throw new Error("--manifest is required");
  const budget = parseBudget(flag(args, "budget"));
  const pairs = parsePairs(flag(args, "pairs"));
  const manifest = RenderManifest.parse(JSON.parse(readFileSync(userPath(manifestFile), "utf8")));
  if (isStubRender(manifest)) {
    throw new Error("the manifest is --stub tones; a live run needs speech");
  }
  // Empty means every script, as EARSHOT_EVAL_SCRIPTS does.
  const named = (flag(args, "scripts") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const only = named.length > 0 ? named : undefined;
  const fixtures = DEBRIEFS.filter((script) => !only || only.includes(script.id)).map((script) => {
    const entry = manifest.scripts[script.id];
    if (!entry) throw new Error(`the manifest has no WAV for ${script.id}`);
    return { script: script.id, durationMs: entry.durationMs, turns: script.turns.length };
  });
  if (fixtures.length === 0) throw new Error("no scripts to run");

  const estimate = estimateLiveSpend(fixtures, pairs);
  const audioMinutes = fixtures.reduce((sum, fixture) => sum + fixture.durationMs, 0) / 60_000;
  const over = estimate.totalUsd > budget;
  const markdown = [
    `### Live eval budget: ${over ? "over budget, not starting" : "within budget"}`,
    "",
    `${fixtures.length} scripts (${audioMinutes.toFixed(1)} min of audio) on ${pairs.length} pairs. Estimated at most ${usd(estimate.totalUsd)} against a budget of ${usd(budget)} (the price table, plus a quarter).`,
    "",
    "| Pair | Speech-to-text | LLM | Total |",
    "|---|---|---|---|",
    ...estimate.pairs.map(
      (entry) =>
        `| ${pairName(entry.pair)} | ${usd(entry.sttUsd)} | ${usd(entry.llmUsd)} | ${usd(entry.totalUsd)} |`,
    ),
    "",
  ].join("\n");
  console.log(markdown);
  appendSummary(flag(args, "summary"), markdown);
  if (over) {
    throw new Error(
      `The estimate, ${usd(estimate.totalUsd)}, is over EVAL_LIVE_BUDGET_USD (${usd(budget)}). Run fewer scripts or pairs, or raise the budget.`,
    );
  }
});
