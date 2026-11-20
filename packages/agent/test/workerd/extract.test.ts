// The workerd smoke test (spec WP5 step 8): the extractor, both AI SDK 7 adapters, and runTurn,
// inside workerd with the edge Worker's compatibility date and flags (see vitest.config.ts),
// answering from cassettes. Vercel doesn't say AI SDK 7 runs in Workers; this is the evidence.
// From Phase 4 (WP8) runTurn also runs the understanding step, so the turn below loads and runs
// chrono-node (the due date's reading) and double-metaphone (the linker's codes) in workerd.
import { ProposalCreatedV2, TurnCompletedV1, UsageRecordedV1 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { createProposalExtractor } from "../../src/extractor";
import { cassette, createCassetteFetch, SCENARIO_API_KEY, scenario } from "../../src/testing";
import { runTurn } from "../../src/turn";

describe("in workerd", () => {
  it("is really running in workerd", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });

  it("runs chrono-node and double-metaphone through the understanding step", async () => {
    const { resolveDate } = await import("@earshot/understanding/normalize");
    const { sameSound, wordCodes } = await import("@earshot/understanding/names");
    // A wrong due date is replaced by the reading chrono-node gives "by Thursday".
    expect(
      resolveDate("by Thursday", "2026-11-10T19:15:00.000Z", "America/Los_Angeles"),
    ).toMatchObject({
      readings: ["2026-11-12"],
      certain: true,
    });
    expect(sameSound(wordCodes("Knight"), wordCodes("Nite"))).toBe(true);
    expect(sameSound(wordCodes("Atmas"), wordCodes("Atlas"))).toBe(false);
  });

  for (const provider of ["anthropic", "groq"] as const) {
    it(`${provider}: extracts the demo task turn from a cassette`, async () => {
      const fetch = createCassetteFetch(cassette(provider, "demo-turn-4"));
      const result = await runTurn({
        extractor: createProposalExtractor({ provider, fetch }),
        ...scenario(provider, "demo-turn-4").turn,
        apiKey: SCENARIO_API_KEY,
        signal: new AbortController().signal,
      });
      expect(fetch.misses).toEqual([]);
      expect(result.outcome).toBe("proposals");
      const [proposal] = result.proposals;
      expect(proposal).toMatchObject({
        type: "task",
        // "Dana" sounds like Donna Lee and Dana Li: double-metaphone's codes, in workerd.
        target: { decision: "ask", kind: "contact", mention: { quote: "Dana" } },
        fields: {
          title: {
            value: "Send Dana the pricing breakdown",
            evidence: { audioMs: [21150, 23790] },
          },
          dueDate: { value: "2026-11-12" },
        },
        riskFlags: [{ kind: "ambiguous_target", field: "target" }],
        linker: "linker.v1",
      });
      ProposalCreatedV2.parse(proposal);
      UsageRecordedV1.parse(result.usage);
      TurnCompletedV1.parse(result.completed);
    });
  }

  it("groq: retries invalid output (a 400 tool_use_failed) and succeeds", async () => {
    const fetch = createCassetteFetch(cassette("groq", "tool-use-failed-then-valid"));
    const result = await runTurn({
      extractor: createProposalExtractor({ provider: "groq", fetch }),
      ...scenario("groq", "tool-use-failed-then-valid").turn,
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ outcome: "proposals", completed: { attempts: 2 } });
  });

  it("anthropic: waits out a 429's Retry-After on a real timer, then succeeds", async () => {
    const fetch = createCassetteFetch(cassette("anthropic", "rate-limited-then-ok"));
    const started = Date.now();
    const result = await runTurn({
      extractor: createProposalExtractor({ provider: "anthropic", fetch }),
      ...scenario("anthropic", "rate-limited-then-ok").turn,
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ outcome: "proposals", completed: { attempts: 2 } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });

  it("anthropic: the turn's deadline aborts a slow call as a timeout", async () => {
    const recorded = cassette("anthropic", "demo-turn-4");
    const fetch = createCassetteFetch({
      ...recorded,
      interactions: recorded.interactions.map((interaction) => ({
        ...interaction,
        response: { ...interaction.response, delayMs: 5_000 },
      })),
    });
    const result = await runTurn({
      extractor: createProposalExtractor({ provider: "anthropic", fetch }),
      ...scenario("anthropic", "demo-turn-4").turn,
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
      retry: { maxAttempts: 3, deadlineMs: 100, baseDelayMs: 10, maxDelayMs: 10 },
    });
    expect(result).toMatchObject({ outcome: "provider_error", failure: { detail: "timeout" } });
  });
});
