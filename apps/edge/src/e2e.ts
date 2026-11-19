// The edge Worker for end-to-end runs and local development without LLM keys (spec WP11 step 4):
// the same Worker, with turn extraction answered from `@earshot/agent`'s committed cassettes, so
// nothing reaches a provider. `pnpm --filter @earshot/edge dev:e2e` serves it.
//
// It also answers `GET /v1/e2e/scenario`: what the capture screen's development-only fake mode
// must send for the cassettes to answer (spec WP9). A cassette is keyed by the whole LLM request,
// and the request holds the session's entities, call time, and time zone besides the transcript,
// so the fake mode takes all of them from here, and says each scripted line on one press. The
// endpoint doubles as the fake mode's check that this Worker, and not the production one (which
// would send the turn to a real provider), is the one listening.
//
// A Worker's entry may export only handlers and classes, so the scenario lives in e2e-scenario.ts.
//
// Only development and test runs use this entry; production deploys `src/index.ts`, which never
// imports `@earshot/agent/testing` (it bundles the cassettes).

import { CASSETTES, type Cassette, createCassetteFetch } from "@earshot/agent/testing";
import type { LlmProvider } from "@earshot/core";
import { PRICE_TABLE_DATE, priceStt } from "@earshot/voice/prices";
import { productionAgent, withFetch } from "./agent";
import { handleE2eRequest } from "./e2e-scenario";
import EdgeWorker from "./index";
import { queueSink } from "./queue";
import { SessionRuntime } from "./session-do";

/** The demo session's turns, every provider's: each request has its own recorded answer. */
export function demoCassette(provider: LlmProvider): Cassette {
  const file = CASSETTES[provider];
  const turns = Object.values(file.cassettes).filter((c) => c.name.startsWith("demo-turn-"));
  return {
    name: `${provider}-demo-session`,
    description: "Every turn of the demo session",
    interactions: turns.flatMap((turn) => turn.interactions),
  };
}

export class SessionDO extends SessionRuntime {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      // A fresh cassette fetch per turn, so each turn replays its own interaction.
      agent: withFetch(productionAgent, (provider) => createCassetteFetch(demoCassette(provider))),
      sink: queueSink(env.FLUSH),
      priceStt,
      priceTableDate: PRICE_TABLE_DATE,
    });
  }
}

/** The production entrypoint, plus the scenario route. */
export default class E2eEdgeWorker extends EdgeWorker {
  override fetch(request: Request): Promise<Response> | Response {
    return handleE2eRequest(request) ?? super.fetch(request);
  }
}
