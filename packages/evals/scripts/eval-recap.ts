// The recap eval (Phase 5 WP10 step 6; ADR-0037): all 200 debriefs' recaps through each LLM
// adapter's offline cassettes, `runRecap`, and the checks in code, scored against the seeded
// labels. $0 and deterministic: no model, no provider.
//
//   pnpm --filter @earshot/evals eval:recap [--provider anthropic | groq | all] [--check]
//     [--summary ["$GITHUB_STEP_SUMMARY"]] [--json report.json] [--write-baseline]
//
// - `--check` exits 1 unless, for both providers, every kept sentence carries evidence, every
//   seeded bad sentence was dropped, every recap has a headline, every ground-truth sentence was
//   kept, every invented lens quote came back "not mentioned", no request missed its cassette, and
//   the weak-support share is within 3 points of baselines/recap.json, recorded on these scripts
//   and labels. CI's `checks` job runs `--check --summary`.
// - `--write-baseline` records both providers' numbers, on purpose. Review the diff, then commit.
import { writeFileSync } from "node:fs";
import type { LlmProvider } from "@earshot/core";
import { EVAL_PROVIDERS } from "../src/generate";
import {
  RECAP_BASELINE_FORMAT,
  RecapBaseline,
  type RecapMetrics,
  recapGateFailures,
  recapMarkdown,
  recapMetrics,
  runRecapScript,
  summarizeRecap,
} from "../src/recap";
import { ALL_DEBRIEFS } from "../src/understanding";
import { appendSummary, flag, parseArgs, userPath } from "./args";
import {
  RECAP_BASELINE_FILE,
  readRecapBaseline,
  readRecapCassettes,
  readRecapLabels,
  recapLabelsSha256,
} from "./recap-io";
import { scriptsSha256 } from "./understanding-io";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["check", "write-baseline"], ["summary"]);
  const chosen = flag(args, "provider") ?? "all";
  const providers: LlmProvider[] =
    chosen === "all"
      ? [...EVAL_PROVIDERS]
      : EVAL_PROVIDERS.filter((provider) => provider === chosen);
  if (providers.length === 0) throw new Error("--provider is anthropic, groq, or all");
  const started = performance.now();
  const labels = readRecapLabels();
  const cassettes = readRecapCassettes();
  const metrics: Partial<Record<LlmProvider, RecapMetrics>> = {};
  for (const provider of providers) {
    const runs = [];
    for (const script of ALL_DEBRIEFS) {
      const cassette = cassettes[provider].cassettes[script.id];
      if (!cassette) throw new Error(`no ${provider} recap cassette for ${script.id}`);
      runs.push(await runRecapScript(provider, script, cassette));
    }
    metrics[provider] = recapMetrics(runs, ALL_DEBRIEFS, labels);
  }
  const shaScripts = scriptsSha256();
  const shaLabels = recapLabelsSha256();

  if (args.flags.has("write-baseline")) {
    if (providers.length !== EVAL_PROVIDERS.length)
      throw new Error("the baseline needs both providers");
    const baseline = RecapBaseline.parse({
      format: RECAP_BASELINE_FORMAT,
      scriptsSha256: shaScripts,
      labelsSha256: shaLabels,
      recordedAt: new Date().toISOString().slice(0, 10),
      providers: Object.fromEntries(
        EVAL_PROVIDERS.map((provider) => [
          provider,
          summarizeRecap(metrics[provider] as RecapMetrics),
        ]),
      ),
    });
    writeFileSync(RECAP_BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log("Wrote packages/evals/baselines/recap.json. Review the diff, then commit it.");
  }

  const baseline = readRecapBaseline();
  const failures: Record<string, string[]> = {};
  for (const provider of providers) {
    const stale: string[] = [];
    if (baseline === null) {
      stale.push(`${provider}: no baselines/recap.json; record one with --write-baseline`);
    } else if (baseline.scriptsSha256 !== shaScripts || baseline.labelsSha256 !== shaLabels) {
      stale.push(
        `${provider}: regression: baselines/recap.json was recorded on other scripts or labels; re-record it on purpose (--write-baseline) and review the diff`,
      );
    }
    failures[provider] = [
      ...stale,
      ...recapGateFailures(
        provider,
        metrics[provider] as RecapMetrics,
        baseline?.providers[provider] ?? null,
      ),
    ];
  }
  const elapsed = Math.round(performance.now() - started);
  const markdown = `${recapMarkdown(metrics as Record<string, RecapMetrics>, { failures })}\n\nRan in ${elapsed} ms.`;
  console.log(markdown);
  const summary = args.flags.get("summary");
  appendSummary(
    typeof summary === "string" ? summary : summary ? process.env.GITHUB_STEP_SUMMARY : undefined,
    markdown,
  );
  const out = flag(args, "json");
  if (out) writeFileSync(userPath(out), `${JSON.stringify(metrics, null, 2)}\n`);
  const failed = Object.values(failures).some((list) => list.length > 0);
  if (args.flags.has("check") && failed) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
