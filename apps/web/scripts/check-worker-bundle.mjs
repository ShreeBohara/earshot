// Fails the build if development-only code reached the OpenNext Worker bundle. `next dev` runs
// PGlite in process (lib/db/dev.ts); production builds must compile it out (docs/adr/0018).
//
//   node scripts/check-worker-bundle.mjs [.open-next]
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".open-next");

// Strings that survive minification: one from lib/db/dev.ts, one from lib/repo-path.ts as used by
// lib/db/pglite.ts, and the names of PGlite's own runtime files. The serialized Next config lists
// the PGlite packages in lowercase (`serverExternalPackages`), which these don't match.
const MARKERS = [
  "earshot.dev-database",
  "pglite.wasm",
  "pglite.data",
  "PGlite",
  "drizzle-orm/pglite",
];
const SCANNED = /\.(?:m?js|cjs|json|wasm)$/;

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (SCANNED.test(entry.name) && entry.name !== "check-worker-bundle.mjs") yield full;
  }
}

const hits = [];
let scanned = 0;
for (const file of files(root)) {
  scanned += 1;
  const text = readFileSync(file, "latin1");
  for (const marker of MARKERS) {
    if (text.includes(marker)) hits.push(`${path.relative(root, file)}: ${marker}`);
  }
}

if (scanned === 0) {
  console.error(`check-worker-bundle: no files under ${root}; run the OpenNext build first`);
  process.exit(1);
}
if (hits.length > 0) {
  console.error("check-worker-bundle: development-only database code reached the Worker bundle:");
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(`check-worker-bundle: ${scanned} files, no PGlite or dev-database code`);
