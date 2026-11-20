// The recap eval's files on disk, for its scripts and tests: the cassettes, the labels, the
// baseline, and the hashes the baseline is tied to.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { CassetteFile } from "@earshot/agent/testing";
import type { LlmProvider } from "@earshot/core";
import { EVAL_PROVIDERS } from "../src/generate";
import { RecapBaseline, RecapLabels } from "../src/recap";

export const RECAP_DIR = new URL("../cassettes/recap/", import.meta.url);
export const RECAP_LABELS_FILE = new URL("seeded.json", RECAP_DIR);
export const RECAP_BASELINE_FILE = new URL("../baselines/recap.json", import.meta.url);

export function recapCassetteUrl(provider: LlmProvider): URL {
  return new URL(`${provider}.json`, RECAP_DIR);
}

export function readRecapLabels(): RecapLabels {
  return RecapLabels.parse(JSON.parse(readFileSync(RECAP_LABELS_FILE, "utf8")));
}

export function readRecapCassettes(): Record<LlmProvider, CassetteFile> {
  const files = {} as Record<LlmProvider, CassetteFile>;
  for (const provider of EVAL_PROVIDERS) {
    files[provider] = JSON.parse(readFileSync(recapCassetteUrl(provider), "utf8")) as CassetteFile;
  }
  return files;
}

export function readRecapBaseline(): RecapBaseline | null {
  if (!existsSync(RECAP_BASELINE_FILE)) return null;
  return RecapBaseline.parse(JSON.parse(readFileSync(RECAP_BASELINE_FILE, "utf8")));
}

export function recapLabelsSha256(): string {
  return createHash("sha256").update(readFileSync(RECAP_LABELS_FILE)).digest("hex");
}
