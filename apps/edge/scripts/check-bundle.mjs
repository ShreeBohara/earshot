// Fails the build if test-only code reached the production bundle (dist/index.js, from
// `wrangler deploy --dry-run`): `@earshot/agent`'s cassettes, which only src/e2e.ts and the tests
// import, or PGlite, which only the Node tests use.
import { readFileSync } from "node:fs";

const bundle = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
const forbidden = ["createCassetteFetch", "CassetteMissError", "demo-turn-1", "PGlite"];
const found = forbidden.filter((marker) => bundle.includes(marker));
if (found.length > 0) {
  console.error(`dist/index.js contains test-only code: ${found.join(", ")}`);
  process.exit(1);
}
console.log(`dist/index.js: ${(bundle.length / 1e6).toFixed(1)} MB, no test-only code`);
