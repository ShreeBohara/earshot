// The ProposalExtractor and its two adapters on AI SDK 7 (Phase 3 spec, WP5 steps 2–4).
//
// Both adapters share one loop: build the prompt, force one call of `submit_proposals`, validate
// its input with Zod, and on a validation failure try once more with the problems listed. The
// spec asks for that retry on Groq, which has no strict tool calls; Anthropic's strict mode makes
// it rare there, but the semantic checks (dates, lengths) can still fail, so it runs for both.
//
// The provider is built inside `extract()`, from the key passed for that one call, and dropped
// when the call returns. Nothing in this module keeps a key.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import type { LlmProvider, UtteranceFinalV2 } from "@earshot/core";
import {
  APICallError,
  generateText,
  type JSONSchema7,
  jsonSchema,
  type LanguageModel,
  ToolChoiceViolationError,
  tool,
} from "ai";
import { type CallFailure, classifyCallError, extractionError } from "./errors";
import { type AiGatewayConfig, providerEndpoint } from "./gateway";
import {
  findLlmPrice,
  LLM_PRICES,
  type LlmPriceRow,
  type LlmPriceTable,
  llmCostUsd,
  roundUsd,
} from "./prices";
import { buildPrompt, withFeedback } from "./prompt";
import {
  describeIssues,
  SUBMIT_PROPOSALS,
  SUBMIT_PROPOSALS_DESCRIPTION,
  SUBMIT_PROPOSALS_JSON_SCHEMA,
  type SubmitProposalsInput,
  submitProposalsInput,
  type ToolProposal,
} from "./schema";
import { addUsage, fromSdkUsage, type TokenUsage, ZERO_USAGE } from "./usage";

/** The model each provider's adapter runs (spec Appendix A). */
export const LLM_MODELS = {
  anthropic: "claude-haiku-5-5",
  groq: "openai/gpt-oss-20b",
} as const satisfies Record<LlmProvider, string>;

export interface ExtractInput {
  /** The turn's final utterances from the biased witness, in order. At least one. */
  readonly utterances: readonly UtteranceFinalV2[];
  /** When the call happened (ISO 8601): the session's start. Relative dates resolve against it. */
  readonly callTime: string;
  /** The rep's IANA time zone. An unknown zone falls back to UTC. */
  readonly timeZone: string;
  /** The name of the account open in Earshot, which the prompt names on one line; or none. */
  readonly openAccount?: string | null;
  /** The user's LLM key, for this call only. Never stored, logged, or returned. */
  readonly apiKey: string;
  readonly signal: AbortSignal;
}

export interface ExtractResult {
  /**
   * The proposals as the model drafted them, validated: quoted fields and the words that named
   * each record. May be empty. `understand` turns them into `proposal.created` v2 payloads.
   */
  readonly drafts: readonly ToolProposal[];
  /** Tokens over every call this extraction made. */
  readonly usage: TokenUsage;
  /** What those calls cost, priced per call from the extractor's price table. */
  readonly costUsd: number;
  /** 2 when the first output failed validation and the retry passed. */
  readonly attempts: 1 | 2;
  /** Time spent waiting on the LLM, summed over the calls. */
  readonly latencyMs: number;
}

export interface ProposalExtractor {
  readonly provider: LlmProvider;
  readonly model: string;
  /** The price row its costs come from, and the table's date for `usage.recorded`. */
  readonly price: LlmPriceRow;
  readonly priceTable: string;
  /**
   * Drafts the turn's proposals. Throws `ExtractionError` for every provider or validation
   * failure, carrying the attempts, latency, usage, and cost so far.
   */
  extract(input: ExtractInput): Promise<ExtractResult>;
}

