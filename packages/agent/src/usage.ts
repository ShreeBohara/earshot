// Token usage for one extraction, summed over its attempts, in the shape `usage.recorded` needs.
import type { LanguageModelUsage } from "ai";

export interface TokenUsage {
  /** Every input token, cache reads and writes included (`usage.recorded.inputTokens`). */
  readonly inputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  readonly cachedInputTokens: number;
  /** Input tokens written to the prompt cache. Anthropic bills them at 1.25x. */
  readonly cacheWriteTokens: number;
  /** Every output token, reasoning included: reasoning bills as output. */
  readonly outputTokens: number;
  /** The output tokens that were hidden reasoning (gpt-oss), for the latency and cost reports. */
  readonly reasoningTokens: number;
}

export const ZERO_USAGE: TokenUsage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

/** The AI SDK's usage for one call, with absent counts as 0. */
export function fromSdkUsage(usage: LanguageModelUsage | undefined): TokenUsage {
  const count = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  return {
    inputTokens: count(usage?.inputTokens),
    cachedInputTokens: count(usage?.inputTokenDetails?.cacheReadTokens),
    cacheWriteTokens: count(usage?.inputTokenDetails?.cacheWriteTokens),
    outputTokens: count(usage?.outputTokens),
    reasoningTokens: count(usage?.outputTokenDetails?.reasoningTokens),
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/** True if any call reported tokens: something was billed. */
export function hasTokens(usage: TokenUsage): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0;
}
