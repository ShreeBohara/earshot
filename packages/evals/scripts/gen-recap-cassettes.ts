// Regenerates the recap eval's cassettes from the debrief scripts' ground truth (Phase 5 WP10). Run
// it after changing a script, the generator, or @earshot/agent's recap prompt, tool schema, or
// request options:
//
//   pnpm --filter @earshot/evals recap:gen
//
// It writes cassettes/recap/<provider>.json (one recap per debrief, all 200) and
// cassettes/recap/seeded.json (the seeded bad sentences and invented lens quotes, with their
// labels), and makes no network request. A test regenerates both in memory and fails on drift.
import { mkdirSync, writeFileSync } from "node:fs";
import { generateRecapCassettes, seedRecapErrors, serializeRecapLabels } from "../src/recap";
import { ALL_DEBRIEFS, serializeCassetteFile } from "../src/understanding";
import { RECAP_DIR, RECAP_LABELS_FILE, recapCassetteUrl } from "./recap-io";

const labels = seedRecapErrors(ALL_DEBRIEFS);
const files = await generateRecapCassettes(ALL_DEBRIEFS, labels);
mkdirSync(RECAP_DIR, { recursive: true });
writeFileSync(RECAP_LABELS_FILE, serializeRecapLabels(labels));
for (const [provider, file] of Object.entries(files)) {
  writeFileSync(recapCassetteUrl(provider as keyof typeof files), serializeCassetteFile(file));
  console.log(`recap/${provider}: ${Object.keys(file.cassettes).length} cassettes`);
}
console.log(
  `seeded: ${labels.sentences.length} bad sentences of ${labels.eligible.bad_sentence} ground-truth sentences, ${labels.lens.length} invented lens quotes of ${labels.eligible.bad_lens_quote} unanswered lens fields`,
);
