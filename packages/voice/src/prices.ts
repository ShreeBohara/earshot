// `@earshot/voice/prices`: the dated price table behind the cost meter ("This debrief cost
// $0.011"). SessionDO prices each `usage` message and LLM call with it and writes the date into
// `usage.recorded.priceTable`, so an old cost can always be traced to the prices it used. Pure,
// with no DOM types: the edge Worker imports it, and test/no-dom.test.ts checks that.
//
// Prices are list prices in US dollars from spec Appendix A, checked 2026-11-15. Deepgram's are
// promotional, with no end date shown. Refresh the table, and its date, before Phase 8.

/** The date of this table, `usage.recorded.priceTable`. */
export const PRICE_TABLE_DATE = "2026-11-15";

/** What a speech-to-text provider bills: the time its socket is open, or the audio sent. */
export type BillingBasis = "socket" | "audio";

export interface SttPrice {
  readonly kind: "stt";
  readonly provider: string;
  readonly model: string;
  /** Per hour of billed time. */
  readonly usdPerHour: number;
  /** The keyterm add-on per hour. Earshot sends keyterms on every session. */
  readonly keytermUsdPerHour: number;
  readonly billedOn: BillingBasis;
  readonly checkedAt: string;
  readonly source: string;
  readonly note?: string;
}

export interface LlmPrice {
  readonly kind: "llm";
  readonly provider: string;
  readonly model: string;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  /** Prompt-cache hits. Without it, cached tokens bill as input. */
  readonly cachedInputUsdPerMTok?: number;
  /** Prompt-cache writes (Anthropic's 5-minute cache). */
  readonly cacheWriteUsdPerMTok?: number;
  readonly checkedAt: string;
  readonly source: string;
  readonly note?: string;
}

export type Price = SttPrice | LlmPrice;

export const STT_PRICES: readonly SttPrice[] = [
  {
    kind: "stt",
    provider: "assemblyai",
    model: "universal-streaming-english",
    usdPerHour: 0.15,
    keytermUsdPerHour: 0.04,
    billedOn: "socket",
    checkedAt: "2026-11-15",
    source: "assemblyai.com/pricing (page updated 2026-11-10)",
    note: "Billed on socket-open time, idle included.",
  },
  {
    kind: "stt",
    provider: "assemblyai",
    model: "universal-3-6-pro",
    usdPerHour: 0.45,
    keytermUsdPerHour: 0,
    billedOn: "socket",
    checkedAt: "2026-11-15",
    source: "assemblyai.com/pricing (page updated 2026-11-10)",
    note: "Keyterms included.",
  },
  {
    kind: "stt",
    provider: "deepgram",
    model: "nova-3",
    usdPerHour: 0.288,
    keytermUsdPerHour: 0.078,
    billedOn: "socket",
    checkedAt: "2026-11-15",
    source: "deepgram.com/pricing",
    note:
      "Promotional PAYG: $0.0048/min (was $0.0077), keyterms $0.0013/min. Deepgram doesn't say " +
      "whether it bills socket or audio time, so this prices socket time, the upper bound, until WP1 settles it.",
  },
  {
    kind: "stt",
    provider: "deepgram",
    model: "flux-general-en",
    usdPerHour: 0.39,
    keytermUsdPerHour: 0.078,
    billedOn: "socket",
    checkedAt: "2026-11-15",
    source: "deepgram.com/pricing",
    note:
      "Promotional: $0.0065/min (was $0.0077). Whether the keyterm add-on applies to Flux, and " +
      "whether Deepgram bills socket or audio time, aren't stated; both are priced at the upper bound.",
  },
  {
    kind: "stt",
    provider: "fake",
    model: "fake",
    usdPerHour: 0,
    keytermUsdPerHour: 0,
    billedOn: "audio",
    checkedAt: "2026-11-15",
    source: "@earshot/voice/testing",
    note: "The fake adapter, free, so development and CI sessions meter cleanly.",
  },
];

