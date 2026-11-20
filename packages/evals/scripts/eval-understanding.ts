// The understanding eval (Phase 4 WP10 steps 6 and 7; ADR-0031): all 200 debriefs through each
// LLM adapter's offline cassettes, linker v1, the normalizers, the faithfulness check, and the
// second witness, scored against the ground truth. $0 and deterministic: no model, no provider.
//
//   pnpm --filter @earshot/evals eval:understanding [--provider anthropic | groq | all] [--check]
//     [--summary ["$GITHUB_STEP_SUMMARY"]] [--json report.json] [--write-baseline]
//
// - `--check` exits 1 when, for either provider, a key metric or an expected risk kind's catch
//   rate falls more than 3 points below baselines/understanding.json, evidence coverage is under
//   100%, the end-to-end wrong-account rate is above 2%, a cassette misses, or the baseline was
//   recorded on other scripts or other seeded errors. CI's `checks` job runs `--check --summary`.
// - `--write-baseline` records both providers' numbers, on purpose. Review the diff, then commit.
// - `--summary` appends the report to a file, or to $GITHUB_STEP_SUMMARY when it names none.
import { writeFileSync } from "node:fs";
import type { LlmProvider } from "@earshot/core";
import { LINKER_PARAMS_V1 } from "@earshot/understanding/link";
import { EVAL_PROVIDERS } from "../src/generate";
import {
  ALL_DEBRIEFS,
  runScript,
  summarize,
  UNDERSTANDING_BASELINE_FORMAT,
  UnderstandingBaseline,
  type UnderstandingMetrics,
  understandingGateFailures,
  understandingMarkdown,
  understandingMetrics,
} from "../src/understanding";
import { appendSummary, flag, parseArgs, userPath } from "./args";
import {
  BASELINE_FILE,
  errorsSha256,
  readBaseline,
  readErrorLabels,
  readUnderstandingCassettes,
  scriptsSha256,
} from "./understanding-io";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["check", "write-baseline"], ["summary"]);
  const chosen = flag(args, "provider") ?? "all";
  const providers: LlmProvider[] =
    chosen === "all"
      ? [...EVAL_PROVIDERS]
      : EVAL_PROVIDERS.filter((provider) => provider === chosen);
  if (providers.length === 0) throw new Error(`--provider is anthropic, groq, or all`);
  const started = performance.now();
  const labels = readErrorLabels();
  const cassettes = readUnderstandingCassettes();
  const metrics: Partial<Record<LlmProvider, UnderstandingMetrics>> = {};
  for (const provider of providers) {
    const runs = [];
    for (const script of ALL_DEBRIEFS) {
      const cassette = cassettes[provider].cassettes[script.id];
      if (!cassette) throw new Error(`no ${provider} understanding cassette for ${script.id}`);
      runs.push(await runScript(provider, script, cassette, labels));
    }
    metrics[provider] = understandingMetrics(runs, labels);
  }
  const shaScripts = scriptsSha256();
  const shaErrors = errorsSha256();

  if (args.flags.has("write-baseline")) {
    if (providers.length !== EVAL_PROVIDERS.length)
      throw new Error("the baseline needs both providers");
    const baseline = UnderstandingBaseline.parse({
      format: UNDERSTANDING_BASELINE_FORMAT,
      scriptsSha256: shaScripts,
      errorsSha256: shaErrors,
      linker: LINKER_PARAMS_V1.version,
      recordedAt: new Date().toISOString().slice(0, 10),
      providers: Object.fromEntries(
        EVAL_PROVIDERS.map((provider) => [
          provider,
          summarize(metrics[provider] as UnderstandingMetrics),
        ]),
      ),
    });
    writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(
      "Wrote packages/evals/baselines/understanding.json. Review the diff, then commit it.",
    );
  }

  const baseline = readBaseline();
  const failures: Record<string, string[]> = {};
  for (const provider of providers) {
    const found = metrics[provider] as UnderstandingMetrics;
    const stale: string[] = [];
    if (baseline === null)
      stale.push(`${provider}: no baselines/understanding.json; record one with --write-baseline`);
    else if (baseline.scriptsSha256 !== shaScripts || baseline.errorsSha256 !== shaErrors) {
      stale.push(
        `${provider}: regression: baselines/understanding.json was recorded on other scripts or seeded errors; re-record it on purpose (--write-baseline) and review the diff`,
      );
    }
    failures[provider] = [
      ...stale,
      ...understandingGateFailures(
        provider,
        found,
        baseline?.providers[provider as "anthropic" | "groq"] ?? null,
      ),
    ];
  }
  const elapsed = Math.round(performance.now() - started);
  const markdown = `${understandingMarkdown(metrics as Record<string, UnderstandingMetrics>, { failures })}\n\nRan in ${elapsed} ms.`;
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
