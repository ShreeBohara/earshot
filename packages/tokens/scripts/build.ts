// Builds dist/tokens.css and dist/tokens.json from the committed tokens/*.tokens.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCss, buildJson } from "../src";
import { DIST_DIR, readTokenFiles } from "./files";

const files = readTokenFiles();
const css = buildCss(files);

mkdirSync(DIST_DIR, { recursive: true });
writeFileSync(join(DIST_DIR, "tokens.css"), css);
writeFileSync(join(DIST_DIR, "tokens.json"), buildJson(files));

const declarations = css.match(/^\s+--[\w-]+:/gm)?.length ?? 0;
console.log(`wrote dist/tokens.css (${declarations} declarations) and dist/tokens.json`);
