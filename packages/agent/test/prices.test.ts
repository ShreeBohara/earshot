import { UsageRecordedV1 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { LLM_MODELS } from "../src/extractor";
import { findLlmPrice, LLM_PRICES, type LlmPriceRow, llmCostUsd, roundUsd } from "../src/prices";
import { ZERO_USAGE } from "../src/usage";

function row(provider: "anthropic" | "groq"): LlmPriceRow {
  const found = findLlmPrice(LLM_PRICES, provider, LLM_MODELS[provider]);
  if (!found) throw new Error(`no price for ${provider}`);
  return found;
}

const usage = (counts: Partial<typeof ZERO_USAGE>) => ({ ...ZERO_USAGE, ...counts });

describe("llmCostUsd", () => {
  it("prices Haiku 5.5 at $0.10 in and $0.50 out per million tokens", () => {
    // The spec's per-debrief estimate: 1,500 in and 300 out.
    expect(llmCostUsd(usage({ inputTokens: 1500, outputTokens: 300 }), row("anthropic"))).toBe(
      0.0003,
    );
  });

  it("prices gpt-oss-20b at $0.075 in and $0.30 out, reasoning inside output", () => {
    expect(
      llmCostUsd(
        usage({ inputTokens: 1500, outputTokens: 300, reasoningTokens: 120 }),
        row("groq"),
      ),
    ).toBe(0.0002025);
  });

  it("prices cache reads and writes separately from uncached input", () => {
    // core's UsageRecordedV1.llm-with-cache fixture: 1,520 in, 1,024 of them cached, 284 out.
    expect(
      llmCostUsd(
        usage({ inputTokens: 1520, cachedInputTokens: 1024, outputTokens: 284 }),
        row("anthropic"),
      ),
    ).toBe(0.00020184);
    // 500 uncached, 1,500 written to the cache at $0.125, 300 out.
    expect(
      llmCostUsd(
        usage({ inputTokens: 2000, cacheWriteTokens: 1500, outputTokens: 300 }),
        row("anthropic"),
      ),
    ).toBe(0.0003875);
  });

  it("prices cached tokens as input when the row has no cache price (Groq)", () => {
    const withCache = usage({ inputTokens: 1500, cachedInputTokens: 1000, outputTokens: 300 });
    const without = usage({ inputTokens: 1500, outputTokens: 300 });
    expect(llmCostUsd(withCache, row("groq"))).toBe(llmCostUsd(without, row("groq")));
  });

  it("switches Haiku to its long-prompt rates above 100k input tokens, per call", () => {
    expect(llmCostUsd(usage({ inputTokens: 100_000 }), row("anthropic"))).toBe(0.01);
    expect(llmCostUsd(usage({ inputTokens: 100_001 }), row("anthropic"))).toBe(0.0500005);
  });

  it("costs nothing for no tokens, and keeps nano-dollar precision", () => {
    expect(llmCostUsd(ZERO_USAGE, row("anthropic"))).toBe(0);
    expect(llmCostUsd(usage({ cachedInputTokens: 1, inputTokens: 1 }), row("anthropic"))).toBe(
      1e-8,
    );
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
  });
});

describe("LLM_PRICES", () => {
  it("has a dated row for every model the adapters run", () => {
    for (const provider of ["anthropic", "groq"] as const) {
      expect(row(provider).checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(UsageRecordedV1.shape.priceTable.safeParse(LLM_PRICES.date).success).toBe(true);
  });
});
