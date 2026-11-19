import { describe, expect, it } from "vitest";
import { createProposalExtractor } from "../src/extractor";
import { cassette, createCassetteFetch, SCENARIO_API_KEY, scenario } from "../src/testing";
import { runTurn, sessionErrorFor, TURN_OUTCOMES } from "../src/turn";
import { counter, expectValidPayloads } from "./helpers";

const task = scenario("anthropic", "demo-turn-4");

/** A cassette fetch whose answers wait `delayMs`, abortably. */
function slowFetch(delayMs: number) {
  const recorded = cassette("anthropic", "demo-turn-4");
  return createCassetteFetch({
    ...recorded,
    interactions: recorded.interactions.map((interaction) => ({
      ...interaction,
      response: { ...interaction.response, delayMs },
    })),
  });
}

describe("runTurn", () => {
  it("makes no call for a turn without utterances", async () => {
    const fetch = createCassetteFetch({ name: "empty", description: "", interactions: [] });
    const result = await runTurn({
      extractor: createProposalExtractor({ provider: "anthropic", fetch }),
      ...task.turn,
      utterances: [],
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      outcome: "nothing_to_propose",
      proposals: [],
      usage: null,
      completed: { utteranceIds: [], attempts: 0, llmMs: 0 },
      error: null,
    });
    expect(fetch.played).toBe(0);
    expectValidPayloads(result);
  });

  it("is cancelled when the caller aborts before or during the call", async () => {
    const before = new AbortController();
    before.abort();
    const early = await runTurn({
      extractor: createProposalExtractor({ provider: "anthropic", fetch: slowFetch(0) }),
      ...task.turn,
      apiKey: SCENARIO_API_KEY,
      signal: before.signal,
    });
    expect(early.outcome).toBe("cancelled");
    expect(early.completed.attempts).toBe(0);

    const during = new AbortController();
    const turn = runTurn({
      extractor: createProposalExtractor({ provider: "anthropic", fetch: slowFetch(5_000) }),
      ...task.turn,
      apiKey: SCENARIO_API_KEY,
      signal: during.signal,
    });
    setTimeout(() => during.abort(), 20);
    const result = await turn;
    expect(result).toMatchObject({ outcome: "cancelled", error: null, usage: null });
    expect(result.failure?.code).toBe("cancelled");
    expectValidPayloads(result);
  });

  it("ends with a provider timeout when the turn's deadline passes mid-call", async () => {
    const result = await runTurn({
      extractor: createProposalExtractor({ provider: "anthropic", fetch: slowFetch(5_000) }),
      ...task.turn,
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
      retry: { maxAttempts: 3, deadlineMs: 50, baseDelayMs: 10, maxDelayMs: 10 },
    });
    expect(result).toMatchObject({
      outcome: "provider_error",
      error: { code: "llm_unavailable", retryable: false },
      failure: { code: "provider_error", detail: "timeout" },
      completed: { attempts: 1 },
    });
  });

  it("is cancelled when the caller aborts during a backoff", async () => {
    const controller = new AbortController();
    const fetch = createCassetteFetch(cassette("anthropic", "rate-limited-then-ok"));
    const result = await runTurn({
      extractor: createProposalExtractor({ provider: "anthropic", fetch }),
      ...scenario("anthropic", "rate-limited-then-ok").turn,
      apiKey: SCENARIO_API_KEY,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    });
    expect(result.outcome).toBe("cancelled");
    expect(result.completed.attempts).toBe(1);
    expect(fetch.played).toBe(1);
  });

  it("sums latency, usage, and cost over every call, and mints an id per proposal", async () => {
    let clock = 0;
    const fetch = createCassetteFetch(cassette("anthropic", "invalid-then-valid"));
    const ids = counter();
    const result = await runTurn({
      extractor: createProposalExtractor({
        provider: "anthropic",
        fetch,
        now: () => {
          clock += 300; // each read of the clock is 300 ms later
          return clock;
        },
      }),
      ...scenario("anthropic", "invalid-then-valid").turn,
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
      newId: ids,
    });
    expect(result.completed.llmMs).toBe(600); // two calls, 300 ms each
    expect(result.usage).toMatchObject({
      inputTokens: 1474 + 1538,
      outputTokens: 142 + 139,
      costUsd: 0.0004417, // 0.0002184 + 0.0002233: each call priced on its own
    });
    expect(result.proposals.map((proposal) => proposal.proposalId)).toEqual([
      "01a1c6e5-0000-7000-8000-000000000001",
    ]);
    expect(result.usage?.usageId).toBe("01a1c6e5-0000-7000-8000-000000000002");
    expectValidPayloads(result);
  });
});

describe("outcomes and session errors", () => {
  it("maps every failure to a turn outcome", () => {
    expect(TURN_OUTCOMES).toEqual({
      invalid_output: "invalid_output",
      key_rejected: "provider_error",
      rate_limited: "rate_limited",
      provider_error: "provider_error",
      refused: "provider_error",
      cancelled: "cancelled",
    });
  });

  it("tells the client about provider failures only", () => {
    expect(sessionErrorFor({ code: "key_rejected", retryable: false })).toEqual({
      code: "llm_key_rejected",
      retryable: false,
    });
    expect(sessionErrorFor({ code: "rate_limited", retryable: true })).toEqual({
      code: "llm_rate_limited",
      retryable: true,
    });
    expect(sessionErrorFor({ code: "provider_error", retryable: true })).toEqual({
      code: "llm_unavailable",
      retryable: true,
    });
    expect(sessionErrorFor({ code: "refused", retryable: false })).toEqual({
      code: "llm_unavailable",
      retryable: false,
    });
    expect(sessionErrorFor({ code: "invalid_output", retryable: false })).toBeNull();
    expect(sessionErrorFor({ code: "cancelled", retryable: false })).toBeNull();
  });
});
