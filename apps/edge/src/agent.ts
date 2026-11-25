// The seam between SessionDO and turn extraction, `@earshot/agent` (Phase 3 WP5). SessionDO
// calls exactly what the package exports:
//
//   const extractor = agent.createProposalExtractor({ provider, model, gateway: agent.aiGatewayFromEnv(env) });
//   const result = await agent.runTurn({ extractor, turnId, utterances, entities, callTime, timeZone,
//     apiKey: message.key, signal, onWorking });
//
// Production passes the package itself. Tests and `src/e2e.ts` pass the same functions with a
// cassette `fetch` from `@earshot/agent/testing` (`withFetch`), so no test reaches a provider.
// Production code never imports `@earshot/agent/testing`: it bundles the cassettes.
import {
  aiGatewayFromEnv,
  createProposalExtractor,
  createRecapper,
  type ExtractorOptions,
  type ProposalExtractor,
  type Recapper,
  type RecapperOptions,
  type RecapResult,
  type RunRecapInput,
  type RunTurnInput,
  runRecap,
  runTurn,
  type TurnResult,
} from "@earshot/agent";

export type { RecapResult, TurnResult, WorkingState } from "@earshot/agent";

/** The parts of `@earshot/agent` SessionDO uses. */
export interface TurnAgent {
  /** Throws a RangeError for a model the package has no adapter or price for. */
  createProposalExtractor(options: ExtractorOptions): ProposalExtractor;
  /** Never throws for a provider or validation failure: those become outcomes. */
  runTurn(input: RunTurnInput): Promise<TurnResult>;
  /** The recap's (Phase 5 WP10): throws a RangeError for a model with no adapter or price. */
  createRecapper(options: RecapperOptions): Recapper;
  /** Never throws for a provider or validation failure: each is a failed `recap.created`. */
  runRecap(input: RunRecapInput): Promise<RecapResult>;
  aiGatewayFromEnv: typeof aiGatewayFromEnv;
}

/** `@earshot/agent` as it ships: straight to the provider, or through AI Gateway when set. */
export const productionAgent: TurnAgent = {
  createProposalExtractor,
  runTurn,
  createRecapper,
  runRecap,
  aiGatewayFromEnv,
};

/** What a per-turn `fetch` may be chosen by: the turn's own session context. */
export interface TurnContext {
  readonly callTime: string;
  readonly timeZone: string;
}

/**
 * The same agent with every turn's provider request going to `fetchFor(provider)` instead of the
 * network: a cassette in tests and e2e runs. The recap's go to `recapFetchFor` (the scripted
 * recap model there, since every test's session says something else), or to `fetchFor`.
 */
export function withFetch(
  agent: TurnAgent,
  fetchFor: (provider: ExtractorOptions["provider"]) => typeof fetch,
  recapFetchFor: (provider: RecapperOptions["provider"]) => typeof fetch = fetchFor,
): TurnAgent {
  return {
    ...agent,
    createProposalExtractor: (options) =>
      agent.createProposalExtractor({ ...options, fetch: fetchFor(options.provider) }),
    createRecapper: (options) =>
      agent.createRecapper({ ...options, fetch: recapFetchFor(options.provider) }),
  };
}

/** The same agent with the recap's provider requests going to `fetchFor(provider)`. */
export function withRecapFetch(
  agent: TurnAgent,
  fetchFor: (provider: RecapperOptions["provider"]) => typeof fetch,
): TurnAgent {
  return {
    ...agent,
    createRecapper: (options) =>
      agent.createRecapper({ ...options, fetch: fetchFor(options.provider) }),
  };
}

/**
 * Like `withFetch`, but the `fetch` is chosen when the turn runs, from its session context: the
 * e2e Worker answers each eval script's turns from that script's cassette, which it finds by the
 * session's call time. The extractor SessionDO created (which checked the model) is rebuilt with
 * the turn's `fetch`, so each turn gets a fresh one.
 */
export function withTurnFetch(
  agent: TurnAgent,
  fetchFor: (provider: ExtractorOptions["provider"], turn: TurnContext) => typeof fetch,
): TurnAgent {
  const created = new WeakMap<ProposalExtractor, ExtractorOptions>();
  return {
    ...agent,
    createProposalExtractor: (options) => {
      const extractor = agent.createProposalExtractor(options);
      created.set(extractor, options);
      return extractor;
    },
    runTurn: (input) => {
      const options = created.get(input.extractor);
      if (!options) return agent.runTurn(input);
      const fetch = fetchFor(options.provider, input);
      return agent.runTurn({
        ...input,
        extractor: agent.createProposalExtractor({ ...options, fetch }),
      });
    },
  };
}
