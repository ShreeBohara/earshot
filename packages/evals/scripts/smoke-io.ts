// The live smoke eval's files on disk, for its scripts and tests: smoke.json, the per-provider
// baselines, and the hash a baseline is tied to.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { LLM_MODELS } from "@earshot/agent";
import { LlmProvider } from "@earshot/core";
import { LINKER_PARAMS_V1 } from "@earshot/understanding/link";
import { DEBRIEF_FILES } from "../src/debriefs";
import type { DebriefScript } from "../src/schema";
import { SmokeBaseline, type SmokeIdentity, SmokeSet } from "../src/smoke";
import { ALL_DEBRIEFS } from "../src/understanding";

export const SMOKE_FILE = new URL("../smoke.json", import.meta.url);

export function readSmokeSet(): SmokeSet {
  return SmokeSet.parse(JSON.parse(readFileSync(SMOKE_FILE, "utf8")));
}

/** `--provider` or EVAL_SMOKE_PROVIDER as a provider; throws for anything else. */
export function parseProvider(text: string): LlmProvider {
  const parsed = LlmProvider.safeParse(text.trim());
  if (!parsed.success) {
    throw new Error(
      `--provider (or EVAL_SMOKE_PROVIDER) is anthropic or groq, not ${JSON.stringify(text)}`,
    );
  }
  return parsed.data;
}

/** `baselines/smoke-<provider>.json`, as messages name it from the repository root. */
export function smokeBaselinePath(provider: LlmProvider): string {
  return `packages/evals/baselines/smoke-${provider}.json`;
}

export function smokeBaselineUrl(provider: LlmProvider): URL {
  return new URL(`../baselines/smoke-${provider}.json`, import.meta.url);
}

/** The committed baseline for a provider, or null when none has been recorded. */
export function readSmokeBaseline(provider: LlmProvider): SmokeBaseline | null {
  const file = smokeBaselineUrl(provider);
  if (!existsSync(file)) return null;
  return SmokeBaseline.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** A script's file: the 30 hand-written ones sit in debriefs/, the generated ones below it. */
function scriptFile(id: string): URL {
  const generated = DEBRIEF_FILES.includes(id) ? "" : "generated/";
  return new URL(`../debriefs/${generated}${id}.json`, import.meta.url);
}

/** SHA-256 over the scripts' files' bytes, in the order given. */
export function smokeScriptsSha256(ids: readonly string[]): string {
  const hash = createHash("sha256");
  for (const id of ids) hash.update(readFileSync(scriptFile(id)));
  return hash.digest("hex");
}

/** What a run of these scripts is, for checking a baseline against it. */
export function smokeIdentity(
  provider: LlmProvider,
  scripts: readonly DebriefScript[],
): SmokeIdentity {
  const ids = scripts.map((script) => script.id);
  return {
    provider,
    model: LLM_MODELS[provider],
    linker: LINKER_PARAMS_V1.version,
    scripts: ids,
    scriptsSha256: smokeScriptsSha256(ids),
  };
}

/** The scripts to run: smoke.json's, or the ids given (`--scripts`), in id order. */
export function chosenScripts(only: string | undefined): DebriefScript[] {
  const ids = (only ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const wanted = ids.length > 0 ? new Set(ids) : new Set(readSmokeSet().scripts);
  const scripts = ALL_DEBRIEFS.filter((script) => wanted.has(script.id));
  const missing = [...wanted].filter((id) => !scripts.some((script) => script.id === id));
  if (missing.length > 0) throw new Error(`no debrief script ${missing.join(", ")}`);
  if (scripts.length === 0) throw new Error("no scripts to run");
  return scripts;
}

/** Where a run happened, for the report and the baseline: the CI run, or "local". */
export function runSource(env: NodeJS.ProcessEnv = process.env): string {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA } = env;
  if (GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID) {
    const sha = GITHUB_SHA ? `${GITHUB_SHA.slice(0, 12)} ` : "";
    return `${sha}${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  }
  return "local";
}

/** The env variable holding a provider's smoke key. Read here, passed on, never printed. */
export const SMOKE_KEY_VARIABLES: Readonly<Record<LlmProvider, string>> = {
  anthropic: "EVAL_SMOKE_ANTHROPIC_KEY",
  groq: "EVAL_SMOKE_GROQ_KEY",
};

/** The provider's key from the environment; throws, without echoing anything, when it's unset. */
export function smokeKey(provider: LlmProvider, env: NodeJS.ProcessEnv = process.env): string {
  const name = SMOKE_KEY_VARIABLES[provider];
  const key = env[name]?.trim() ?? "";
  if (key === "") {
    throw new Error(
      `${name} isn't set. The live smoke eval runs in the eval-smoke environment, which holds it; use --estimate or --offline for a $0 run`,
    );
  }
  return key;
}
