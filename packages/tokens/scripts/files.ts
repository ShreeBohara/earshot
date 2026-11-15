// Node-only file access for the CLI, the build, and the tests. The package entry stays
// browser-safe, so the Storybook theme playground can run the generator live.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTokenFile,
  serializeTokenFile,
  TOKEN_FILE_NAMES,
  type TokenFileName,
  type TokenFiles,
} from "../src";

export const TOKENS_DIR = fileURLToPath(new URL("../tokens/", import.meta.url));
export const DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));

export function tokenFilePath(name: TokenFileName): string {
  return join(TOKENS_DIR, `${name}.tokens.json`);
}

export function readTokenFiles(): TokenFiles {
  return Object.fromEntries(
    TOKEN_FILE_NAMES.map((name) => [
      name,
      parseTokenFile(readFileSync(tokenFilePath(name), "utf8")),
    ]),
  ) as TokenFiles;
}

/** Replaces every `*.tokens.json` file, so a renamed file can't linger. */
export function writeTokenFiles(files: TokenFiles): void {
  mkdirSync(TOKENS_DIR, { recursive: true });
  for (const file of readdirSync(TOKENS_DIR)) {
    if (file.endsWith(".tokens.json")) rmSync(join(TOKENS_DIR, file));
  }
  for (const name of TOKEN_FILE_NAMES) {
    writeFileSync(tokenFilePath(name), serializeTokenFile(files[name]));
  }
}