export interface ExtractorOptions {
  readonly provider: LlmProvider;
  /** Must be the provider's model in `LLM_MODELS`; other models have no price row. */
  readonly model?: string;
  /** The `fetch` the provider uses: a cassette in tests and evals, the global one otherwise. */
  readonly fetch?: typeof fetch;
  /** Route through Cloudflare AI Gateway (see `aiGatewayFromEnv`). Direct when absent. */
  readonly gateway?: AiGatewayConfig | null;
  /** The price table. Defaults to `LLM_PRICES`. */
  readonly prices?: LlmPriceTable;
  /** The clock for `latencyMs`. */
  readonly now?: () => number;
  /**
   * Marks the stable prefix for Anthropic's prompt cache: the tool definition, which every call
   * sends unchanged, and the system prompt, which stays the same through a session (the call time
   * and the open account). Neither marker changes a word the model sees. Off by default:
   * production doesn't cache yet (spec §8 keeps it as a latency lever), and the committed
   * cassettes key on requests without the markers. The live smoke eval turns it on (Phase 4 WP11;
   * ADR-0031). Groq ignores it.
   */
  readonly promptCache?: boolean;
}

/** Anthropic's 5-minute cache breakpoint, as AI SDK provider options. */
const EPHEMERAL_CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

export interface ProviderCall {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch: typeof fetch | undefined;
}

/** What differs between the two providers. */
export interface Adapter {
  createModel(call: ProviderCall, model: string): LanguageModel;
  /** Anthropic's strict tool use; Groq has none for tools. */
  readonly strict: boolean;
  readonly providerOptions: NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;
  /** Room for the tool call, and on Groq for the hidden reasoning that bills as output. */
  readonly maxOutputTokens: number;
}

/** Each provider's adapter: the extractor's, and the recap's (`./recap/run.ts`) too. */
export const ADAPTERS: Readonly<Record<LlmProvider, Adapter>> = {
  anthropic: {
    createModel: ({ apiKey, baseURL, headers, fetch }, model) =>
      createAnthropic({ apiKey, baseURL, headers: { ...headers }, fetch })(model),
    strict: true,
    // At most one tool_use block, so a forced call is exactly one call. Haiku 5.5 skips thinking
    // on a forced tool call, and takes no temperature, so neither is set.
    providerOptions: { anthropic: { disableParallelToolUse: true } },
    maxOutputTokens: 4_096,
  },
  groq: {
    createModel: ({ apiKey, baseURL, headers, fetch }, model) =>
      createGroq({ apiKey, baseURL, headers: { ...headers }, fetch })(model),
    strict: false,
    // gpt-oss always reasons; "low" is the least @ai-sdk/groq offers it (sent as reasoning_effort).
    providerOptions: { groq: { reasoningEffort: "low" } },
    maxOutputTokens: 8_192,
  },
};

