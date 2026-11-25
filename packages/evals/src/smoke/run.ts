// The live smoke runner (Phase 4 WP11 step 1; ADR-0031). Each turn goes as text through the real
// extractor and LLM adapter on a live model, then the understanding pipeline, then the second
// witness, by WP10's runner (`runScriptWith`), so a live run is scored by the same metrics as the
// $0 cassette runs:
//
// - the production stream's final carries `heard.biased`, with word timings spread over the turn
//   by character count, as the fake speech-to-text adapter spreads them. Evidence gets the audio
//   windows a real stream gives it;
// - the second witness carries `heard.unbiased` with no timings, so its reading is by alignment,
//   as in the $0 runs. Spreading timings over two transcripts of different lengths would misplace
//   words, which no real recording does;
// - every HTTP request waits for the pacer (60 a minute at most, after a slow start);
// - every call's measured cost goes to the budget meter; past the budget the run stops, and is
//   incomplete. So is a run whose provider fails a turn past `runTurn`'s retries, or refuses the
//   key: those turns can't be scored, and scoring them as misses would read an outage as a
//   regression. A turn the model answered with invalid output twice is the model's, and is scored.
//
// - after each script's turns, its recap (Phase 5 WP10; `./recap.ts`) on the same model, pacer, and
//   meter. A recap the provider fails ends the run as incomplete, as a turn's failure does; one the
//   model answered with invalid output twice is the model's, and is scored.
//
// Nothing here logs: progress goes to `onScript` as numbers, and the report carries no prompt,
// transcript, or model output.
import {
  createProposalExtractor,
  ExtractionError,
  type ExtractionFailure,
  LLM_MODELS,
  type ProposalExtractor,
  type RetryPolicy,
  type TokenUsage,
} from "@earshot/agent";
import type { LlmProvider, TurnOutcome, Word } from "@earshot/core";
import type { DebriefScript } from "../schema";
import {
  ERRORS_VERSION,
  type ErrorLabels,
  understandingUtterances,
} from "../understanding/cassettes";
import { runScriptWith, type ScriptRun, type TurnUtterances } from "../understanding/run";
import { createBudgetMeter } from "./budget";
import { type Pacer, pacedFetch } from "./pace";
import { type SmokeRecap, smokeRecap } from "./recap";

/**
 * The smoke run's retries: three attempts, as in production, but within 90 s rather than the
 * product's 8 s turn deadline. The smoke eval measures what the model writes, not how fast;
 * latency is `eval-live`'s. `Retry-After` is honored as given.
 */
export const SMOKE_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  deadlineMs: 90_000,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
});

/** A live model's runs carry no seeded errors. */
export const LIVE_LABELS: ErrorLabels = {
  version: ERRORS_VERSION,
  seed: 0,
  rates: { wrong_date: 0, wrong_amount: 0, paraphrased_target: 0 },
  eligible: { wrong_date: 0, wrong_amount: 0, paraphrased_target: 0 },
  errors: [],
};

/** Turns a model answered, rightly or not: the ones the metrics can score. */
const SCORED: ReadonlySet<TurnOutcome> = new Set([
  "proposals",
  "nothing_to_propose",
  "invalid_output",
]);

/**
 * Word timings for a transcript without them: its span spread over its words by character count,
 * a word's share counting one character of gap after it. The rule of `spreadWords` in
 * `@earshot/voice/testing`, which the fake speech-to-text adapter and the renderer use.
 */
export function spreadWords(
  text: string,
  startMs: number,
  endMs: number,
  confidence: number,
): Word[] {
  const words = text.split(" ").filter((word) => word !== "");
  const weight = words.reduce((sum, word) => sum + word.length + 1, 0);
  const span = Math.max(0, endMs - startMs);
  const out: Word[] = [];
  let at = 0;
  for (const word of words) {
    const share = ((word.length + 1) / weight) * span;
    const wordStart = startMs + at;
    out.push({
      w: word,
      startMs: Math.round(wordStart),
      endMs: Math.round(wordStart + share * (word.length / (word.length + 1))),
      confidence,
    });
    at += share;
  }
  return out;
}

