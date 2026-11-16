// Records cassettes from live provider calls: the demo session's seven turns, through the real
// adapter, written to cassettes/recorded/<provider>-<date>.json for review. It spends money
// (a few cents) and is off unless asked for twice over:
//
//   EARSHOT_RECORD_CASSETTES=1 EVAL_ANTHROPIC_KEY=... tsx scripts/record-cassettes.ts anthropic
//   EARSHOT_RECORD_CASSETTES=1 EVAL_GROQ_KEY=... tsx scripts/record-cassettes.ts groq
//
// Recorded cassettes hold synthetic demo text only, never a key (the recorder refuses any
// interaction containing part of one). Review them before committing; the replay tests use the
// hand-made ones in cassettes/<provider>.json.
import { mkdirSync, writeFileSync } from "node:fs";
import type { LlmProvider } from "@earshot/core";
import { createProposalExtractor, LLM_MODELS } from "../src/extractor";
import { CASSETTE_VERSION, type Cassette, type CassetteFile } from "../src/testing/cassette";
import {
  createRecordingFetch,
  RECORD_FLAG,
  RECORD_KEY_VARIABLES,
  recordingAllowed,
} from "../src/testing/recorder";
import { SCENARIOS } from "../src/testing/scenarios";
import { runTurn } from "../src/turn";

const provider = process.argv[2] as LlmProvider | undefined;
if (provider !== "anthropic" && provider !== "groq") {
  console.error("usage: tsx scripts/record-cassettes.ts anthropic|groq");
  process.exit(2);
}
if (!recordingAllowed(process.env, provider)) {
  console.error(
    `Recording is off. It needs ${RECORD_FLAG}=1 and ${RECORD_KEY_VARIABLES[provider]} set.`,
  );
  process.exit(2);
}
const key = process.env[RECORD_KEY_VARIABLES[provider]]?.trim() ?? "";

const cassettes: Record<string, Cassette> = {};
for (const scenario of SCENARIOS[provider].filter((s) => s.name.startsWith("demo-turn-"))) {
  const recorder = createRecordingFetch(fetch, [key]);
  const result = await runTurn({
    extractor: createProposalExtractor({ provider, fetch: recorder.fetch }),
    ...scenario.turn,
    apiKey: key,
    signal: AbortSignal.timeout(30_000),
  });
  console.log(`${scenario.name}: ${result.outcome}, ${result.completed.attempts} call(s)`);
  cassettes[scenario.name] = {
    name: scenario.name,
    description: `Recorded live: ${scenario.description}`,
    interactions: recorder.interactions(),
  };
}

const file: CassetteFile = {
  version: CASSETTE_VERSION,
  provider,
  model: LLM_MODELS[provider],
  source: "recorded",
  cassettes,
};
const dir = new URL("../cassettes/recorded/", import.meta.url);
mkdirSync(dir, { recursive: true });
const out = new URL(`${provider}-${new Date().toISOString().slice(0, 10)}.json`, dir);
writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
