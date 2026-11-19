// Regenerates cassettes/<provider>.json from the debrief scripts' ground truth. Run it after
// changing a script, or after @earshot/agent changes its prompt, tool schema, or request options
// (its own cassettes regenerate the same way):
//
//   pnpm --filter @earshot/evals cassettes:gen
//
// It makes no network request: every response is built from the scripts by src/generate.ts.
import { writeFileSync } from "node:fs";
import { generateEvalCassettes } from "../src/generate";

const files = await generateEvalCassettes();
for (const [provider, file] of Object.entries(files)) {
  const url = new URL(`../cassettes/${provider}.json`, import.meta.url);
  writeFileSync(url, `${JSON.stringify(file, null, 2)}\n`);
  const interactions = Object.values(file.cassettes).reduce(
    (sum, cassette) => sum + cassette.interactions.length,
    0,
  );
  console.log(
    `${provider}: ${Object.keys(file.cassettes).length} cassettes, ${interactions} interactions`,
  );
}
