import { UsageRecordedV1 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  findLlmPrice,
  findSttPrice,
  formatUsd,
  LLM_PRICES,
  PRICE_TABLE_DATE,
  PRICES,
  priceLlm,
  priceStt,
  STT_PRICES,
} from "../src/prices";
import { createAssemblyAiAdapter } from "../src/stt/assemblyai";
import { createDeepgramFluxAdapter } from "../src/stt/deepgram-flux";
import { createDeepgramNova3Adapter } from "../src/stt/deepgram-nova3";
import { createFakeSttAdapter } from "../src/testing/fake-stt";

const MINUTE = 60_000;

describe("speech-to-text prices", () => {
  it("bills AssemblyAI on socket time at $0.15/hr plus $0.04/hr for keyterms (spec §6: 2.5 min ≈ $0.0079)", () => {
    const result = priceStt({
      provider: "assemblyai",
      model: "universal-streaming-english",
      audioMs: 1 * MINUTE,
      socketMs: 2.5 * MINUTE,
    });
    expect(result).toEqual({ ok: true, costUsd: 0.007916667, priceTable: "2026-11-20" });
  });

  it("drops the keyterm add-on when no keyterms were sent", () => {
    const result = priceStt({
      provider: "assemblyai",
      model: "universal-streaming-english",
      audioMs: 0,
      socketMs: 60 * MINUTE,
      keyterms: false,
    });
    expect(result).toMatchObject({ ok: true, costUsd: 0.15 });
  });

  it("prices Deepgram at the promo $0.0048/min plus $0.0013/min keyterms, on socket time until WP1 says", () => {
    const nova3 = priceStt({
      provider: "deepgram",
      model: "nova-3",
      audioMs: 1 * MINUTE,
      socketMs: 2 * MINUTE,
    });
    expect(nova3).toMatchObject({ ok: true, costUsd: 0.0122 });
    const flux = priceStt({
      provider: "deepgram",
      model: "flux-general-en",
      audioMs: 0,
      socketMs: 1 * MINUTE,
    });
    expect(flux).toMatchObject({ ok: true, costUsd: 0.0078 });
    expect(findSttPrice("deepgram", "nova-3")?.billedOn).toBe("socket");
  });

  it("prices the second witness, Groq Whisper turbo, at $0.04/hr of audio with 10 s billed at least per request", () => {
    const price = findSttPrice("groq", "whisper-large-v3-turbo");
    expect(price).toMatchObject({
      usdPerHour: 0.04,
      keytermUsdPerHour: 0,
      billedOn: "audio",
      minBilledMsPerRequest: 10_000,
    });
    // A 3 s turn bills 10 s; a 15 s turn bills 15 s. Socket time means nothing to a batch request.
    const short = priceStt({
      provider: "groq",
      model: "whisper-large-v3-turbo",
      audioMs: 3_000,
      socketMs: 0,
    });
    expect(short).toEqual({ ok: true, costUsd: 0.000111111, priceTable: PRICE_TABLE_DATE });
    const long = priceStt({
      provider: "groq",
      model: "whisper-large-v3-turbo",
      audioMs: 15_000,
      socketMs: 99_000,
    });
    expect(long).toMatchObject({ ok: true, costUsd: 0.000166667 });
    // Spec §4.7: a 2-minute debrief's turns bill about 100–120 s, about $0.0012.
    const debrief = [12_000, 30_000, 8_000, 45_000, 6_000].reduce((sum, audioMs) => {
      const turn = priceStt({
        provider: "groq",
        model: "whisper-large-v3-turbo",
        audioMs,
        socketMs: 0,
      });
      return sum + (turn.ok ? turn.costUsd : Number.NaN);
    }, 0);
    expect(debrief).toBeCloseTo((107_000 / 3_600_000) * 0.04, 8);
    // The other rows have no minimum: a short AssemblyAI socket bills what it was open.
    expect(findSttPrice("assemblyai", "universal-streaming-english")?.minBilledMsPerRequest).toBe(
      undefined,
    );
  });

  it("prices the fake at zero, so dev and CI sessions meter cleanly", () => {
    expect(
      priceStt({ provider: "fake", model: "fake", audioMs: MINUTE, socketMs: MINUTE }),
    ).toMatchObject({
      ok: true,
      costUsd: 0,
    });
  });

  it("has a row for every adapter's provider and model", () => {
    const adapters = [
      createAssemblyAiAdapter(),
      createDeepgramNova3Adapter(),
      createDeepgramFluxAdapter(),
      createFakeSttAdapter({ script: { turns: [] } }),
    ];
    for (const adapter of adapters)
      expect(findSttPrice(adapter.provider, adapter.model)).toBeDefined();
  });
});

