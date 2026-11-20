// Regenerates the eval cassettes from the debrief scripts' ground truth. Run it after changing a
// script, or after @earshot/agent changes its prompt, tool schema, or request options (its own
// cassettes regenerate the same way):
//
//   pnpm --filter @earshot/evals cassettes:gen
//
// It writes two sets, and makes no network request:
// - cassettes/<provider>.json: the 30 scripts the fake-microphone eval plays, exactly as scripted
//   (src/generate.ts). The e2e edge Worker answers from these.
// - cassettes/understanding/<provider>.json and errors.json: all 200 scripts, with the seeded,
//   labelled model-like errors the understanding eval measures (src/understanding/cassettes.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { generateEvalCassettes } from "../src/generate";
import {
  ALL_DEBRIEFS,
  generateUnderstandingCassettes,
  seedErrors,
  serializeCassetteFile,
  serializeErrorLabels,
} from "../src/understanding";
import { cassetteFileUrl, ERRORS_FILE, UNDERSTANDING_DIR } from "./understanding-io";

const count = (file: { cassettes: Record<string, { interactions: readonly unknown[] }> }) =>
  Object.values(file.cassettes).reduce((sum, cassette) => sum + cassette.interactions.length, 0);

const files = await generateEvalCassettes();
for (const [provider, file] of Object.entries(files)) {
  const url = new URL(`../cassettes/${provider}.json`, import.meta.url);
  writeFileSync(url, `${JSON.stringify(file, null, 2)}\n`);
  console.log(
    `${provider}: ${Object.keys(file.cassettes).length} cassettes, ${count(file)} interactions`,
  );
}

const labels = seedErrors(ALL_DEBRIEFS);
const understanding = await generateUnderstandingCassettes(ALL_DEBRIEFS, labels);
mkdirSync(UNDERSTANDING_DIR, { recursive: true });
writeFileSync(ERRORS_FILE, serializeErrorLabels(labels));
for (const [provider, file] of Object.entries(understanding)) {
  writeFileSync(
    cassetteFileUrl(provider as keyof typeof understanding),
    serializeCassetteFile(file),
  );
  console.log(
    `understanding/${provider}: ${Object.keys(file.cassettes).length} cassettes, ${count(file)} interactions`,
  );
}
const seeded = labels.errors.reduce<Record<string, number>>((tally, error) => {
  tally[error.kind] = (tally[error.kind] ?? 0) + 1;
  return tally;
}, {});
console.log(
  `seeded errors: ${Object.entries(seeded)
    .map(([kind, n]) => `${n} ${kind} of ${labels.eligible[kind as keyof typeof labels.eligible]}`)
    .join(", ")}`,
);
