// The edge Worker for end-to-end runs and local development without LLM keys (spec WP11 step 4):
// the same Worker, with turn extraction answered from `@earshot/agent`'s committed cassettes, so
// nothing reaches a provider. `pnpm --filter @earshot/edge dev:e2e` serves it.
//
// Only development and test runs use this entry; production deploys `src/index.ts`, which never
// imports `@earshot/agent/testing` (it bundles the cassettes).

import { CASSETTES, type Cassette, createCassetteFetch } from "@earshot/agent/testing";
import type { LlmProvider } from "@earshot/core";
import { productionAgent, withFetch } from "./agent";
import { PRICE_TABLE_DATE, priceStt } from "./prices";
import { queueSink } from "./queue";
import { SessionRuntime } from "./session-do";

export { default } from "./index";

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
