// The live eval's guards (spec WP11 step 8; ADR-0026's cost policy). Only `eval-live` spends
// money, and it's off by default. Before it starts, the budget guard estimates the run's spend
// from the fixtures' durations, the price table, and the provider pairs, and refuses to start
// above `EVAL_LIVE_BUDGET_USD`. While it runs, it opens at most 5 new AssemblyAI streams a minute,
// the free tier's limit.
import { priceLlm, priceStt } from "@earshot/voice/prices";

export interface ProviderModel {
  readonly provider: string;
  readonly model: string;
}

export interface LivePair {
  readonly stt: ProviderModel;
  readonly llm: ProviderModel;
}

/** The four pairs the gate compares (G1b): each speech-to-text default with each LLM. */
export const LIVE_PAIRS: readonly LivePair[] = [
  {
    stt: { provider: "assemblyai", model: "universal-streaming-english" },
    llm: { provider: "groq", model: "openai/gpt-oss-20b" },
  },
  {
    stt: { provider: "assemblyai", model: "universal-streaming-english" },
    llm: { provider: "anthropic", model: "claude-haiku-5-5" },
  },
  {
    stt: { provider: "deepgram", model: "nova-3" },
    llm: { provider: "groq", model: "openai/gpt-oss-20b" },
  },
  {
    stt: { provider: "deepgram", model: "nova-3" },
    llm: { provider: "anthropic", model: "claude-haiku-5-5" },
  },
];

export const pairName = (pair: LivePair) =>
  `${pair.stt.provider}/${pair.stt.model} + ${pair.llm.provider}/${pair.llm.model}`;

function providerModel(text: string, where: string): ProviderModel {
  const at = text.indexOf(":");
  if (at <= 0 || at === text.length - 1) {
    throw new Error(`${where}: expected provider:model, got ${JSON.stringify(text)}`);
  }
  return { provider: text.slice(0, at).trim(), model: text.slice(at + 1).trim() };
}

/**
 * Pairs from `EVAL_LIVE_PAIRS`: comma-separated `stt-provider:model+llm-provider:model`, such
 * as `assemblyai:universal-streaming-english+groq:openai/gpt-oss-20b`. Empty means all four.
 */
export function parsePairs(text: string | undefined): LivePair[] {
  if (!text?.trim()) return [...LIVE_PAIRS];
  return text.split(",").map((item, index) => {
    const [stt, llm, extra] = item.split("+");
    if (!stt || !llm || extra !== undefined) {
      throw new Error(`pair ${index + 1}: expected stt+llm, got ${JSON.stringify(item)}`);
    }
    return {
      stt: providerModel(stt.trim(), `pair ${index + 1}`),
      llm: providerModel(llm.trim(), `pair ${index + 1}`),
    };
  });
}

/**
 * The estimate's assumptions. The eval cassettes put a turn at about 3,600 input tokens (the
 * prompt, the demo CRM's 250 records, the transcript) and 90 to 140 output tokens; the guard
 * assumes 4,000 and 400 (reasoning bills as output), then adds a quarter to the total. An engine
 * keeps its speech socket open 20 s after the last release, and a socket-billed provider bills
 * that too. All 30 scripts on the four pairs come to about $0.90 this way, inside the default
 * $1.00 budget, as the spec's estimate for a gate run has it.
 */
export const LIVE_ESTIMATE = {
  inputTokensPerTurn: 4_000,
  outputTokensPerTurn: 400,
  socketTailMs: 25_000,
  safetyFactor: 1.25,
} as const;

export interface LiveFixture {
  readonly script: string;
  readonly durationMs: number;
  readonly turns: number;
}

export interface PairEstimate {
  readonly pair: LivePair;
  readonly sttUsd: number;
  readonly llmUsd: number;
  readonly totalUsd: number;
}

export interface SpendEstimate {
  readonly pairs: readonly PairEstimate[];
  readonly totalUsd: number;
}

const cents = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** What a live run of every fixture on every pair should cost at most, from the price table. */
export function estimateLiveSpend(
  fixtures: readonly LiveFixture[],
  pairs: readonly LivePair[],
): SpendEstimate {
  const { inputTokensPerTurn, outputTokensPerTurn, socketTailMs, safetyFactor } = LIVE_ESTIMATE;
  const estimates = pairs.map((pair) => {
    let stt = 0;
    let llm = 0;
    for (const fixture of fixtures) {
      const sttPrice = priceStt({
        provider: pair.stt.provider,
        model: pair.stt.model,
        audioMs: fixture.durationMs,
        socketMs: fixture.durationMs + socketTailMs,
      });
      if (!sttPrice.ok) throw new Error(`no price for ${pair.stt.provider}/${pair.stt.model}`);
      const llmPrice = priceLlm({
        provider: pair.llm.provider,
        model: pair.llm.model,
        inputTokens: inputTokensPerTurn * fixture.turns,
        outputTokens: outputTokensPerTurn * fixture.turns,
      });
      if (!llmPrice.ok) throw new Error(`no price for ${pair.llm.provider}/${pair.llm.model}`);
      stt += sttPrice.costUsd;
      llm += llmPrice.costUsd;
    }
    const sttUsd = cents(stt * safetyFactor);
    const llmUsd = cents(llm * safetyFactor);
    return { pair, sttUsd, llmUsd, totalUsd: cents(sttUsd + llmUsd) };
  });
  return {
    pairs: estimates,
    totalUsd: cents(estimates.reduce((sum, estimate) => sum + estimate.totalUsd, 0)),
  };
}

/** `EVAL_LIVE_BUDGET_USD` as dollars; throws unless it's a positive number. */
export function parseBudget(text: string | undefined): number {
  const budget = Number(text);
  if (!text?.trim() || !Number.isFinite(budget) || budget <= 0) {
    throw new Error(
      `EVAL_LIVE_BUDGET_USD must be a positive number of dollars, not ${JSON.stringify(text ?? "")}`,
    );
  }
  return budget;
}

/** AssemblyAI's free tier: at most this many new streams in any minute. */
export const ASSEMBLYAI_STREAMS_PER_MINUTE = 5;

/**
 * How long to wait before opening another stream, given when the last ones opened, so no more
 * than `limit` open within any `windowMs`. 0 when one may open now.
 */
export function streamDelayMs(
  openedAt: readonly number[],
  now: number,
  limit = ASSEMBLYAI_STREAMS_PER_MINUTE,
  windowMs = 60_000,
): number {
  const recent = openedAt.filter((at) => now - at < windowMs).sort((a, b) => a - b);
  if (recent.length < limit) return 0;
  const oldest = recent[recent.length - limit] as number;
  return Math.max(0, oldest + windowMs - now);
}
