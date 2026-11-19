// The eval's Playwright reporter: collects each eval run's result (the `eval-result` attachment
// capture-eval.spec.ts adds) and writes them as one report when the run ends, to
// EARSHOT_EVAL_REPORT (default apps/web/.data/eval/report.json), then prints its Markdown.
// Runs without eval tests write nothing. CI merges the shards' reports with
// `pnpm --filter @earshot/evals eval:report`, which also writes the job summary.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  EVAL_REPORT_VERSION,
  type EvalReport,
  EvalScriptResult,
  pairOf,
  reportMarkdown,
} from "@earshot/evals";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

const ATTACHMENT = "eval-result"; // support.ts's RESULT_ATTACHMENT

export default class EvalReporter implements Reporter {
  readonly #results = new Map<string, EvalScriptResult>();

  onTestEnd(_test: TestCase, result: TestResult): void {
    for (const attachment of result.attachments) {
      if (attachment.name !== ATTACHMENT || !attachment.body) continue;
      const parsed = EvalScriptResult.parse(JSON.parse(attachment.body.toString("utf8")));
      // A retry replaces the run before it.
      this.#results.set(`${parsed.script} ${pairOf(parsed)}`, parsed);
    }
  }

  onEnd(): void {
    if (this.#results.size === 0) return;
    const report: EvalReport = {
      version: EVAL_REPORT_VERSION,
      createdAt: new Date().toISOString(),
      results: [...this.#results.values()].sort((a, b) => a.script.localeCompare(b.script)),
    };
    const file = path.resolve(
      process.env.EARSHOT_EVAL_REPORT ??
        path.join(import.meta.dirname, "../../.data/eval/report.json"),
    );
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    const title = process.env.EARSHOT_EVAL_MODE === "live" ? "Live eval" : "Fake-mic eval";
    console.log(`\n${reportMarkdown(report, { title })}\nWrote ${file}`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
