// LLM prices for the cost meter.
//
// A local seam. The spec puts the dated price table in WP4's `@earshot/voice/prices` (§3, WP5
// step 6), which is being built alongside this package, so these are its LLM rows, copied from
// Appendix A. When that table lands, build `LLM_PRICES` from it here and delete the rows below;
// nothing outside this file reads them directly. The extractor takes any table through
// `ExtractorOptions.prices`.
import type { LlmProvider } from "@earshot/core";
import type { TokenUsage } from "./usage";

/** USD per million tokens. */
export interface LlmRates {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  /** Cache reads. When absent, cached tokens are priced as input, the conservative choice. */
  readonly cacheReadUsdPerMTok?: number;
  /** 5-minute cache writes. When absent, priced as input. */
  readonly cacheWriteUsdPerMTok?: number;
}

export interface LlmPriceRow extends LlmRates {
  readonly provider: LlmProvider;
  readonly model: string;
  /**
   * A second rate card for long prompts, applied per call when the call's input tokens (cache
   * reads and writes included) exceed `aboveInputTokens`.
   */
  readonly longPrompt?: LlmRates & { readonly aboveInputTokens: number };
  /** When the row was last checked against the provider's pricing page (`YYYY-MM-DD`). */
  readonly checkedAt: string;
}

export interface LlmPriceTable {
  /** The table's date, which `usage.recorded.priceTable` records (`YYYY-MM-DD`). */
  readonly date: string;
  readonly rows: readonly LlmPriceRow[];
}

/** The LLM rows of the Phase 3 price table (spec Appendix A, checked 2026-11-15). */
export const LLM_PRICES: LlmPriceTable = {
  date: "2026-11-15",
  rows: [
    {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputUsdPerMTok: 0.1,
      outputUsdPerMTok: 0.5,
      cacheReadUsdPerMTok: 0.01,
      cacheWriteUsdPerMTok: 0.125,
      longPrompt: {
        aboveInputTokens: 100_000,
        inputUsdPerMTok: 0.5,
        outputUsdPerMTok: 2.5,
        cacheReadUsdPerMTok: 0.05,
        cacheWriteUsdPerMTok: 0.625,
      },
      checkedAt: "2026-11-15",
    },
    {
      // Groq's cached-token price isn't in the research notes, so cached tokens price as input.
      provider: "groq",
      model: "openai/gpt-oss-20b",
      inputUsdPerMTok: 0.075,
      outputUsdPerMTok: 0.3,
      checkedAt: "2026-11-15",
    },
  ],
};

export function findLlmPrice(
  table: LlmPriceTable,
  provider: LlmProvider,
  model: string,
): LlmPriceRow | undefined {
  return table.rows.find((row) => row.provider === provider && row.model === model);
}

/** Costs are kept to the nano-dollar: fine enough for one cached token at $0.01 per million. */
export function roundUsd(usd: number): number {
  return Math.round(usd * 1e9) / 1e9;
}

/**
 * What one call's usage cost, in USD. Uncached input, cache reads, cache writes, and output each
 * get their own rate; reasoning tokens are already inside `outputTokens`.
 */
export function llmCostUsd(usage: TokenUsage, row: LlmPriceRow): number {
  const rates: LlmRates =
    row.longPrompt && usage.inputTokens > row.longPrompt.aboveInputTokens ? row.longPrompt : row;
  const uncached = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens,
  );
  const microUsd =
    uncached * rates.inputUsdPerMTok +
    usage.cachedInputTokens * (rates.cacheReadUsdPerMTok ?? rates.inputUsdPerMTok) +
    usage.cacheWriteTokens * (rates.cacheWriteUsdPerMTok ?? rates.inputUsdPerMTok) +
    usage.outputTokens * rates.outputUsdPerMTok;
  return roundUsd(microUsd / 1_000_000);
}
