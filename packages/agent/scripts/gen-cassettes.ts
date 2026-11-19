// Regenerates cassettes/<provider>.json from the scenarios in src/testing/scenarios.ts. Run it
// after changing the prompt, the tool schema, the adapters' request options, or a scenario:
//
//   pnpm --filter @earshot/agent cassettes:gen
//
// It makes no network request: the responses are the scenarios' hand-made ones.
import { writeFileSync } from "node:fs";
import { generateCassetteFiles } from "../src/testing/generate";

const files = await generateCassetteFiles();
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
