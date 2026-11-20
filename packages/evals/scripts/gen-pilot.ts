// Builds the pilot set, pilot.v1 (Phase 5 spec WP7 step 1; ADR-0039), from the 200 debriefs on the
// Anthropic understanding cassettes, at $0:
//
//   pnpm --filter @earshot/evals pilot:gen [--check]
//
// It writes pilot/pilot.v1/: s01.jsonl to s10.jsonl, practice.jsonl, and manifest.json, whose
// `sha256` is the set's hash, and prints the set: its sessions, seeded errors, tier mix, and
// orders. `--check` writes nothing and exits 1 if any committed file differs from a rebuild, which
// is what the reproduction test checks too. The set is pre-registered by its hash: once the pilot
// has begun, never regenerate it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { buildPilotSet } from "../src/pilot/build";
import { pilotSetMarkdown } from "../src/pilot/describe";
import { ALL_DEBRIEFS } from "../src/understanding";
import { parseArgs } from "./args";
import {
  cassetteFileUrl,
  errorsSha256,
  readErrorLabels,
  readUnderstandingCassettes,
  scriptsSha256,
} from "./understanding-io";

const PILOT_DIR = new URL("../pilot/pilot.v1/", import.meta.url);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["check"]);
  const started = performance.now();
  const { files, manifest } = await buildPilotSet({
    scripts: ALL_DEBRIEFS,
    cassettes: readUnderstandingCassettes().anthropic,
    labels: readErrorLabels(),
    hashes: {
      scriptsSha256: scriptsSha256(),
      errorsSha256: errorsSha256(),
      cassetteSha256: createHash("sha256")
        .update(readFileSync(cassetteFileUrl("anthropic")))
        .digest("hex"),
    },
  });
  const elapsed = Math.round(performance.now() - started);

  if (args.flags.has("check")) {
    const drift: string[] = [];
    const present = existsSync(PILOT_DIR) ? readdirSync(PILOT_DIR) : [];
    for (const name of present) if (!files.has(name)) drift.push(`${name} isn't built any more`);
    for (const [name, text] of files) {
      const url = new URL(name, PILOT_DIR);
      if (!existsSync(url) || readFileSync(url, "utf8") !== text) drift.push(`${name} differs`);
    }
    if (drift.length > 0) throw new Error(`pilot.v1 drifted:\n- ${drift.join("\n- ")}`);
    console.log(`pilot.v1 matches its builder (sha256 ${manifest.sha256}).`);
    return;
  }

  mkdirSync(PILOT_DIR, { recursive: true });
  for (const name of readdirSync(PILOT_DIR)) {
    if (!files.has(name)) rmSync(new URL(name, PILOT_DIR));
  }
  for (const [name, text] of files) writeFileSync(new URL(name, PILOT_DIR), text);
  console.log(`Wrote packages/evals/pilot/pilot.v1/ in ${elapsed} ms.\n`);
  console.log(pilotSetMarkdown(manifest));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