export const LLM_PRICES: readonly LlmPrice[] = [
  {
    kind: "llm",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.5,
    cachedInputUsdPerMTok: 0.01,
    cacheWriteUsdPerMTok: 0.125,
    checkedAt: "2026-11-15",
    source: "spec Appendix A (research note capture_llm_eval.md §4)",
    note: "For prompts up to 100k tokens.",
  },
  {
    kind: "llm",
    provider: "groq",
    model: "openai/gpt-oss-20b",
    inputUsdPerMTok: 0.075,
    outputUsdPerMTok: 0.3,
    checkedAt: "2026-11-15",
    source: "spec Appendix A (research note capture_llm_eval.md §4)",
    note: "A reasoning model: hidden reasoning tokens bill as output.",
  },
  {
    kind: "llm",
    provider: "groq",
    model: "openai/gpt-oss-120b",
    inputUsdPerMTok: 0.15,
    outputUsdPerMTok: 0.6,
    checkedAt: "2026-11-15",
    source: "spec Appendix A (research note capture_llm_eval.md §4)",
  },
];

export const PRICES: readonly Price[] = [...STT_PRICES, ...LLM_PRICES];

export type PriceResult =
  | { readonly ok: true; readonly costUsd: number; readonly priceTable: string }
  | { readonly ok: false; readonly reason: "unknown_model" | "invalid_usage" };

export function findSttPrice(provider: string, model: string): SttPrice | undefined {
  return STT_PRICES.find((price) => price.provider === provider && price.model === model);
}

export function findLlmPrice(provider: string, model: string): LlmPrice | undefined {
  return LLM_PRICES.find((price) => price.provider === provider && price.model === model);
}

export interface SttUsageInput {
  readonly provider: string;
  readonly model: string;
  readonly audioMs: number;
  readonly socketMs: number;
  /** Whether keyterms were sent. Earshot always sends them, so it defaults to true. */
  readonly keyterms?: boolean;
}

export interface LlmUsageInput {
  readonly provider: string;
  readonly model: string;
  /** Every input token, cached ones included. */
  readonly inputTokens: number;
  /** Every output token, reasoning included. */
  readonly outputTokens: number;
  /** Input tokens served from the prompt cache. */
  readonly cachedInputTokens?: number;
  /** Input tokens written to the prompt cache. */
  readonly cacheWriteInputTokens?: number;
}

const MS_PER_HOUR = 3_600_000;
const TOKENS_PER_M = 1_000_000;

const isCount = (value: number | undefined) =>
  value === undefined || (Number.isFinite(value) && value >= 0);

/** Rounds to a billionth of a dollar, so sums don't drift on floating-point noise. */
const roundUsd = (usd: number) => Math.round(usd * 1e9) / 1e9;

/** The cost of one speech-to-text socket, by what its provider bills. */
export function priceStt(usage: SttUsageInput): PriceResult {
  if (!isCount(usage.audioMs) || !isCount(usage.socketMs)) {
    return { ok: false, reason: "invalid_usage" };
  }
  const price = findSttPrice(usage.provider, usage.model);
  if (!price) return { ok: false, reason: "unknown_model" };
  const billedMs = price.billedOn === "audio" ? usage.audioMs : usage.socketMs;
  const usdPerHour = price.usdPerHour + (usage.keyterms === false ? 0 : price.keytermUsdPerHour);
  return {
    ok: true,
    costUsd: roundUsd((billedMs / MS_PER_HOUR) * usdPerHour),
    priceTable: PRICE_TABLE_DATE,
  };
}

/** The cost of one LLM call. Reasoning tokens are part of `outputTokens`. */
export function priceLlm(usage: LlmUsageInput): PriceResult {
  const counts = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteInputTokens,
  ];
  if (!counts.every(isCount)) return { ok: false, reason: "invalid_usage" };
  const price = findLlmPrice(usage.provider, usage.model);
  if (!price) return { ok: false, reason: "unknown_model" };
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const written = Math.min(usage.cacheWriteInputTokens ?? 0, usage.inputTokens - cached);
  const uncached = usage.inputTokens - cached - written;
  const usd =
    (uncached * price.inputUsdPerMTok +
      cached * (price.cachedInputUsdPerMTok ?? price.inputUsdPerMTok) +
      written * (price.cacheWriteUsdPerMTok ?? price.inputUsdPerMTok) +
      usage.outputTokens * price.outputUsdPerMTok) /
    TOKENS_PER_M;
  return { ok: true, costUsd: roundUsd(usd), priceTable: PRICE_TABLE_DATE };
}

/**
 * A cost for the meter: cents above a dollar, three decimals above a cent ("$0.011"), two
 * significant digits below that ("$0.0042"), and a floor at a hundredth of a cent.
 */
export function formatUsd(usd: number): string {
  if (!(usd > 0)) return "$0.00";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd.toPrecision(2)}`;
}