/** A turn's transcripts for a live run: the biased one timed word by word, the unbiased one not. */
export function smokeUtterances(script: DebriefScript, turnIndex: number): TurnUtterances {
  const { biased, unbiased } = understandingUtterances(script, turnIndex);
  return {
    biased: {
      ...biased,
      words: spreadWords(biased.text, biased.startMs, biased.endMs, biased.confidence),
    },
    unbiased,
  };
}

/** Why a run stopped before the end. */
export interface SmokeStop {
  readonly reason: "budget" | "provider" | "aborted";
  /** A fixed code: `budget`, the extraction failure and its detail (`rate_limited:http_429`), … */
  readonly detail: string;
}

/** After each script: numbers only. */
export interface SmokeProgress {
  readonly script: string;
  readonly done: number;
  readonly of: number;
  readonly turns: number;
  readonly spentUsd: number;
  readonly budgetUsd: number;
}

export interface SmokeRunOptions {
  readonly provider: LlmProvider;
  readonly scripts: readonly DebriefScript[];
  /** The provider key, for the extractor's calls only. */
  readonly apiKey: string;
  /** The network for one script's requests: the global `fetch` live, a cassette or stub at $0. */
  readonly fetchFor: (script: DebriefScript) => typeof globalThis.fetch;
  /**
   * The network for one script's recap (Phase 5 WP10): `fetchFor`'s when absent, as a live run
   * wants; the recap cassettes for an offline run.
   */
  readonly recapFetchFor?: (script: DebriefScript) => typeof globalThis.fetch;
  readonly budgetUsd: number;
  /** What a call that reports no usage, such as one that timed out, is charged (the estimate's). */
  readonly perCallUsd: number;
  /** Anthropic's prompt cache on the stable prefix (`ExtractorOptions.promptCache`). */
  readonly promptCache: boolean;
  /** Shared by every run of one process, so its limits hold across them. */
  readonly pacer: Pacer;
  readonly retry?: RetryPolicy;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
  /** An outside stop, such as the job being cancelled. */
  readonly signal?: AbortSignal;
  readonly onScript?: (progress: SmokeProgress) => void;
}

export interface SmokeRun {
  readonly provider: LlmProvider;
  readonly model: string;
  /** Every script the run started, the one it stopped in included, in order. */
  readonly runs: readonly ScriptRun[];
  /** Each finished script's recap, in order (Phase 5 WP10). */
  readonly recaps: readonly SmokeRecap[];
  /** Every script ran, and every turn was answered. */
  readonly complete: boolean;
  readonly stop: SmokeStop | null;
  readonly budgetUsd: number;
  readonly spentUsd: number;
  readonly usage: TokenUsage;
  /** LLM calls, the validation retry's included. */
  readonly calls: number;
  /** Calls charged at the estimate because they reported no usage. */
  readonly estimatedCalls: number;
  /** HTTP requests the pacer let through. */
  readonly requests: number;
  readonly outcomes: Readonly<Partial<Record<TurnOutcome, number>>>;
  /** Failed extractions by code, after `runTurn`'s retries. */
  readonly failures: Readonly<Partial<Record<ExtractionFailure, number>>>;
  readonly durationMs: number;
}

/** The scripts a run can be scored on: those whose every turn the model answered. */
export function scoredRuns(run: Pick<SmokeRun, "runs">): ScriptRun[] {
  return run.runs.filter((script) =>
    script.turns.every((turn) => turn.outcome !== undefined && SCORED.has(turn.outcome)),
  );
}

/** Wraps an extractor so every call's cost reaches the meter, failed calls' included. */
function metered(
  extractor: ProposalExtractor,
  meter: ReturnType<typeof createBudgetMeter>,
  perCallUsd: number,
): ProposalExtractor {
  return {
    ...extractor,
    async extract(input) {
      try {
        const result = await extractor.extract(input);
        meter.add(result.usage, result.costUsd, result.attempts);
        return result;
      } catch (error) {
        if (error instanceof ExtractionError && error.attempts > 0) {
          const billed = error.usage.inputTokens > 0 || error.usage.outputTokens > 0;
          if (billed) meter.add(error.usage, error.costUsd, error.attempts);
          // A request that timed out or lost its connection may have been processed, and billed,
          // with no usage to show for it: charge the estimate. HTTP errors aren't billed.
          else if (error.detail === "timeout" || error.detail === "network") {
            meter.charge(perCallUsd * error.attempts, error.attempts);
          }
        }
        throw error;
      }
    },
  };
}

