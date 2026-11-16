// Builds the hand-made cassettes: each scenario runs through the real adapter and `runTurn`,
// with a scripted `fetch` that answers from the scenario's responses and records each request.
// The requests are therefore exactly what the adapters send, and the responses are the ground
// truth, written by hand in each provider's wire format. No network is involved.
//
// scripts/gen-cassettes.ts writes the result to cassettes/<provider>.json; a test regenerates it
// in memory and fails if the committed files differ, so a prompt or schema change must come with
// regenerated cassettes.
import type { LlmProvider } from "@earshot/core";
import { createProposalExtractor, LLM_MODELS } from "../extractor";
import { runTurn } from "../turn";
import {
  CASSETTE_VERSION,
  type Cassette,
  type CassetteFile,
  type CassetteInteraction,
  type FetchInput,
  readCassetteRequest,
} from "./cassette";
import { SCENARIO_API_KEY, SCENARIOS, type Scenario } from "./scenarios";

/** Deterministic ids for generated runs. */
function counterIds(): () => string {
  let n = 0;
  return () => `01a1c6e4-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`;
}

/** Runs one scenario and returns its cassette. Throws if the run doesn't match the scenario. */
export async function recordScenario(scenario: Scenario): Promise<Cassette> {
  const interactions: CassetteInteraction[] = [];
  let next = 0;
  const scripted = async (input: FetchInput, init?: RequestInit) => {
    const request = await readCassetteRequest(input, init);
    const response = scenario.responses[next++];
    if (!response) {
      throw new Error(`${scenario.provider}/${scenario.name} sent more requests than scripted`);
    }
    const recorded = {
      status: response.status,
      headers: response.headers ?? {},
      body: response.body,
    };
    interactions.push({
      key: request.key,
      request: { method: request.method, path: request.path, excerpt: request.excerpt },
      response: recorded,
    });
    const headers = new Headers(recorded.headers);
    const body = typeof recorded.body === "string" ? recorded.body : JSON.stringify(recorded.body);
    return new Response(body, { status: recorded.status, headers });
  };
  const result = await runTurn({
    extractor: createProposalExtractor({
      provider: scenario.provider,
      fetch: scripted as typeof fetch,
      now: () => 0,
    }),
    ...scenario.turn,
    apiKey: SCENARIO_API_KEY,
    signal: new AbortController().signal,
    now: () => 0,
    sleep: async () => {},
    newId: counterIds(),
    random: () => 0.5,
  });
  const label = `${scenario.provider}/${scenario.name}`;
  if (next !== scenario.responses.length) {
    throw new Error(`${label} used ${next} of ${scenario.responses.length} scripted responses`);
  }
  if (result.outcome !== scenario.expect.outcome) {
    throw new Error(`${label} ended ${result.outcome}, not ${scenario.expect.outcome}`);
  }
  if (result.completed.attempts !== scenario.expect.attempts) {
    throw new Error(
      `${label} made ${result.completed.attempts} attempts, not ${scenario.expect.attempts}`,
    );
  }
  return { name: scenario.name, description: scenario.description, interactions };
}

/** Every provider's cassette file, as cassettes/<provider>.json should hold it. */
export async function generateCassetteFiles(): Promise<Record<LlmProvider, CassetteFile>> {
  const build = async (provider: LlmProvider): Promise<CassetteFile> => {
    const cassettes: Record<string, Cassette> = {};
    for (const scenario of SCENARIOS[provider]) {
      cassettes[scenario.name] = await recordScenario(scenario);
    }
    return {
      version: CASSETTE_VERSION,
      provider,
      model: LLM_MODELS[provider],
      source: "hand-made",
      cassettes,
    };
  };
  return { anthropic: await build("anthropic"), groq: await build("groq") };
}
