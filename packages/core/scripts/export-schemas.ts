// Writes schemas/<Name>.json for every contract. CI regenerates these and fails on any diff.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { contracts } from "../src/contracts";

const outDir = fileURLToPath(new URL("../schemas/", import.meta.url));
mkdirSync(outDir, { recursive: true });

for (const file of readdirSync(outDir)) {
  if (file.endsWith(".json")) rmSync(join(outDir, file));
}

for (const [name, schema] of Object.entries(contracts)) {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" });
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(json, null, 2)}\n`);
}

console.log(`wrote ${Object.keys(contracts).length} schemas to packages/core/schemas`);
