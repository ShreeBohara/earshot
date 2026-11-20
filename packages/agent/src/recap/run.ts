// The recap's call (Phase 5 spec WP10 step 2; ADR-0037): one forced `submit_recap` on the
// session's own provider, through the same adapters as extraction, on the key `end` carried, then
// the checks in code (`./checks.ts`), priced as `usage.recorded`.
//
// - `createRecapper` builds the provider for each call from the key passed for that call, and
//   drops it when the call returns, as the extractor does. Nothing here keeps a key.
// - `runRecap` never throws for a provider or validation failure: each becomes a `recap.created`
//   with `outcome: "failed"` and its reason, so `SessionDO` always has something to record and the
//   seal never waits on it. A retryable failure is tried again only within the 15 s deadline
//   (target); a response past it is a `timeout`.
// - No speech (no biased utterance with words) is `skipped`, `no_speech`, with no call; no key is
//   the caller's `skipped`, `no_key` (`skippedRecap`).
import {
  type LlmProvider,
  type RecapCreatedV1,
  type RecapLensId,
  type RecapReason,
  type UsageRecordedV1,
  type UtteranceFinalV2,
  uuidv7,
} from "@earshot/core";
import {
  APICallError,
  generateText,
  type JSONSchema7,
  jsonSchema,
  ToolChoiceViolationError,
  tool,
} from "ai";
import {
  type CallFailure,
  classifyCallError,
  ExtractionError,
  type ExtractionFailure,
  extractionError,
} from "../errors";
import { ADAPTERS, type ExtractorOptions, LLM_MODELS } from "../extractor";
import { providerEndpoint } from "../gateway";
import { findLlmPrice, LLM_PRICES, type LlmPriceRow, llmCostUsd, roundUsd } from "../prices";
import { nextRetryDelay, type RetryPolicy } from "../retry";
import { describeIssues } from "../schema";
import { addUsage, fromSdkUsage, hasTokens, type TokenUsage, ZERO_USAGE } from "../usage";
import { type CheckedRecap, checkRecap, type SentenceTrace } from "./checks";
import { recapLens } from "./lenses";
import { buildRecapPrompt, type RecapProposal, withRecapFeedback } from "./prompt";
import {
  SUBMIT_RECAP,
  SUBMIT_RECAP_DESCRIPTION,
  SUBMIT_RECAP_JSON_SCHEMA,
  type SubmitRecapInput,
  submitRecapInput,
} from "./schema";

/** The recap's deadline after `end` (spec §4.10, target): no attempt starts or waits past it. */
export const RECAP_DEADLINE_MS = 15_000;

/** Two attempts at most, within the deadline, after the provider's `Retry-After` or a backoff. */
export const RECAP_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 2,
  deadlineMs: RECAP_DEADLINE_MS,
  baseDelayMs: 500,
  maxDelayMs: 2_000,
});

/**
 * Room for the recap's tool call: about 350 tokens of sentences and quotes (spec §4.10), and on
 * Groq the hidden reasoning that bills as output. Lower than extraction's, so a runaway answer
 * costs less.
 */
export const RECAP_MAX_OUTPUT_TOKENS: Readonly<Record<LlmProvider, number>> = {
  anthropic: 2_048,
  groq: 4_096,
};

export interface RecapCallInput {
  /** The session's utterances from the biased stream, in order. At least one. */
  readonly utterances: readonly UtteranceFinalV2[];
  readonly proposals: readonly RecapProposal[];
  readonly lens: RecapLensId | null;
  /** From `end.recap.key`: for this call only. Never stored, logged, or returned. */
  readonly apiKey: string;
  readonly signal: AbortSignal;
}

export interface RecapCall {
  /** The model's tool input, validated. */
  readonly output: SubmitRecapInput;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly attempts: 1 | 2;
  readonly latencyMs: number;
}

export interface Recapper {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly price: LlmPriceRow;
  readonly priceTable: string;
  /**
   * One recap call, and one retry if its output fails validation. Throws `ExtractionError` (the
   * shared LLM call failure, fixed codes only) for every provider or validation failure, carrying
   * the attempts, latency, usage, and cost so far.
   */
  write(input: RecapCallInput): Promise<RecapCall>;
}

export type RecapperOptions = Pick<
  ExtractorOptions,
  "provider" | "model" | "fetch" | "gateway" | "prices" | "now"
>;

type AttemptOutcome =
  | { readonly kind: "valid"; readonly input: SubmitRecapInput }
  | { readonly kind: "invalid"; readonly problems: readonly string[] }
  | { readonly kind: "refused" };

