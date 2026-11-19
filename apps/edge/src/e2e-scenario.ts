// The scenario `src/e2e.ts` serves at `GET /v1/e2e/scenario` (spec WP9): what the capture
// screen's development-only fake mode sends, so `@earshot/agent`'s demo cassettes answer every
// turn. A cassette is keyed by the whole LLM request, which holds the session's entities, call
// time, and time zone besides the transcript; the fake mode takes all of them from here and says
// one scripted line per press. The route also tells the fake mode that the e2e Worker, not the
// production one (which would send the turn to a real provider), is the one listening.
import { LLM_MODELS } from "@earshot/agent";
import {
  DEMO_CALL_TIME,
  DEMO_ENTITIES,
  DEMO_TIME_ZONE,
  DEMO_UTTERANCES,
} from "@earshot/agent/testing";
import type { EntityRef, LlmProvider } from "@earshot/core";

export const E2E_SCENARIO_PATH = "/v1/e2e/scenario";

/** `GET /v1/e2e/scenario`: a scripted session the cassettes answer, turn by turn. */
export interface E2eScenario {
  readonly version: 1;
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

/** The demo session (`@earshot/events`' fixture) as a scenario: seven presses, five proposals. */
export function e2eScenario(): E2eScenario {
  return {
    version: 1,
    name: "demo-session",
    startedAt: DEMO_CALL_TIME,
    timeZone: DEMO_TIME_ZONE,
    entities: DEMO_ENTITIES,
    llm: { provider: "anthropic", model: LLM_MODELS.anthropic },
    turns: DEMO_UTTERANCES.map((utterance) => ({ text: utterance.text })),
  };
}

/** Answers the e2e-only routes, or returns undefined for the production Worker to handle. */
export function handleE2eRequest(request: Request): Response | undefined {
  if (new URL(request.url).pathname !== E2E_SCENARIO_PATH) return undefined;
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  return Response.json(e2eScenario(), { headers: { "cache-control": "no-store" } });
}
