// @earshot/agent/testing: cassettes and scenarios for tests, evals, and the e2e edge entry
// (spec WP11 step 4's src/e2e.ts). Production code must not import it: it bundles the cassettes.
import type { LlmProvider } from "@earshot/core";
import anthropicCassettes from "../../cassettes/anthropic.json" with { type: "json" };
import groqCassettes from "../../cassettes/groq.json" with { type: "json" };
import type { Cassette, CassetteFile } from "./cassette";

export {
  CASSETTE_VERSION,
  type Cassette,
  type CassetteFetch,
  type CassetteFile,
  type CassetteInteraction,
  CassetteMissError,
  type CassetteRequest,
  type CassetteResponse,
  canonicalJson,
  cassetteKey,
  cassetteResponse,
  createCassetteFetch,
  type FetchInput,
  readCassetteRequest,
  requestExcerpt,
} from "./cassette";
export { generateCassetteFiles, recordScenario } from "./generate";
export {
  type RecapScenario,
  type RecapScenarioInput,
  recapResponse,
  recordRecap,
  type ScriptedRecapFetch,
  type ScriptedRecapMode,
  type ScriptedRecapOptions,
  scriptedRecapFetch,
  scriptedRecapInput,
} from "./recap";
export {
  createRecordingFetch,
  RECORD_FLAG,
  RECORD_KEY_VARIABLES,
  type RecordingFetch,
  RecordingLeakError,
  recordingAllowed,
} from "./recorder";
export {
  anthropicError,
  anthropicToolUse,
  DEMO_CALL_TIME,
  DEMO_COMPANY_ID,
  DEMO_DEAL_ID,
  DEMO_ENTITIES,
  DEMO_FOCUS_ID,
  DEMO_SESSION,
  DEMO_TIME_ZONE,
  DEMO_UTTERANCES,
  demoTurnId,
  groqError,
  groqText,
  groqToolCall,
  SCENARIO_API_KEY,
  SCENARIOS,
  type Scenario,
  type ScenarioTurn,
  type ScriptedResponse,
  scenario,
  type Tokens,
} from "./scenarios";

/** The committed hand-made cassettes, per provider (cassettes/<provider>.json). */
export const CASSETTES: Readonly<Record<LlmProvider, CassetteFile>> = {
  anthropic: anthropicCassettes as unknown as CassetteFile,
  groq: groqCassettes as unknown as CassetteFile,
};

/** One committed cassette, by provider and scenario name. */
export function cassette(provider: LlmProvider, name: string): Cassette {
  const found = CASSETTES[provider].cassettes[name];
  if (!found) throw new RangeError(`no ${provider} cassette named ${name}`);
  return found;
}