describe("LLM prices", () => {
  it("prices Haiku 5.5 at $0.10/$0.50 per 1M tokens (spec: 1,500 in, 300 out ≈ $0.00030)", () => {
    const result = priceLlm({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 1_500,
      outputTokens: 300,
    });
    expect(result).toEqual({ ok: true, costUsd: 0.0003, priceTable: PRICE_TABLE_DATE });
  });

  it("prices gpt-oss-20b on Groq at $0.075/$0.30 (spec ≈ $0.00020)", () => {
    const result = priceLlm({
      provider: "groq",
      model: "openai/gpt-oss-20b",
      inputTokens: 1_500,
      outputTokens: 300,
    });
    expect(result).toMatchObject({ ok: true, costUsd: 0.0002025 });
  });

  it("prices cache hits and writes separately where the provider does, and as input elsewhere", () => {
    const haiku = priceLlm({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 2_000,
      cachedInputTokens: 1_000,
      cacheWriteInputTokens: 500,
      outputTokens: 0,
    });
    // 500 uncached at 0.10, 1,000 cached at 0.01, 500 written at 0.125, per 1M.
    expect(haiku).toMatchObject({
      ok: true,
      costUsd: (500 * 0.1 + 1_000 * 0.01 + 500 * 0.125) / 1e6,
    });
    const groq = priceLlm({
      provider: "groq",
      model: "openai/gpt-oss-20b",
      inputTokens: 1_000,
      cachedInputTokens: 1_000,
      outputTokens: 0,
    });
    expect(groq).toMatchObject({ ok: true, costUsd: 0.000075 });
  });

  it("caps cached tokens at the input count", () => {
    const result = priceLlm({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 100,
      cachedInputTokens: 500,
      outputTokens: 0,
    });
    expect(result).toMatchObject({ ok: true, costUsd: 0.000001 });
  });
});

describe("refusals and records", () => {
  it("refuses an unknown model and nonsense usage, rather than guessing", () => {
    expect(
      priceStt({ provider: "speechmatics", model: "linden-1", audioMs: 1, socketMs: 1 }),
    ).toEqual({
      ok: false,
      reason: "unknown_model",
    });
    expect(
      priceLlm({ provider: "openai", model: "gpt-6-luna", inputTokens: 1, outputTokens: 1 }),
    ).toEqual({
      ok: false,
      reason: "unknown_model",
    });
    expect(
      priceStt({
        provider: "assemblyai",
        model: "universal-streaming-english",
        audioMs: -1,
        socketMs: 0,
      }),
    ).toEqual({
      ok: false,
      reason: "invalid_usage",
    });
    expect(
      priceLlm({
        provider: "groq",
        model: "openai/gpt-oss-20b",
        inputTokens: Number.NaN,
        outputTokens: 0,
      }),
    ).toEqual({
      ok: false,
      reason: "invalid_usage",
    });
  });

  it("fills a valid usage.recorded payload", () => {
    const result = priceStt({
      provider: "deepgram",
      model: "nova-3",
      audioMs: 90_000,
      socketMs: 120_000,
    });
    if (!result.ok) throw new Error("expected a price");
    const payload = {
      usageId: "019a8f3e-0000-7000-8000-000000000001",
      kind: "stt",
      provider: "deepgram",
      model: "nova-3",
      audioMs: 90_000,
      socketMs: 120_000,
      costUsd: result.costUsd,
      priceTable: result.priceTable,
    };
    expect(UsageRecordedV1.parse(payload)).toEqual(payload);
  });

  it("dates every row, names its source, and never repeats a provider and model", () => {
    expect(PRICES).toHaveLength(STT_PRICES.length + LLM_PRICES.length);
    const keys = new Set<string>();
    for (const price of PRICES) {
      expect(price.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(price.source.length).toBeGreaterThan(0);
      const key = `${price.kind}:${price.provider}:${price.model}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    }
    expect(findLlmPrice("groq", "openai/gpt-oss-120b")?.outputUsdPerMTok).toBe(0.6);
  });
});

describe("formatUsd", () => {
  it("formats the meter's figure", () => {
    expect(formatUsd(0.011)).toBe("$0.011");
    expect(formatUsd(0.0122)).toBe("$0.012");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.00004)).toBe("<$0.0001");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });
});
