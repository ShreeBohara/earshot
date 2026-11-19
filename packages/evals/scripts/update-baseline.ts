// Writes a baseline from an eval report, on purpose. CI never does this by itself.
//
//   # G1a: CI's pipeline overhead, from a green `eval` run's eval-report artifact
//   gh run download <run-id> --name eval-report --dir /tmp/eval
//   pnpm --filter @earshot/evals baseline:update /tmp/eval/eval-report.json --run <run url>
//
//   # G1b: a live run's numbers, per provider pair, from eval-live's artifact
//   pnpm --filter @earshot/evals baseline:update live-report.json --live
//
// A CI baseline (baselines/ci.json) needs all 30 scripts, all as scripted, on Kokoro WAVs; a
// live one (baselines/live-<date>.json) records whatever the run measured. Neither is ever taken
// from `--stub` WAVs. Review the diff, then commit it.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { DEBRIEFS } from "../src/debriefs";
import { baselineFrom } from "../src/report";
import { flag, parseArgs, readReport, run } from "./args";

function headCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

run(() => {
  const args = parseArgs(process.argv.slice(2), ["live"]);
  const [file] = args.positionals;
  if (!file || args.positionals.length > 1) throw new Error("name exactly one report file");
  const kind = args.flags.has("live") ? "live" : "ci";
  const report = readReport(file);
  const baseline = baselineFrom(
    report,
    kind,
    DEBRIEFS.map((script) => script.id),
    {
      recordedAt: report.createdAt,
      commit: flag(args, "commit") ?? headCommit(),
      run: flag(args, "run") ?? null,
    },
  );
  const name = kind === "ci" ? "ci.json" : `live-${report.createdAt.slice(0, 10)}.json`;
  const dir = new URL("../baselines/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const target = new URL(name, dir);
  writeFileSync(target, `${JSON.stringify(baseline, null, 2)}\n`);
  for (const pair of baseline.pairs) {
    const total = pair.stages.totalMs;
    console.log(
      `${pair.stt} + ${pair.llm}: ${pair.turnsMeasured} turns, end of speech to card p50 ${total.p50} ms, p95 ${total.p95} ms`,
    );
  }
  console.log(`Wrote packages/evals/baselines/${name}. Review the diff, then commit it.`);
});
