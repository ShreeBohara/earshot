// Writes linking/confusable.v1.jsonl from the generator (src/linking/generate.ts):
//
//   pnpm --filter @earshot/evals linking:gen
//
// v1 is frozen once committed: test/linking-set.test.ts regenerates it in memory and fails on
// any difference. A change to the simulator, the decoys, the templates, the ground truth, or the
// name toolkit that alters the file means a new set (confusable.v2, with its own baseline), not
// an edit to v1. No network, no clock: the output depends on the code alone.
import { writeFileSync } from "node:fs";
import {
  CONFUSABLE_SET_FILE,
  generateConfusableSet,
  ITEM_CLASSES,
  serializeConfusableSet,
} from "../src/linking";

const items = generateConfusableSet();
writeFileSync(new URL(`../${CONFUSABLE_SET_FILE}`, import.meta.url), serializeConfusableSet(items));
for (const itemClass of ITEM_CLASSES) {
  const ofClass = items.filter((item) => item.class === itemClass);
  const calibration = ofClass.filter((item) => item.split === "calibration").length;
  console.log(
    `${itemClass.padEnd(2)} ${String(ofClass.length).padStart(3)} items (${calibration} calibration, ${ofClass.length - calibration} test)`,
  );
}
console.log(`Wrote packages/evals/${CONFUSABLE_SET_FILE}: ${items.length} items.`);