const REFUSED: CallFailure = { code: "refused", retryable: false, detail: "content_filter" };
const UNEXPECTED: CallFailure = { code: "provider_error", retryable: false, detail: "unexpected" };
const NO_CALL = `the reply had no ${SUBMIT_RECAP} call; call it, with at least the headline`;
const NOT_JSON = `the ${SUBMIT_RECAP} arguments weren't valid JSON`;
const TRUNCATED = "the output was cut off at the token limit; write fewer or shorter sentences";

/** Throws a RangeError for a model the package has no adapter or price for. */
export function createRecapper(options: RecapperOptions): Recapper {
  const provider = options.provider;
  const model = options.model ?? LLM_MODELS[provider];
  if (model !== LLM_MODELS[provider]) {
    throw new RangeError(`unsupported ${provider} model; use ${LLM_MODELS[provider]}`);
  }
  const table = options.prices ?? LLM_PRICES;
  const price = findLlmPrice(table, provider, model);
  if (!price) throw new RangeError(`no price for ${provider} ${model} in the ${table.date} table`);
  const adapter = ADAPTERS[provider];
  const endpoint = providerEndpoint(provider, options.gateway);
  const now = options.now ?? Date.now;
  const submit = tool({
    description: SUBMIT_RECAP_DESCRIPTION,
    // No `validate`: every check runs below with Zod, and in `checkRecap` after it.
    inputSchema: jsonSchema(SUBMIT_RECAP_JSON_SCHEMA as JSONSchema7),
    ...(adapter.strict ? { strict: true } : {}),
  });

  return {
    provider,
    model,
    price,
    priceTable: table.date,
    async write(input) {
      if (input.utterances.length === 0) throw new RangeError("a recap needs speech");
      const prompt = buildRecapPrompt({
        utterances: input.utterances,
        proposals: input.proposals,
        lens: recapLens(input.lens),
      });
      if (input.signal.aborted) {
        throw extractionError(classifyCallError(input.signal.reason, input.signal, now()), {
          attempts: 0,
          latencyMs: 0,
        });
      }
      if (typeof input.apiKey !== "string" || input.apiKey.trim() === "") {
        throw extractionError(
          { code: "key_rejected", retryable: false, detail: "empty_key" },
          { attempts: 0, latencyMs: 0 },
        );
      }
      const languageModel = adapter.createModel(
        {
          apiKey: input.apiKey,
          baseURL: endpoint.baseURL,
          headers: endpoint.headers,
          fetch: options.fetch,
        },
        model,
      );
      let usage = ZERO_USAGE;
      let costUsd = 0;
      let latencyMs = 0;
      let problems: readonly string[] | undefined;
      for (const attempt of [1, 2] as const) {
        const started = now();
        let callUsage: TokenUsage | undefined;
        let outcome: AttemptOutcome | undefined;
        let failure: CallFailure | undefined;
        try {
          const result = await generateText({
            model: languageModel,
            instructions: prompt.instructions,
            messages: [
              {
                role: "user",
                content: problems
                  ? withRecapFeedback(prompt.transcript, problems)
                  : prompt.transcript,
              },
            ],
            tools: { [SUBMIT_RECAP]: submit },
            toolChoice: { type: "tool", toolName: SUBMIT_RECAP },
            maxRetries: 0,
            maxOutputTokens: RECAP_MAX_OUTPUT_TOKENS[provider],
            abortSignal: input.signal,
            providerOptions: adapter.providerOptions,
            onLanguageModelCallEnd: (event) => {
              callUsage = fromSdkUsage(event.usage);
            },
          });
          callUsage ??= fromSdkUsage(result.usage);
          outcome = readOutput(result.content, result.finishReason);
        } catch (error) {
          outcome =
            unansweredToolChoice(error) ??
            (provider === "groq" ? groqRejectedToolCall(error) : undefined);
          if (outcome === undefined) failure = classifyCallError(error, input.signal, now());
        }
        latencyMs += now() - started;
        if (callUsage) {
          usage = addUsage(usage, callUsage);
          costUsd = roundUsd(costUsd + llmCostUsd(callUsage, price));
        }
        if (failure || outcome === undefined) {
          throw extractionError(failure ?? UNEXPECTED, {
            attempts: attempt,
            latencyMs,
            usage,
            costUsd,
          });
        }
        if (outcome.kind === "refused") {
          throw extractionError(REFUSED, { attempts: attempt, latencyMs, usage, costUsd });
        }
        if (outcome.kind === "valid") {
          return {
            output: outcome.input,
            usage,
            costUsd,
            attempts: attempt,
            latencyMs: Math.round(latencyMs),
          };
        }
        problems = outcome.problems;
      }
      throw extractionError(
        { code: "invalid_output", retryable: false, detail: "validation_failed_twice" },
        { attempts: 2, latencyMs, usage, costUsd },
      );
    },
  };
}

