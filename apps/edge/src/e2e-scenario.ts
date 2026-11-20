// The scenarios `src/e2e.ts` serves at `GET /v1/e2e/scenario` (spec WP9, WP11): what the capture
// screen's development-only fake mode sends, so committed cassettes answer every turn. A
// cassette is keyed by the whole LLM request, which holds the session's entities, call time, and
// time zone besides the transcript; the fake mode takes all of them from here and says one
// scripted line per press. The route also tells the fake mode that the e2e Worker, not the
// production one (which would send the turn to a real provider), is the one listening.
//
// - `GET /v1/e2e/scenario`: the demo session, answered by `@earshot/agent`'s demo cassettes.
// - `GET /v1/e2e/scenario?script=d001`: an eval debrief (`@earshot/evals`), with
//   `DEMO_SESSION_ENTITIES` and the script's call time and time zone, answered by its eval
//   cassette (src/e2e.ts finds it by that call time).
// - `&llm=groq` names Groq instead of Anthropic in either; both have cassettes.
import { LLM_MODELS } from "@earshot/agent";
import {
  DEMO_CALL_TIME,
  DEMO_ENTITIES,
  DEMO_TIME_ZONE,
  DEMO_UTTERANCES,
} from "@earshot/agent/testing";
import type { EntityRef, LlmProvider } from "@earshot/core";
import { DEBRIEFS, DEMO_SESSION_ENTITIES, turnTranscript } from "@earshot/evals";

export const E2E_SCENARIO_PATH = "/v1/e2e/scenario";

/** `GET /v1/e2e/scenario`: a scripted session the cassettes answer, turn by turn. */
export interface E2eScenario {
  readonly version: 1;
  /** `demo-session`, or the eval script's id. */
  readonly name: string;
  /** Send these three unchanged in `start`: every recorded request was made with them. */
  readonly startedAt: string;
  readonly timeZone: string;
  readonly entities: readonly EntityRef[];
  /** The LLM to name in `turn_end`, whose cassettes answer. Any well-formed key will do. */
  readonly llm: { readonly provider: LlmProvider; readonly model: string };
  /** What the rep says, one line per push-to-talk press, in order. */
  readonly turns: readonly { readonly text: string }[];
}

const llmOf = (provider: LlmProvider) => ({ provider, model: LLM_MODELS[provider] });

/** The demo session (`@earshot/events`' fixture) as a scenario: seven presses, five proposals. */
export function e2eScenario(provider: LlmProvider = "anthropic"): E2eScenario {
  return {
    version: 1,
    name: "demo-session",
    startedAt: DEMO_CALL_TIME,
    timeZone: DEMO_TIME_ZONE,
    entities: DEMO_ENTITIES,
    llm: llmOf(provider),
    turns: DEMO_UTTERANCES.map((utterance) => ({ text: utterance.text })),
  };
}

/**
 * An eval debrief as a scenario, or undefined for an unknown id. Its turns are the text the fake
 * speech-to-text adapter emits, so each turn's request is the one its cassette recorded.
 */
export function evalScenario(
  scriptId: string,
  provider: LlmProvider = "anthropic",
): E2eScenario | undefined {
  const script = DEBRIEFS.find((candidate) => candidate.id === scriptId);
  if (!script) return undefined;
  return {
    version: 1,
    name: script.id,
    startedAt: script.callTime,
    timeZone: script.timeZone,
    entities: DEMO_SESSION_ENTITIES,
    llm: llmOf(provider),
    turns: script.turns.map((turn) => ({ text: turnTranscript(turn) })),
  };
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Answers the e2e-only routes, or returns undefined for the production Worker to handle. */
export function handleE2eRequest(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (url.pathname !== E2E_SCENARIO_PATH) return undefined;
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  const llm = url.searchParams.get("llm") ?? "anthropic";
  if (llm !== "anthropic" && llm !== "groq") {
    return json({ error: "llm must be anthropic or groq" }, 400);
  }
  const script = url.searchParams.get("script");
  if (script === null) return json(e2eScenario(llm));
  const scenario = evalScenario(script, llm);
  return scenario ? json(scenario) : json({ error: `no eval script ${script}` }, 404);
}
