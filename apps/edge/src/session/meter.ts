// The cost meter (spec WP6 step 7): running totals of what a session has cost, kept in
// `meta.meter`. Every `usage.recorded` event SessionDO appends adds to it in the same
// transaction, so the totals always equal the sum of the log's usage events. `session.ended`
// carries the total; the client shows a running total from the events themselves.
import type { UsageRecordedV1 } from "@earshot/core";
import { roundUsd } from "../prices";

export interface MeterTotals {
  /** Everything, in USD. */
  readonly costUsd: number;
  readonly stt: {
    readonly costUsd: number;
    readonly audioMs: number;
    readonly socketMs: number;
  };
  readonly llm: {
    readonly costUsd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
  };
  readonly speechToSpeech: { readonly costUsd: number };
  /** How many `usage.recorded` events the totals cover. */
  readonly records: number;
}

export const EMPTY_METER: MeterTotals = Object.freeze({
  costUsd: 0,
  stt: Object.freeze({ costUsd: 0, audioMs: 0, socketMs: 0 }),
  llm: Object.freeze({ costUsd: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }),
  speechToSpeech: Object.freeze({ costUsd: 0 }),
  records: 0,
});

/** The totals in `meta.meter`, or an empty meter. */
export function readMeter(stored: string | undefined): MeterTotals {
  if (!stored) return EMPTY_METER;
  try {
    return { ...EMPTY_METER, ...(JSON.parse(stored) as Partial<MeterTotals>) };
  } catch {
    return EMPTY_METER;
  }
}

/** The totals after one more usage record. Each sum is rounded to the nano-dollar. */
export function addUsage(meter: MeterTotals, usage: UsageRecordedV1): MeterTotals {
  const cost = usage.costUsd;
  return {
    costUsd: roundUsd(meter.costUsd + cost),
    stt:
      usage.kind === "stt"
        ? {
            costUsd: roundUsd(meter.stt.costUsd + cost),
            audioMs: meter.stt.audioMs + (usage.audioMs ?? 0),
            socketMs: meter.stt.socketMs + (usage.socketMs ?? 0),
          }
        : meter.stt,
    llm:
      usage.kind === "llm"
        ? {
            costUsd: roundUsd(meter.llm.costUsd + cost),
            inputTokens: meter.llm.inputTokens + (usage.inputTokens ?? 0),
            outputTokens: meter.llm.outputTokens + (usage.outputTokens ?? 0),
            cachedInputTokens: meter.llm.cachedInputTokens + (usage.cachedInputTokens ?? 0),
          }
        : meter.llm,
    speechToSpeech:
      usage.kind === "speech_to_speech"
        ? { costUsd: roundUsd(meter.speechToSpeech.costUsd + cost) }
        : meter.speechToSpeech,
    records: meter.records + 1,
  };
}