interface ContentPartShape {
  readonly type: string;
  readonly toolName?: string;
  readonly input?: unknown;
}

/** The first `submit_recap` call in a response, validated. A recap is one call. */
function readOutput(content: readonly ContentPartShape[], finishReason: string): AttemptOutcome {
  const call = content.find((part) => part.type === "tool-call" && part.toolName === SUBMIT_RECAP);
  if (!call) {
    if (finishReason === "content-filter") return { kind: "refused" };
    if (finishReason === "length") return { kind: "invalid", problems: [TRUNCATED] };
    return { kind: "invalid", problems: [NO_CALL] };
  }
  if (typeof call.input === "string") {
    return { kind: "invalid", problems: finishReason === "length" ? [TRUNCATED] : [NOT_JSON] };
  }
  return validate(call.input);
}

/** AI SDK 7 throws when a forced tool isn't called: a refusal, or invalid output to retry. */
function unansweredToolChoice(error: unknown): AttemptOutcome | undefined {
  if (!ToolChoiceViolationError.isInstance(error)) return undefined;
  if (error.finishReason === "content-filter") return { kind: "refused" };
  return { kind: "invalid", problems: [error.finishReason === "length" ? TRUNCATED : NO_CALL] };
}

function validate(input: unknown): AttemptOutcome {
  const parsed = submitRecapInput.safeParse(input);
  return parsed.success
    ? { kind: "valid", input: parsed.data }
    : { kind: "invalid", problems: describeIssues(parsed.error) };
}

/** Groq's 400 `tool_use_failed` carries the model's arguments: invalid output, read back out. */
function groqRejectedToolCall(error: unknown): AttemptOutcome | undefined {
  if (!APICallError.isInstance(error) || error.statusCode !== 400) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(error.responseBody ?? "");
  } catch {
    return undefined;
  }
  const failure = (body as { error?: { code?: unknown; failed_generation?: unknown } } | null)
    ?.error;
  if (failure?.code !== "tool_use_failed") return undefined;
  const generation = parseJson(failure.failed_generation);
  const call = Array.isArray(generation) ? generation[0] : generation;
  const args = (call as { arguments?: unknown } | null)?.arguments;
  const input = typeof args === "string" ? parseJson(args) : (args ?? call);
  if (input === undefined || input === null || typeof input !== "object") {
    return { kind: "invalid", problems: [`the ${SUBMIT_RECAP} call didn't match its schema`] };
  }
  return validate(input);
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ─── runRecap ─────────────────────────────────────────────────────────────────────────────────

export interface RunRecapInput {
  readonly recapper: Recapper;
  /** The session's utterances. Only the biased stream's are read: the second witness's never are. */
  readonly utterances: readonly UtteranceFinalV2[];
  readonly proposals: readonly RecapProposal[];
  readonly lens: RecapLensId | null;
  /** From `end.recap.key`: passed to the recapper and referenced nowhere else. */
  readonly apiKey: string;
  /** Aborting it cancels the recap (a purge). The deadline comes from `policy`. */
  readonly signal: AbortSignal;
  readonly policy?: RetryPolicy;
  /** Seams for tests: the clock, the backoff wait, ids, and jitter. */
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly newId?: () => string;
  readonly random?: () => number;
}

export interface RecapResult {
  /** `recap.created`, to append after `session.ended` and before the seal. */
  readonly recap: RecapCreatedV1;
  /** `usage.recorded` for the recap's calls, when any reported tokens. */
  readonly usage: UsageRecordedV1 | null;
  /** The failure as fixed codes, for the log; null when the recap was written or skipped. */
  readonly failure: { readonly code: ExtractionFailure; readonly detail: string } | null;
  /** What happened to each sentence the model wrote (empty unless it answered). */
  readonly trace: readonly SentenceTrace[];
  readonly attempts: number;
  readonly latencyMs: number;
}

/** A recap that was never attempted: no key came with `end`, or there's nothing to recap. */
export function skippedRecap(
  reason: Extract<RecapReason, "no_key" | "no_speech">,
  options: { readonly llm?: { provider: LlmProvider; model: string } | null; newId?: () => string },
): RecapCreatedV1 {
  return {
    recapId: (options.newId ?? uuidv7)(),
    outcome: "skipped",
    reason,
    llm: reason === "no_key" ? null : (options.llm ?? null),
    sentences: [],
    dropped: 0,
    lens: null,
  };
}

