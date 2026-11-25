// The conformance suite on the demo CRM's adapter (Phase 6 WP2), over a store in memory, against
// the committed golden plans and requests in ./golden/demo (regenerate them on purpose with `-u`,
// and review the diff). `@earshot/db` runs the same suite on Postgres through PGlite.
import { fileURLToPath } from "node:url";
import { demoConformanceOptions, runConformance } from "../src/conformance";
import { demoAdapter, demoContext } from "../src/demo";
import { demoHarness, MemoryDemoStore, memoryDemoRaw } from "../src/testing";

const GOLDEN = fileURLToPath(new URL("./golden/demo/", import.meta.url));
const store = new MemoryDemoStore();

runConformance(
  () => demoAdapter,
  demoHarness({ context: () => demoContext(store, { pageSize: 3 }), raw: memoryDemoRaw(store) }),
  demoConformanceOptions(GOLDEN, { name: "the demo CRM, in memory" }),
);
