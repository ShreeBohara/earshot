// Regenerates the generated debriefs, d031–d200, from the seeded grammar (Phase 4 WP10 step 2;
// ADR-0031). d001–d030 are hand-written and never touched:
//
//   pnpm --filter @earshot/evals debriefs:gen [--check]
//
// It writes debriefs/generated/<id>.json and src/understanding/generated.ts (their static
// imports), and prints the coverage table against eval harness v1's minimums. `--check` writes
// nothing and exits 1 if any committed file differs from what the generator makes today, which is
// what the reproduction test checks too. Review the diff, then regenerate the understanding
// cassettes (`cassettes:gen`) and re-record the baseline on purpose (`eval:understanding
// --write-baseline`).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { coverageMarkdown, coverageOf, coverageShortfallsV1 } from "../src/coverage";
import { DEBRIEFS } from "../src/debriefs";
import { generateDebriefScripts, generatedIndexSource, serializeScript } from "../src/grammar";
import { DebriefScript } from "../src/schema";
import { parseArgs, run } from "./args";

run(() => {
  const args = parseArgs(process.argv.slice(2), ["check"]);
  const started = performance.now();
  const scripts = generateDebriefScripts();
  const elapsed = performance.now() - started;
  const directory = new URL("../debriefs/generated/", import.meta.url);
  const index = new URL("../src/understanding/generated.ts", import.meta.url);
  const files = new Map(scripts.map((script) => [`${script.id}.json`, serializeScript(script)]));
  const indexSource = generatedIndexSource(scripts.map((script) => script.id));

  if (args.flags.has("check")) {
    const drift: string[] = [];
    const present = existsSync(directory)
      ? readdirSync(directory).filter((name) => name.endsWith(".json"))
      : [];
    for (const name of present)
      if (!files.has(name)) drift.push(`${name} isn't generated any more`);
    for (const [name, text] of files) {
      const url = new URL(name, directory);
      if (!existsSync(url) || readFileSync(url, "utf8") !== text) drift.push(`${name} differs`);
    }
    if (!existsSync(index) || readFileSync(index, "utf8") !== indexSource) {
      drift.push("src/understanding/generated.ts differs");
    }
    if (drift.length > 0) {
      throw new Error(`The generated debriefs drifted:\n- ${drift.slice(0, 20).join("\n- ")}`);
    }
    console.log(`The ${scripts.length} generated debriefs match the generator.`);
    return;
  }

  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(directory)) {
    if (name.endsWith(".json") && !files.has(name)) rmSync(new URL(name, directory));
  }
  for (const [name, text] of files) writeFileSync(new URL(name, directory), text);
  writeFileSync(index, indexSource);
  const all = [...DEBRIEFS, ...scripts.map((script) => DebriefScript.parse(script))];
  const coverage = coverageOf(all);
  console.log(
    `Wrote ${scripts.length} scripts to packages/evals/debriefs/generated/ in ${Math.round(elapsed)} ms.\n`,
  );
  console.log(coverageMarkdown(coverage));
  const short = coverageShortfallsV1(coverage);
  if (short.length > 0)
    throw new Error(`Below eval harness v1's minimums:\n- ${short.join("\n- ")}`);
});