/** A recap that was attempted and failed, for `reason`. */
export function failedRecap(
  reason: Exclude<RecapReason, "no_key" | "no_speech">,
  options: { readonly llm: { provider: LlmProvider; model: string } | null; newId?: () => string },
): RecapCreatedV1 {
  return {
    recapId: (options.newId ?? uuidv7)(),
    outcome: "failed",
    reason,
    llm: options.llm,
    sentences: [],
    dropped: 0,
    lens: null,
  };
}

/** Why a recap failed, from the call's failure. A provider timeout is the deadline's. */
export function recapReason(
  failure: Pick<ExtractionError, "code" | "detail">,
): Exclude<RecapReason, "no_key" | "no_speech"> {
  switch (failure.code) {
    case "invalid_output":
      return "invalid_output";
    case "rate_limited":
      return "rate_limited";
    case "provider_error":
      return failure.detail === "timeout" ? "timeout" : "provider_error";
    default:
      // A rejected key, a refusal, or a cancel: the provider didn't write one.
      return "provider_error";
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

/** Utterances with words to recap: the biased stream's, in order. */
export function recapUtterances(utterances: readonly UtteranceFinalV2[]): UtteranceFinalV2[] {
  return utterances.filter(
    (utterance) => utterance.witness !== "unbiased" && utterance.text.trim() !== "",
  );
}

/**
 * Writes the session's recap within the deadline, never throwing for a provider or validation
 * failure. Other errors are bugs, and propagate.
 */
export async function runRecap(input: RunRecapInput): Promise<RecapResult> {
  const { recapper } = input;
  const policy = input.policy ?? RECAP_RETRY_POLICY;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? abortableSleep;
  const newId = input.newId ?? uuidv7;
  const random = input.random ?? Math.random;
  const llm = { provider: recapper.provider, model: recapper.model };
  const utterances = recapUtterances(input.utterances);
  let attempts = 0;
  let latencyMs = 0;
  let usage: TokenUsage = ZERO_USAGE;
  let costUsd = 0;
  const settle = (
    recap: RecapCreatedV1,
    failure: ExtractionError | null,
    trace: readonly SentenceTrace[] = [],
  ): RecapResult => ({
    recap,
    usage: hasTokens(usage)
      ? {
          usageId: newId(),
          kind: "llm",
          provider: recapper.provider,
          model: recapper.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cachedInputTokens > 0 ? { cachedInputTokens: usage.cachedInputTokens } : {}),
          costUsd: roundUsd(costUsd),
          priceTable: recapper.priceTable,
        }
      : null,
    failure: failure ? { code: failure.code, detail: failure.detail } : null,
    trace,
    attempts,
    latencyMs: Math.round(latencyMs),
  });

  if (utterances.length === 0) return settle(skippedRecap("no_speech", { llm, newId }), null);

  // The deadline aborts with a TimeoutError, which the call reports as a provider timeout; the
  // caller's abort keeps its own reason.
  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal.reason);
  if (input.signal.aborted) onAbort();
  else input.signal.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(
    () => controller.abort(new DOMException("recap deadline passed", "TimeoutError")),
    policy.deadlineMs,
  );
  const started = now();
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const call = await recapper.write({
          utterances,
          proposals: input.proposals,
          lens: input.lens,
          apiKey: input.apiKey,
          signal: controller.signal,
        });
        attempts += call.attempts;
        latencyMs += call.latencyMs;
        usage = addUsage(usage, call.usage);
        costUsd += call.costUsd;
        const checked: CheckedRecap = checkRecap(call.output, utterances, recapLens(input.lens));
        return settle(
          {
            recapId: newId(),
            outcome: "created",
            reason: null,
            llm,
            sentences: [...checked.sentences],
            dropped: checked.dropped,
            lens: checked.lens,
          },
          null,
          checked.trace,
        );
      } catch (error) {
        if (!(error instanceof ExtractionError)) throw error;
        attempts += error.attempts;
        latencyMs += error.latencyMs;
        usage = addUsage(usage, error.usage);
        costUsd += error.costUsd;
        const failed = () => settle(failedRecap(recapReason(error), { llm, newId }), error);
        const delay = nextRetryDelay(policy, {
          attempt,
          failure: error,
          elapsedMs: now() - started,
          random: random(),
        });
        if (delay === null) return failed();
        try {
          await sleep(delay, controller.signal);
        } catch {
          return failed();
        }
      }
    }
  } finally {
    clearTimeout(deadline);
    input.signal.removeEventListener("abort", onAbort);
  }
}
