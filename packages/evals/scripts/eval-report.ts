// Merges the fake-microphone eval's reports (one per Playwright run or CI shard) and writes the
// result as Markdown, for the job summary, and as one JSON report, for the artifact:
//
//   pnpm --filter @earshot/evals eval:report <report.json>... [--out merged.json]
//     [--summary "$GITHUB_STEP_SUMMARY"] [--baseline packages/evals/baselines/ci.json]
//     [--title "Fake-mic eval"] [--expect all | d001,d010] [--check]
//
// `--check` exits 1 unless every expected script ran and went as scripted; CI's eval job uses it
// so a shard that ran nothing can't pass. A missing baseline file is fine: the summary says so.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEBRIEFS } from "../src/debriefs";
import { EvalBaseline, mergeReports, reportMarkdown, scriptPassed } from "../src/report";
import { appendSummary, flag, parseArgs, readReport, run, userPath } from "./args";

run(() => {
  const args = parseArgs(process.argv.slice(2), ["check"]);
  if (args.positionals.length === 0) throw new Error("name at least one report file");
  const merged = mergeReports(args.positionals.map(readReport), new Date().toISOString());

  const baselineFile = flag(args, "baseline");
  const baseline =
    baselineFile && existsSync(userPath(baselineFile))
      ? EvalBaseline.parse(JSON.parse(readFileSync(userPath(baselineFile), "utf8")))
      : null;
  const markdown = reportMarkdown(merged, {
    title: flag(args, "title") ?? "Fake-mic eval",
    baseline,
  });
  console.log(markdown);
  appendSummary(flag(args, "summary"), markdown);
  const out = flag(args, "out");
  if (out) writeFileSync(userPath(out), `${JSON.stringify(merged, null, 2)}\n`);

  const expect = flag(args, "expect");
  const wanted =
    expect === undefined
      ? []
      : expect === "all"
        ? DEBRIEFS.map((script) => script.id)
        : expect.split(",").map((id) => id.trim());
  const ran = new Set(merged.results.map((result) => result.script));
  const missing = wanted.filter((id) => !ran.has(id));
  const failed = merged.results.filter((result) => !scriptPassed(result));
  if (missing.length > 0) console.error(`Never ran: ${missing.join(", ")}`);
  if (failed.length > 0) {
    console.error(`Not as scripted: ${failed.map((result) => result.script).join(", ")}`);
  }
  if (args.flags.has("check") && (missing.length > 0 || failed.length > 0)) process.exit(1);
});
