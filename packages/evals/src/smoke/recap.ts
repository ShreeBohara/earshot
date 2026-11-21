// The live smoke eval's recap (Phase 5 WP10 step 7; ADR-0037): after each script's turns, one recap
// of that script on the same live model, through the same pacer and budget meter, scored by the
// checks in code. What's gated, against the baseline: every kept sentence carries evidence (the
// code's promise, never the model's luck), and the share of sentences dropped for quoting words not
// in the transcript hasn't risen by more than max(5 points, 2 × the baseline's spread) (target).
//
// The recap's request is the recap eval's (`@earshot/evals/recap`): each turn's biased transcript,
// the script's ground-truth proposals as context, and its lens by rotation. So a live recap and
// its $0 cassette answer the very same request, and an offline run replays the committed recap
// cassettes through this same plumbing. The proposals are context only, and the ground truth's keep
// an extraction mistake from moving the recap's numbers.
import {
  createRecapper,
  ExtractionError,
  type Recapper,
  type RecapResult,
  type RetryPolicy,
  runRecap,
} from "@earshot/agent";
import type { LlmProvider } from "@earshot/core";
import { z } from "zod";
import { recapLensOf, recapScriptProposals } from "../recap/cassettes";
import type { DebriefScript } from "../schema";
import type { BudgetMeter } from "./budget";
import { type Pacer, pacedFetch } from "./pace";

/**
 * The smoke run's recap retries: two attempts within 90 s, as the turns get, rather than the
 * product's 15 s deadline. The smoke eval measures what the model writes, not how fast.
 */
export const SMOKE_RECAP_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 2,
  deadlineMs: 90_000,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
});

/** The recap gate's targets (spec WP10 step 7). */
export const SMOKE_RECAP_GATE = {
  /** The least the drop rate may rise above the baseline's median before it fails. */
  minRise: 0.05,
  /** Or this many times its spread across the baseline runs, if that's more. */
  spreadFactor: 2,
  minEvidenceCoverage: 1,
} as const;

/** One script's recap in a run. */
export interface SmokeRecap {
  readonly script: string;
  readonly result: RecapResult;
}

const Count = z.int().nonnegative();
const Rate = z.number().min(0).max(1).nullable();

/** One run's recap numbers: counts and the rates the gate and the report read. */
export const SmokeRecapSummary = z.strictObject({
  recaps: Count,
  /** Recaps the model wrote; the rest failed validation twice (the model's) or were skipped. */
  created: Count,
  /** Sentences the model wrote, kept, kept with evidence, and dropped. */
  written: Count,
  kept: Count,
  withEvidence: Count,
  dropped: Count,
  headlines: Count,
  weak: Count,
  /** Kept sentences with evidence ÷ kept: 100% required. */
  evidenceCoverage: Rate,
  /** Dropped ÷ written: gated against the baseline. */
  dropRate: Rate,
  /** Recaps with a headline ÷ created, and weak support among kept: reported. */
  headlineRate: Rate,
  weakSupportShare: Rate,
});
export type SmokeRecapSummary = z.infer<typeof SmokeRecapSummary>;

const round = (value: number | null) =>
  value === null ? null : Math.round(value * 1_000_000) / 1_000_000;
const rate = (n: number, of: number) => (of === 0 ? null : round(n / of));

/** A run's recap numbers, or null when it wrote none. */
export function smokeRecapSummary(recaps: readonly SmokeRecap[]): SmokeRecapSummary | null {
  if (recaps.length === 0) return null;
  let created = 0;
  let written = 0;
  let kept = 0;
  let withEvidence = 0;
  let dropped = 0;
  let headlines = 0;
  let weak = 0;
  for (const { result } of recaps) {
    const { recap } = result;
    if (recap.outcome === "created") created += 1;
    written += result.trace.length;
    kept += recap.sentences.length;
    withEvidence += recap.sentences.filter((sentence) => sentence.evidence.length > 0).length;
    dropped += recap.dropped;
    if (recap.sentences.some((sentence) => sentence.kind === "headline")) headlines += 1;
    weak += recap.sentences.filter((sentence) => sentence.weakSupport).length;
  }
  return {
    recaps: recaps.length,
    created,
    written,
    kept,
    withEvidence,
    dropped,
    headlines,
    weak,
    evidenceCoverage: rate(withEvidence, kept),
    dropRate: rate(dropped, written),
    headlineRate: rate(headlines, created),
    weakSupportShare: rate(weak, kept),
  };
}

/** The rise the drop rate is allowed above the median: max(5 points, 2 × its spread). */
export function allowedRecapRise(spread: number | null): number {
  return Math.max(SMOKE_RECAP_GATE.minRise, SMOKE_RECAP_GATE.spreadFactor * (spread ?? 0));
}

/** Wraps a recapper so every call's cost reaches the meter, failed calls' included. */
function metered(recapper: Recapper, meter: BudgetMeter, perCallUsd: number): Recapper {
  return {
    ...recapper,
    async write(input) {
      try {
        const call = await recapper.write(input);
        meter.add(call.usage, call.costUsd, call.attempts);
        return call;
      } catch (error) {
        if (error instanceof ExtractionError && error.attempts > 0) {
          const billed = error.usage.inputTokens > 0 || error.usage.outputTokens > 0;
          if (billed) meter.add(error.usage, error.costUsd, error.attempts);
          else if (error.detail === "timeout" || error.detail === "network") {
            meter.charge(perCallUsd * error.attempts, error.attempts);
          }
        }
        throw error;
      }
    },
  };
}

export interface SmokeRecapOptions {
  readonly provider: LlmProvider;
  readonly script: DebriefScript;
  /** The script's biased transcript, turn by turn, as the run's turns heard it. */
  readonly utterances: Parameters<typeof runRecap>[0]["utterances"];
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly pacer: Pacer;
  readonly meter: BudgetMeter;
  readonly perCallUsd: number;
  readonly signal: AbortSignal;
  readonly policy?: RetryPolicy;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

/** One script's recap on the run's model, paced and metered. */
export async function smokeRecap(options: SmokeRecapOptions): Promise<SmokeRecap> {
  const recapper = metered(
    createRecapper({
      provider: options.provider,
      fetch: pacedFetch(options.fetch, options.pacer),
    }),
    options.meter,
    options.perCallUsd,
  );
  const result = await runRecap({
    recapper,
    utterances: options.utterances,
    proposals: recapScriptProposals(options.script),
    lens: recapLensOf(options.script),
    apiKey: options.apiKey,
    signal: options.signal,
    policy: options.policy ?? SMOKE_RECAP_POLICY,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {}),
  });
  return { script: options.script.id, result };
}
