// The edge Worker for end-to-end runs and local development without LLM keys (spec WP11 step 4):
// the same Worker, with turn extraction answered from committed cassettes, so nothing reaches a
// provider. `pnpm --filter @earshot/edge dev:e2e` serves it.
//
// It also answers `GET /v1/e2e/scenario`: what the capture screen's development-only fake mode
// must send for the cassettes to answer (spec WP9). A cassette is keyed by the whole LLM request,
// and the request holds the session's entities, call time, and time zone besides the transcript,
// so the fake mode takes all of them from here, and says each scripted line on one press. The
// endpoint doubles as the fake mode's check that this Worker, and not the production one (which
// would send the turn to a real provider), is the one listening.
//
// Which cassette answers a turn: the eval script (`@earshot/evals`) whose call time the session
// started with, since every script has its own and the fake-microphone eval starts each session
// with its script's; otherwise the demo session's, `@earshot/agent`'s.
//
// The recap at the end of a session (Phase 5 WP10) is answered by `@earshot/agent`'s scripted
// recap model instead: it quotes whatever the session's transcript says, since each end-to-end
// test says a different part of its script, and a request-keyed cassette couldn't answer them
// all. Its recaps pass the checks in code as a careful model's would.
//
// A Worker's entry may export only handlers and classes, so the scenario lives in e2e-scenario.ts.
//
// Only development and test runs use this entry; production deploys `src/index.ts`, which never
// imports `@earshot/agent/testing` or `@earshot/evals` (they bundle the cassettes), and the
// bundle check fails if either reaches it.

import {
  CASSETTES,
  type Cassette,
  createCassetteFetch,
  scriptedRecapFetch,
} from "@earshot/agent/testing";
import type { LlmProvider } from "@earshot/core";
import { debriefAt } from "@earshot/evals";
import { evalCassette } from "@earshot/evals/cassettes";
import { PRICE_TABLE_DATE, priceStt } from "@earshot/voice/prices";
import { productionAgent, withRecapFetch, withTurnFetch } from "./agent";
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

/** The cassette for a turn in a session that started at `callTime`: its eval script's, or the demo's. */
export function turnCassette(provider: LlmProvider, callTime: string): Cassette {
  const script = debriefAt(callTime);
  return script ? evalCassette(provider, script.id) : demoCassette(provider);
}

export class SessionDO extends SessionRuntime {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      // A fresh cassette fetch per turn, so each turn replays its own interaction; the recap's
      // requests go to the scripted recap model.
      agent: withRecapFetch(
        withTurnFetch(productionAgent, (provider, turn) =>
          createCassetteFetch(turnCassette(provider, turn.callTime)),
        ),
        (provider) => scriptedRecapFetch({ provider }) as typeof fetch,
      ),
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
