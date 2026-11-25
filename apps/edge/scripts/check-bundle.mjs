// Fails the build if test-only code reached the production bundle (dist/index.js, from
// `wrangler deploy --dry-run`): `@earshot/agent`'s cassettes or `@earshot/evals` (its scripts,
// scenarios, and cassettes), which only src/e2e.ts and the tests import, or PGlite, which only
// the Node tests use.
import { readFileSync } from "node:fs";

const bundle = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
const forbidden = [
  "createCassetteFetch",
  "CassetteMissError",
  "demo-turn-1",
  // @earshot/agent/testing's scripted recap model (Phase 5 WP10): its unbacked sentence.
  "they'll sign the contract by Monday",
  "PGlite",
  // @earshot/evals: a script's title, and the e2e scenario route's path.
  "Acme Dynamics wants two more plants",
  "/v1/e2e/scenario",
];
const found = forbidden.filter((marker) => bundle.includes(marker));
if (found.length > 0) {
  console.error(`dist/index.js contains test-only code: ${found.join(", ")}`);
  process.exit(1);
}
console.log(`dist/index.js: ${(bundle.length / 1e6).toFixed(1)} MB, no test-only code`);
