// One turn's extraction, as SessionDO runs it on `turn_end` (spec WP6 step 4): extract with
// retries inside the turn's deadline, then hand back the events to append, in order:
// `proposal.created` for each proposal, `usage.recorded`, and `turn.completed`.
import {
  type EntityRef,
  type ProposalCreatedV1,
  type SessionErrorCode,
  type TurnCompletedV1,
  type TurnOutcome,
  type UsageRecordedV1,
  type UtteranceFinalV2,
  uuidv7,
} from "@earshot/core";
import { ExtractionError, type ExtractionFailure } from "./errors";
import type { ProposalExtractor } from "./extractor";
import { roundUsd } from "./prices";
import { DEFAULT_RETRY_POLICY, nextRetryDelay, type RetryPolicy } from "./retry";
import { addUsage, hasTokens, type TokenUsage, ZERO_USAGE } from "./usage";

/** What the client sees while a turn runs: SessionDO's `working` message, never logged. */
export type WorkingState =
  | { readonly state: "thinking" }
  | { readonly state: "retrying"; readonly retryInMs: number };

export interface RunTurnInput {
  readonly extractor: ProposalExtractor;
  /** From `turn_end`. */
  readonly turnId: string;
  /** The turn's utterances, in order. None means nothing to propose, with no call made. */
  readonly utterances: readonly UtteranceFinalV2[];
  readonly entities: readonly EntityRef[];
  readonly callTime: string;
  readonly timeZone: string;
  /** From `turn_end.key`: passed to the extractor and referenced nowhere else. */
  readonly apiKey: string;
  /** Aborting it cancels the turn. The turn's own deadline comes from `retry`. */
  readonly signal: AbortSignal;
  readonly retry?: RetryPolicy;
  readonly onWorking?: (state: WorkingState) => void;
  /** Seams for tests: the clock, the backoff wait, ids, and jitter. */
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly newId?: () => string;
  readonly random?: () => number;
}

export interface TurnResult {
  readonly outcome: TurnOutcome;
  /** `proposal.created` payloads, to append in order before the others. */
  readonly proposals: readonly ProposalCreatedV1[];
  /** `usage.recorded`, when any call reported tokens; null when nothing was billed. */
  readonly usage: UsageRecordedV1 | null;
  /** `turn.completed`, to append last. */
  readonly completed: TurnCompletedV1;
  /** The `error` message to send the client, if the outcome calls for one. */
  readonly error: { readonly code: SessionErrorCode; readonly retryable: boolean } | null;
  /**
   * The failure, as a fixed code and detail for SessionDO's log (`http_429`, `timeout`, …).
   * Null when the turn succeeded.
   */
  readonly failure: { readonly code: ExtractionFailure; readonly detail: string } | null;
}

/** How each failure ends a turn. A refusal and a rejected key are failures at the provider. */
export const TURN_OUTCOMES: Readonly<Record<ExtractionFailure, TurnOutcome>> = {
  invalid_output: "invalid_output",
  key_rejected: "provider_error",
  rate_limited: "rate_limited",
  provider_error: "provider_error",
  refused: "provider_error",
  cancelled: "cancelled",
};

/** The session error code for a failure, if the client should get an `error` message. */
export function sessionErrorFor(
  failure: Pick<ExtractionError, "code" | "retryable">,
): TurnResult["error"] {
  switch (failure.code) {
    case "key_rejected":
      return { code: "llm_key_rejected", retryable: false };
    case "rate_limited":
      return { code: "llm_rate_limited", retryable: true };
    case "provider_error":
    case "refused":
      return { code: "llm_unavailable", retryable: failure.retryable };
    default:
      // invalid_output and cancelled: turn.completed says enough.
      return null;
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs one turn's extraction. Failures the retry policy allows are tried again, after the
 * provider's `Retry-After` or a backoff, and only within the turn's deadline. Never throws an
 * `ExtractionError`: every failure becomes an outcome. Other errors are bugs, and propagate.
 */
export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  const { extractor } = input;
  const policy = input.retry ?? DEFAULT_RETRY_POLICY;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? abortableSleep;
  const newId = input.newId ?? uuidv7;
  const random = input.random ?? Math.random;
  const utteranceIds = input.utterances.map((utterance) => utterance.utteranceId);

  let attempts = 0;
  let llmMs = 0;
  let usage: TokenUsage = ZERO_USAGE;
  let costUsd = 0;
  const settle = (
    outcome: TurnOutcome,
    proposals: readonly ProposalCreatedV1[],
    failure: ExtractionError | null,
  ): TurnResult => ({
    outcome,
    proposals,
    usage: hasTokens(usage)
      ? {
          usageId: newId(),
          kind: "llm",
          provider: extractor.provider,
          model: extractor.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cachedInputTokens > 0 ? { cachedInputTokens: usage.cachedInputTokens } : {}),
          costUsd: roundUsd(costUsd),
          priceTable: extractor.priceTable,
        }
      : null,
    completed: {
      turnId: input.turnId,
      utteranceIds,
      outcome,
      proposalIds: proposals.map((proposal) => proposal.proposalId),
      attempts,
      llmMs: Math.round(llmMs),
    },
    error: failure ? sessionErrorFor(failure) : null,
    failure: failure ? { code: failure.code, detail: failure.detail } : null,
  });

  if (input.utterances.length === 0) return settle("nothing_to_propose", [], null);
  if (input.signal.aborted) {
    return settle("cancelled", [], cancelledError());
  }

  // The deadline aborts with a TimeoutError, which the extractor reports as a provider timeout;
  // the caller's abort keeps its own reason, which it reports as cancelled.
  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(
    () => controller.abort(new DOMException("turn deadline passed", "TimeoutError")),
    policy.deadlineMs,
  );
  const started = now();
  try {
    input.onWorking?.({ state: "thinking" });
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await extractor.extract({
          utterances: input.utterances,
          entities: input.entities,
          callTime: input.callTime,
          timeZone: input.timeZone,
          apiKey: input.apiKey,
          signal: controller.signal,
        });
        attempts += result.attempts;
        llmMs += result.latencyMs;
        usage = addUsage(usage, result.usage);
        costUsd += result.costUsd;
        const proposals = result.drafts.map((draft) => ({ proposalId: newId(), ...draft }));
        return settle(proposals.length > 0 ? "proposals" : "nothing_to_propose", proposals, null);
      } catch (error) {
        if (!(error instanceof ExtractionError)) throw error;
        attempts += error.attempts;
        llmMs += error.latencyMs;
        usage = addUsage(usage, error.usage);
        costUsd += error.costUsd;
        const delay = nextRetryDelay(policy, {
          attempt,
          failure: error,
          elapsedMs: now() - started,
          random: random(),
        });
        if (delay === null) return settle(TURN_OUTCOMES[error.code], [], error);
        input.onWorking?.({ state: "retrying", retryInMs: delay });
        try {
          await sleep(delay, controller.signal);
        } catch {
          // Aborted while waiting: by the caller, or by the deadline after all.
          return input.signal.aborted
            ? settle("cancelled", [], cancelledError())
            : settle(TURN_OUTCOMES[error.code], [], error);
        }
      }
    }
  } finally {
    clearTimeout(deadline);
    input.signal.removeEventListener("abort", onAbort);
  }
}

function cancelledError(): ExtractionError {
  return new ExtractionError({
    code: "cancelled",
    retryable: false,
    detail: "aborted",
    attempts: 0,
    latencyMs: 0,
    usage: ZERO_USAGE,
    costUsd: 0,
  });
}
