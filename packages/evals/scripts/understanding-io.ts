// The understanding eval's files on disk, for the Node scripts and tests: its cassettes, its
// seeded errors' labels, its baseline, and the hashes the baseline is tied to.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { CassetteFile } from "@earshot/agent/testing";
import type { LlmProvider } from "@earshot/core";
import { DEBRIEF_FILES } from "../src/debriefs";
import { EVAL_PROVIDERS } from "../src/generate";
import { ErrorLabels, GENERATED_FILES, UnderstandingBaseline } from "../src/understanding";

export const UNDERSTANDING_DIR = new URL("../cassettes/understanding/", import.meta.url);
export const ERRORS_FILE = new URL("errors.json", UNDERSTANDING_DIR);
export const BASELINE_FILE = new URL("../baselines/understanding.json", import.meta.url);

export function cassetteFileUrl(provider: LlmProvider): URL {
  return new URL(`${provider}.json`, UNDERSTANDING_DIR);
}

export function readErrorLabels(): ErrorLabels {
  return ErrorLabels.parse(JSON.parse(readFileSync(ERRORS_FILE, "utf8")));
}

export function readUnderstandingCassettes(): Record<LlmProvider, CassetteFile> {
  const files = {} as Record<LlmProvider, CassetteFile>;
  for (const provider of EVAL_PROVIDERS) {
    files[provider] = JSON.parse(readFileSync(cassetteFileUrl(provider), "utf8")) as CassetteFile;
  }
  return files;
}

export function readBaseline(): UnderstandingBaseline | null {
  if (!existsSync(BASELINE_FILE)) return null;
  return UnderstandingBaseline.parse(JSON.parse(readFileSync(BASELINE_FILE, "utf8")));
}

/** SHA-256 over every script file's bytes, d001–d200 in id order. */
export function scriptsSha256(): string {
  const hash = createHash("sha256");
  for (const id of DEBRIEF_FILES)
    hash.update(readFileSync(new URL(`../debriefs/${id}.json`, import.meta.url)));
  for (const id of GENERATED_FILES) {
    hash.update(readFileSync(new URL(`../debriefs/generated/${id}.json`, import.meta.url)));
  }
  return hash.digest("hex");
}

export function errorsSha256(): string {
  return createHash("sha256").update(readFileSync(ERRORS_FILE)).digest("hex");
}
