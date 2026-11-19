import { priceLlm, priceStt } from "@earshot/voice/prices";
import { describe, expect, it } from "vitest";
import {
  estimateLiveSpend,
  LIVE_ESTIMATE,
  LIVE_PAIRS,
  parseBudget,
  parsePairs,
  streamDelayMs,
} from "../src";

describe("parsePairs", () => {
  it("defaults to the gate's four pairs, and reads provider:model pairs with slashes in models", () => {
    expect(parsePairs(undefined)).toEqual(LIVE_PAIRS);
    expect(parsePairs("  ")).toEqual(LIVE_PAIRS);
    expect(parsePairs("assemblyai:universal-streaming-english+groq:openai/gpt-oss-20b")).toEqual([
      {
        stt: { provider: "assemblyai", model: "universal-streaming-english" },
        llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      },
    ]);
    expect(() => parsePairs("assemblyai+groq:x")).toThrow(/provider:model/);
    expect(() => parsePairs("a:b")).toThrow(/stt\+llm/);
    expect(() => parsePairs("a:b+c:d+e:f")).toThrow(/stt\+llm/);
  });
});

describe("estimateLiveSpend", () => {
  it("prices every fixture on every pair from the price table, plus the margin", () => {
    const fixtures = [
      { script: "d001", durationMs: 24_000, turns: 4 },
      { script: "d002", durationMs: 30_000, turns: 5 },
    ];
    const [pair] = LIVE_PAIRS;
    if (!pair) throw new Error("no pairs");
    const estimate = estimateLiveSpend(fixtures, [pair]);
    let expected = 0;
    for (const fixture of fixtures) {
      const stt = priceStt({
        ...pair.stt,
        audioMs: fixture.durationMs,
        socketMs: fixture.durationMs + LIVE_ESTIMATE.socketTailMs,
      });
      const llm = priceLlm({
        ...pair.llm,
        inputTokens: LIVE_ESTIMATE.inputTokensPerTurn * fixture.turns,
        outputTokens: LIVE_ESTIMATE.outputTokensPerTurn * fixture.turns,
      });
      if (!stt.ok || !llm.ok) throw new Error("unpriced");
      expected += stt.costUsd + llm.costUsd;
    }
    expect(estimate.totalUsd).toBeCloseTo(expected * LIVE_ESTIMATE.safetyFactor, 5);
    expect(estimate.pairs[0]?.totalUsd).toBe(estimate.totalUsd);
    // The whole gate run stays around the spec's "under $1" estimate, with the margin.
    const all = estimateLiveSpend(
      Array.from({ length: 30 }, (_, n) => ({ script: `d${n}`, durationMs: 26_000, turns: 4 })),
      LIVE_PAIRS,
    );
    expect(all.totalUsd).toBeGreaterThan(0.1);
    expect(all.totalUsd).toBeLessThan(5);
  });

  it("refuses a model the price table doesn't know", () => {
    expect(() =>
      estimateLiveSpend(
        [{ script: "d001", durationMs: 1_000, turns: 1 }],
        [{ stt: { provider: "nope", model: "x" }, llm: { provider: "groq", model: "x" } }],
      ),
    ).toThrow(/no price for nope\/x/);
  });
});

describe("parseBudget", () => {
  it("takes a positive dollar amount and nothing else", () => {
    expect(parseBudget("1.5")).toBe(1.5);
    for (const bad of [undefined, "", " ", "0", "-1", "lots", "NaN", "Infinity"]) {
      expect(() => parseBudget(bad)).toThrow(/EVAL_LIVE_BUDGET_USD/);
    }
  });
});

describe("streamDelayMs", () => {
  it("allows 5 new streams in any minute, then waits for the oldest to age out", () => {
    expect(streamDelayMs([], 0)).toBe(0);
    expect(streamDelayMs([0, 1_000, 2_000, 3_000], 4_000)).toBe(0);
    expect(streamDelayMs([0, 1_000, 2_000, 3_000, 4_000], 5_000)).toBe(55_000);
    expect(streamDelayMs([0, 1_000, 2_000, 3_000, 4_000], 60_000)).toBe(0);
    // Order doesn't matter, and streams older than a minute don't count.
    expect(streamDelayMs([4_000, 0, 3_000, 1_000, 2_000, -90_000], 30_000)).toBe(30_000);
    expect(streamDelayMs([10, 20, 30, 40, 50, 60], 100)).toBe(60_000 - 100 + 20);
  });
});
