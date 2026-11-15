// Writes data/*.json from the seed tables and a fixed-seed PRNG. The outputs are committed so
// consumers need no build step; a test fails if they go stale.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDataset, DATASET_FILES, serialize } from "./build";
import { DATA_DIR } from "./paths";

const dataset = buildDataset();
mkdirSync(DATA_DIR, { recursive: true });
for (const name of DATASET_FILES) {
  writeFileSync(join(DATA_DIR, `${name}.json`), serialize(dataset[name]));
}
console.log(
  `wrote data/: ${DATASET_FILES.map((name) => `${dataset[name].length} ${name}`).join(", ")}`,
);
