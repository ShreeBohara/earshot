// The pilot's pre-registered analysis (Phase 5 spec WP7 step 3, WP15; docs/pilot/pre-registration.md),
// run as is on the participants' results files, as markdown on stdout:
//
//   pnpm --filter @earshot/evals pilot:analyze results/*.json > docs/pilot/results.md
//
// Paths are read from where pnpm was started. Files for another set, or that aren't results files,
// are left out and named in the report. No network, no model: $0.
import { readFileSync } from "node:fs";
import path from "node:path";
import { analyzePilot, PilotManifest, pilotAnalysisMarkdown } from "../src/pilot";
import { parseArgs, run, userPath } from "./args";

const MANIFEST = new URL("../pilot/pilot.v1/manifest.json", import.meta.url);

run(() => {
  const args = parseArgs(process.argv.slice(2));
  if (args.positionals.length === 0) {
    throw new Error("Name the results files: pilot:analyze results/*.json");
  }
  const manifest = PilotManifest.parse(JSON.parse(readFileSync(MANIFEST, "utf8")));
  const files = args.positionals.map((given) => ({
    name: path.basename(given),
    text: readFileSync(userPath(given), "utf8"),
  }));
  console.log(pilotAnalysisMarkdown(analyzePilot(files, manifest)));
});