/** Runs the scripts on a live model (or a stand-in), within the budget. */
export async function runSmoke(options: SmokeRunOptions): Promise<SmokeRun> {
  const now = options.now ?? Date.now;
  const started = now();
  const controller = new AbortController();
  let stop: SmokeStop | null = null;
  const halt = (next: SmokeStop) => {
    if (stop !== null) return;
    stop = next;
    controller.abort(new DOMException(`smoke run stopped: ${next.detail}`, "AbortError"));
  };
  const onOutsideAbort = () => halt({ reason: "aborted", detail: "aborted" });
  if (options.signal?.aborted) onOutsideAbort();
  options.signal?.addEventListener("abort", onOutsideAbort, { once: true });
  const meter = createBudgetMeter(options.budgetUsd, () =>
    halt({ reason: "budget", detail: "budget" }),
  );
  const outcomes: Partial<Record<TurnOutcome, number>> = {};
  const failures: Partial<Record<ExtractionFailure, number>> = {};
  const runs: ScriptRun[] = [];
  const recaps: SmokeRecap[] = [];
  const model = LLM_MODELS[options.provider];
  const requestsBefore = options.pacer.started;
  try {
    for (const script of options.scripts) {
      if (stop !== null) break;
      const extractor = metered(
        createProposalExtractor({
          provider: options.provider,
          fetch: pacedFetch(options.fetchFor(script), options.pacer),
          promptCache: options.promptCache,
        }),
        meter,
        options.perCallUsd,
      );
      const run = await runScriptWith(script, {
        extractor,
        apiKey: options.apiKey,
        utterances: smokeUtterances,
        signal: controller.signal,
        retry: options.retry ?? SMOKE_RETRY_POLICY,
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.random ? { random: options.random } : {}),
        onTurn: (turn) => {
          const outcome = turn.outcome;
          if (outcome !== undefined) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
          const failure = turn.failure;
          if (!failure) return;
          failures[failure.code] = (failures[failure.code] ?? 0) + 1;
          // Our own stop shows up as a cancelled turn; anything else but invalid output is the
          // provider's, and ends the run.
          if (failure.code !== "invalid_output" && failure.code !== "cancelled") {
            halt({ reason: "provider", detail: `${failure.code}:${failure.detail}` });
          }
        },
      });
      runs.push(run);
      if (stop === null) {
        const recap = await smokeRecap({
          provider: options.provider,
          script,
          // The biased transcript the turns heard, every turn's, in order.
          utterances: script.turns.map((_, index) => smokeUtterances(script, index).biased),
          apiKey: options.apiKey,
          fetch: (options.recapFetchFor ?? options.fetchFor)(script),
          pacer: options.pacer,
          meter,
          perCallUsd: options.perCallUsd,
          signal: controller.signal,
          ...(options.sleep ? { sleep: options.sleep } : {}),
          ...(options.random ? { random: options.random } : {}),
        });
        recaps.push(recap);
        const failure = recap.result.failure;
        if (failure && failure.code !== "invalid_output" && failure.code !== "cancelled") {
          failures[failure.code] = (failures[failure.code] ?? 0) + 1;
          halt({ reason: "provider", detail: `recap:${failure.code}:${failure.detail}` });
        }
      }
      options.onScript?.({
        script: script.id,
        done: runs.length,
        of: options.scripts.length,
        turns: run.turns.length,
        spentUsd: meter.spentUsd,
        budgetUsd: options.budgetUsd,
      });
    }
  } finally {
    options.signal?.removeEventListener("abort", onOutsideAbort);
  }
  const finished = stop as SmokeStop | null;
  const answered = runs.every((run) =>
    run.turns.every((turn) => turn.outcome !== undefined && SCORED.has(turn.outcome)),
  );
  return {
    provider: options.provider,
    model,
    runs,
    recaps,
    complete:
      finished === null &&
      runs.length === options.scripts.length &&
      recaps.length === options.scripts.length &&
      answered,
    stop: finished,
    budgetUsd: options.budgetUsd,
    spentUsd: meter.spentUsd,
    usage: meter.usage,
    calls: meter.calls,
    estimatedCalls: meter.estimatedCalls,
    requests: options.pacer.started - requestsBefore,
    outcomes,
    failures,
    durationMs: Math.max(0, Math.round(now() - started)),
  };
}