export function createProposalExtractor(options: ExtractorOptions): ProposalExtractor {
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
  const cache = options.promptCache === true && provider === "anthropic";
  const submit = tool({
    description: SUBMIT_PROPOSALS_DESCRIPTION,
    // No `validate`: the SDK only parses the JSON, and every check runs below with Zod.
    inputSchema: jsonSchema(SUBMIT_PROPOSALS_JSON_SCHEMA as JSONSchema7),
    ...(adapter.strict ? { strict: true } : {}),
    // Tools come first in the prompt, so this breakpoint caches a prefix every session shares.
    ...(cache ? { providerOptions: EPHEMERAL_CACHE } : {}),
  });

  return {
    provider,
    model,
    price,
    priceTable: table.date,
    async extract(input) {
      if (input.utterances.length === 0)
        throw new RangeError("a turn needs at least one utterance");
      const prompt = buildPrompt(input);
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
        // Usage arrives through the callback even when the SDK then throws (a forced tool that
        // wasn't called), because those tokens are billed too.
        let callUsage: TokenUsage | undefined;
        let outcome: AttemptOutcome | undefined;
        let failure: CallFailure | undefined;
        try {
          const result = await generateText({
            model: languageModel,
            // With the cache on, the system prompt is the second breakpoint: the session's later
            // calls, a retry's included, read the tools and it back.
            instructions: cache
              ? { role: "system", content: prompt.instructions, providerOptions: EPHEMERAL_CACHE }
              : prompt.instructions,
            messages: [
              {
                role: "user",
                content: problems ? withFeedback(prompt.transcript, problems) : prompt.transcript,
              },
            ],
            tools: { [SUBMIT_PROPOSALS]: submit },
            toolChoice: { type: "tool", toolName: SUBMIT_PROPOSALS },
            maxRetries: 0,
            maxOutputTokens: adapter.maxOutputTokens,
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
            drafts: outcome.input.proposals,
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

type AttemptOutcome =
  | { readonly kind: "valid"; readonly input: SubmitProposalsInput }
  | { readonly kind: "invalid"; readonly problems: readonly string[] }
  | { readonly kind: "refused" };

const REFUSED: CallFailure = { code: "refused", retryable: false, detail: "content_filter" };
const UNEXPECTED: CallFailure = { code: "provider_error", retryable: false, detail: "unexpected" };
const NO_CALL = `the reply had no ${SUBMIT_PROPOSALS} call; call it, with an empty list if needed`;
const NOT_JSON = `the ${SUBMIT_PROPOSALS} arguments weren't valid JSON`;
const TRUNCATED = "the output was cut off at the token limit; submit fewer or shorter proposals";

/** The parts of a generateText content part this module reads. */
interface ContentPartShape {
  readonly type: string;
  readonly toolName?: string;
  readonly input?: unknown;
  readonly invalid?: boolean;
}

/**
 * Reads the forced tool call out of a response. Several calls (Anthropic can, in principle) are
 * merged in order. No call, unparseable arguments, or a schema failure are all invalid output.
 */
function readOutput(content: readonly ContentPartShape[], finishReason: string): AttemptOutcome {
  const calls = content.filter(
    (part) => part.type === "tool-call" && part.toolName === SUBMIT_PROPOSALS,
  );
  if (calls.length === 0) {
    if (finishReason === "content-filter") return { kind: "refused" };
    if (finishReason === "length") return { kind: "invalid", problems: [TRUNCATED] };
    return { kind: "invalid", problems: [NO_CALL] };
  }
  const merged: ToolProposal[] = [];
  for (const call of calls) {
    if (typeof call.input === "string") {
      return { kind: "invalid", problems: finishReason === "length" ? [TRUNCATED] : [NOT_JSON] };
    }
    const outcome = validate(call.input);
    if (outcome.kind !== "valid") return outcome;
    merged.push(...outcome.input.proposals);
  }
  // Each call passed alone; together they must still be within the per-turn limit.
  return validate({ proposals: merged });
}

/**
 * AI SDK 7 throws `ToolChoiceViolationError` when a forced tool isn't called, instead of
 * returning the reply. A refusal (Anthropic's `stop_reason: "refusal"`) is the model declining;
 * anything else, a truncated reply included, is invalid output and gets the retry. Returns
 * undefined for any other error.
 */
function unansweredToolChoice(error: unknown): AttemptOutcome | undefined {
  if (!ToolChoiceViolationError.isInstance(error)) return undefined;
  if (error.finishReason === "content-filter") return { kind: "refused" };
  return { kind: "invalid", problems: [error.finishReason === "length" ? TRUNCATED : NO_CALL] };
}

function validate(input: unknown): AttemptOutcome {
  const parsed = submitProposalsInput.safeParse(input);
  return parsed.success
    ? { kind: "valid", input: parsed.data }
    : { kind: "invalid", problems: describeIssues(parsed.error) };
}

/**
 * Groq checks tool arguments against the schema itself and answers 400 `tool_use_failed`, with
 * the model's output in `failed_generation`, when they don't fit. That's invalid output, not a
 * provider error: the arguments are read back out and validated here, so the retry gets the same
 * problems as for any other invalid call, and an output that passes Zod is used as it is.
 * Returns undefined for any other error.
 */
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
    return {
      kind: "invalid",
      problems: [`the ${SUBMIT_PROPOSALS} call didn't match its schema`],
    };
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
