// Runs a linker over the confusable-name set and reports the metrics in spec §4.5, with a table
// per class:
//
//   pnpm --filter @earshot/evals eval:linking [--split test | calibration | all]
//     [--set confusable | mined | <file.jsonl>] [--linker v0 | v1 | oracle] [--check]
//     [--summary ["$GITHUB_STEP_SUMMARY"]] [--json report.json] [--write-baseline]
//
// - `--split` defaults to test, the split G1 is judged on. Tune on calibration only.
// - `--set` defaults to confusable.v1; `mined` is WP6's mined.v1.
// - `--linker` defaults to v0, Phase 3's matcher. `v1` is WP4's linker with its committed
//   parameters; its report adds the ablation table (each variant refit on calibration, about a
//   second). `oracle` is the set's ground truth run as a linker, the ceiling the set allows, for
//   reference.
// - `--summary` appends the report to a file, or to $GITHUB_STEP_SUMMARY when it names none (and
//   to nothing outside GitHub Actions; the report is printed either way).
// - `--check` exits 1 on a G1 failure (for a linker the gate applies to, on the test split) or a
//   regression against the linker's committed baseline: coverage down more than 3 points, or
//   the wrong-account rate up more than 0.5 point. A baseline taken on another set file fails too.
// - `--write-baseline` records both splits of confusable.v1 to the linker's baseline file, on
//   purpose. Review the diff, then commit it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  ablationMarkdown,
  ablationTable,
  BASELINE_FORMAT,
  CONFUSABLE_SET_FILE,
  CONFUSABLE_SET_VERSION,
  gateFailures,
  LINKERS,
  LINKING_ENTITIES,
  LinkingBaseline,
  linkingCase,
  linkingMarkdown,
  linkingReport,
  parseConfusableSet,
  regressionFailures,
  score,
  splitSummary,
} from "../src/linking";
import { appendSummary, flag, parseArgs, run, userPath } from "./args";

const SPLITS = ["test", "calibration", "all"] as const;
type SplitName = (typeof SPLITS)[number];

function setFile(name: string): { label: string; path: string } {
  if (name === "confusable") {
    return {
      label: CONFUSABLE_SET_VERSION,
      path: new URL(`../${CONFUSABLE_SET_FILE}`, import.meta.url).pathname,
    };
  }
  if (name === "mined") {
    return {
      label: "mined.v1",
      path: new URL("../linking/mined.v1.jsonl", import.meta.url).pathname,
    };
  }
  return { label: name, path: userPath(name) };
}

run(() => {
  const args = parseArgs(process.argv.slice(2), ["check", "write-baseline"], ["summary"]);
  const split = (flag(args, "split") ?? "test") as SplitName;
  if (!SPLITS.includes(split)) throw new Error(`--split is one of ${SPLITS.join(", ")}`);
  const linkerName = flag(args, "linker") ?? "v0";
  const linker = LINKERS[linkerName];
  if (!linker)
    throw new Error(`no linker ${linkerName}; known: ${Object.keys(LINKERS).join(", ")}`);
  const set = setFile(flag(args, "set") ?? "confusable");
  if (!existsSync(set.path)) throw new Error(`no set file at ${set.path}`);
  const text = readFileSync(set.path, "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  const items = parseConfusableSet(text);
  const scored = score(items, linker.predict(items.map(linkingCase), LINKING_ENTITIES));
  const meta = { linker: linker.name, witness: linker.witness, set: set.label };

  const baselineUrl = linker.baseline
    ? new URL(`../baselines/${linker.baseline}`, import.meta.url)
    : null;
  if (args.flags.has("write-baseline")) {
    if (baselineUrl === null) throw new Error(`${linker.name} is a reference with no baseline`);
    if (set.label !== CONFUSABLE_SET_VERSION) {
      throw new Error("baselines are taken on confusable.v1");
    }
    const summaries = Object.fromEntries(
      (["calibration", "test"] as const).map((name) => [
        name,
        splitSummary(
          linkingReport(
            scored.filter((row) => row.item.split === name),
            { ...meta, split: name },
          ),
        ),
      ]),
    );
    const baseline = LinkingBaseline.parse({
      format: BASELINE_FORMAT,
      linker: linker.name,
      set: set.label,
      setSha256: sha256,
      recordedAt: new Date().toISOString().slice(0, 10),
      splits: summaries,
    });
    writeFileSync(baselineUrl, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(
      `Wrote packages/evals/baselines/${linker.baseline}. Review the diff, then commit it.`,
    );
  }

  const rows = split === "all" ? scored : scored.filter((row) => row.item.split === split);
  const report = linkingReport(rows, { ...meta, split });
  const gate = linker.gate && split === "test" ? gateFailures(report.final) : null;
  let regressions: string[] | null = null;
  if (baselineUrl !== null && existsSync(baselineUrl) && split !== "all") {
    const baseline = LinkingBaseline.parse(JSON.parse(readFileSync(baselineUrl, "utf8")));
    if (baseline.set !== set.label) regressions = null;
    else if (baseline.setSha256 !== sha256) {
      regressions = [
        `Regression: ${linker.baseline} was recorded on another ${set.label} file (sha256 ${baseline.setSha256.slice(0, 12)}…, now ${sha256.slice(0, 12)}…)`,
      ];
    } else regressions = regressionFailures(report.final, baseline.splits[split].final);
  }
  let markdown = linkingMarkdown(report, { gate, regressions });
  if (linker === LINKERS.v1 && set.label === CONFUSABLE_SET_VERSION) {
    const ablations = ablationTable(items, LINKING_ENTITIES, (item) =>
      split === "all" ? true : item.split === split,
    );
    markdown = `${markdown}\n\n${ablationMarkdown(ablations, split)}`;
  }
  console.log(markdown);
  const summary = args.flags.get("summary");
  appendSummary(
    typeof summary === "string" ? summary : summary ? process.env.GITHUB_STEP_SUMMARY : undefined,
    markdown,
  );
  const out = flag(args, "json");
  if (out) writeFileSync(userPath(out), `${JSON.stringify(report, null, 2)}\n`);
  if (args.flags.has("check") && ((gate?.length ?? 0) > 0 || (regressions?.length ?? 0) > 0)) {
    process.exit(1);
  }
});
