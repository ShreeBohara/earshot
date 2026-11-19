// Speech-to-text prices for the cost meter: a local seam for `@earshot/voice/prices` (Phase 3
// WP4, PR #30), whose `priceStt` this mirrors, name, inputs, and result alike. LLM usage arrives
// already priced from `runTurn` (`@earshot/agent` keeps its own LLM rows), so only the client's
// `usage` messages are priced here. The rows are WP4's speech-to-text rows (spec Appendix A,
// checked 2026-11-15).
//
// When #30 merges, delete this file and import from the package instead, in src/index.ts,
// src/e2e.ts, and the tests' worker:
//
//   import { PRICE_TABLE_DATE, priceStt } from "@earshot/voice/prices";

/** The date of this table, for `usage.recorded.priceTable`. */
export const PRICE_TABLE_DATE = "2026-11-15";

/** What a speech-to-text provider bills: the time its socket is open, or the audio sent. */
export type BillingBasis = "socket" | "audio";

interface SttRow {
  readonly provider: string;
  readonly model: string;
  /** Per hour of billed time. */
  readonly usdPerHour: number;
  /** The keyterm add-on per hour. Earshot sends keyterms on every session. */
  readonly keytermUsdPerHour: number;
  readonly billedOn: BillingBasis;
}

const STT_ROWS: readonly SttRow[] = [
  // Billed on socket-open time, idle included.
  {
    provider: "assemblyai",
    model: "universal-streaming-english",
    usdPerHour: 0.15,
    keytermUsdPerHour: 0.04,
    billedOn: "socket",
  },
  // Keyterms included.
  {
    provider: "assemblyai",
    model: "universal-3-6-pro",
    usdPerHour: 0.45,
    keytermUsdPerHour: 0,
    billedOn: "socket",
  },
  // Promotional PAYG, $0.0048/min plus $0.0013/min for keyterms. Deepgram doesn't say whether it
  // bills socket or audio time, so socket time, the upper bound, until WP1 settles it.
  {
    provider: "deepgram",
    model: "nova-3",
    usdPerHour: 0.288,
    keytermUsdPerHour: 0.078,
    billedOn: "socket",
  },
  // Promotional $0.0065/min; the keyterm add-on and the billing basis at their upper bounds.
  {
    provider: "deepgram",
    model: "flux-general-en",
    usdPerHour: 0.39,
    keytermUsdPerHour: 0.078,
    billedOn: "socket",
  },
  // The fake development adapter: free, so development and CI sessions meter cleanly.
  { provider: "fake", model: "fake", usdPerHour: 0, keytermUsdPerHour: 0, billedOn: "audio" },
];

export interface SttUsageInput {
  readonly provider: string;
  readonly model: string;
  readonly audioMs: number;
  readonly socketMs: number;
  /** Whether keyterms were sent. Earshot always sends them, so it defaults to true. */
  readonly keyterms?: boolean;
}

export type PriceResult =
  | { readonly ok: true; readonly costUsd: number; readonly priceTable: string }
  | { readonly ok: false; readonly reason: "unknown_model" | "invalid_usage" };

const MS_PER_HOUR = 3_600_000;

const isCount = (value: number) => Number.isFinite(value) && value >= 0;

/** Rounds to a billionth of a dollar, so sums don't drift on floating-point noise. */
export const roundUsd = (usd: number) => Math.round(usd * 1e9) / 1e9;

/** The cost of one speech-to-text socket, by what its provider bills. */
export function priceStt(usage: SttUsageInput): PriceResult {
  if (!isCount(usage.audioMs) || !isCount(usage.socketMs)) {
    return { ok: false, reason: "invalid_usage" };
  }
  const row = STT_ROWS.find((r) => r.provider === usage.provider && r.model === usage.model);
  if (!row) return { ok: false, reason: "unknown_model" };
  const billedMs = row.billedOn === "audio" ? usage.audioMs : usage.socketMs;
  const usdPerHour = row.usdPerHour + (usage.keyterms === false ? 0 : row.keytermUsdPerHour);
  return {
    ok: true,
    costUsd: roundUsd((billedMs / MS_PER_HOUR) * usdPerHour),
    priceTable: PRICE_TABLE_DATE,
  };
}
