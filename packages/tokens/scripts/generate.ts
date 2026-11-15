// Writes generated/tokens.css and generated/tokens.json from the committed tokens/*.tokens.json.
// Both outputs are committed so consumers need no build step; a test fails if they go stale.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCss, buildJson } from "../src";
import { GENERATED_DIR, readTokenFiles } from "./files";

const files = readTokenFiles();
const css = buildCss(files);

mkdirSync(GENERATED_DIR, { recursive: true });
writeFileSync(join(GENERATED_DIR, "tokens.css"), css);
writeFileSync(join(GENERATED_DIR, "tokens.json"), buildJson(files));

const declarations = css.match(/^\s+--[\w-]+:/gm)?.length ?? 0;
console.log(`wrote generated/tokens.css (${declarations} declarations) and generated/tokens.json`);
