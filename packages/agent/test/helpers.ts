import {
  type LlmProvider,
  ProposalCreatedV1,
  TurnCompletedV1,
  UsageRecordedV1,
} from "@earshot/core";
import { expect } from "vitest";
import { createProposalExtractor } from "../src/extractor";
import { cassette, createCassetteFetch, SCENARIO_API_KEY, scenario } from "../src/testing";
import { type RunTurnInput, runTurn, type TurnResult, type WorkingState } from "../src/turn";

/** Ids that count up, so payloads are stable. */
export function counter(prefix = "01a1c6e5-0000-7000-8000-"): () => string {
  let n = 0;
  return () => `${prefix}${(++n).toString(16).padStart(12, "0")}`;
}

/** Replays one committed cassette through `runTurn`, recording waits and `working` states. */
export async function replay(
  provider: LlmProvider,
  name: string,
  overrides: Partial<RunTurnInput> = {},
) {
  const fixture = scenario(provider, name);
  const fetch = createCassetteFetch(cassette(provider, name));
  const sleeps: number[] = [];
  const working: WorkingState[] = [];
  const result = await runTurn({
    extractor: createProposalExtractor({ provider, fetch }),
    ...fixture.turn,
    apiKey: SCENARIO_API_KEY,
    signal: new AbortController().signal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onWorking: (state) => working.push(state),
    newId: counter(),
    random: () => 0.5,
    ...overrides,
  });
  expect(fetch.misses, "requests the cassette couldn't answer").toEqual([]);
  expect(fetch.remaining(), "cassette interactions never played").toBe(0);
  return { result, fetch, sleeps, working };
}

/** Checks every payload against its `@earshot/core` contract, as the event registry will. */
export function expectValidPayloads(result: TurnResult): void {
  for (const proposal of result.proposals) ProposalCreatedV1.parse(proposal);
  if (result.usage) UsageRecordedV1.parse(result.usage);
  TurnCompletedV1.parse(result.completed);
}
