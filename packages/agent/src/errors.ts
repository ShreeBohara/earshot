// How an extraction fails. Every failure becomes an `ExtractionError` with a fixed code and a
// fixed message. The provider's error body, headers, and message are never copied into it, and
// neither is the SDK error that carried them (some providers quote part of a rejected key back),
// so an `ExtractionError` is safe to log whole.
import { APICallError, LoadAPIKeyError } from "ai";
import { type TokenUsage, ZERO_USAGE } from "./usage";

/**
 * Why an extraction failed:
 * - `invalid_output`: the model's output failed validation, retry included;
 * - `key_rejected`: the provider refused the key (401 or 403);
 * - `rate_limited`: the provider answered 429;
 * - `provider_error`: anything else at the provider: a 5xx, an overload, a timeout, a network
 *   failure, or a request it refused;
 * - `refused`: the model declined to answer (a safety refusal);
 * - `cancelled`: the caller's signal aborted the call.
 */
export type ExtractionFailure =
  | "invalid_output"
  | "key_rejected"
  | "rate_limited"
  | "provider_error"
  | "refused"
  | "cancelled";

const MESSAGES: Readonly<Record<ExtractionFailure, string>> = {
  invalid_output: "The model's output failed validation twice.",
  key_rejected: "The LLM provider rejected the key.",
  rate_limited: "The LLM provider is rate limiting this key.",
  provider_error: "The LLM provider failed or couldn't be reached.",
  refused: "The model declined to answer.",
  cancelled: "The extraction was cancelled.",
};

export interface ExtractionErrorInit {
  readonly code: ExtractionFailure;
  /** Whether trying again later can help. */
  readonly retryable: boolean;
  /**
   * A short fixed identifier for logs, such as `http_503`, `timeout`, `tool_use_failed`, or
   * `unexpected:TypeError`. Built from fixed strings and error class names, never messages.
   */
  readonly detail: string;
  /** The provider's HTTP status, when there was one. */
  readonly status?: number;
  /** How long the provider asked us to wait (`retry-after-ms` or `retry-after`). */
  readonly retryAfterMs?: number;
  /** LLM calls made before the failure, retries included. */
  readonly attempts: number;
  /** Time spent waiting on those calls. */
  readonly latencyMs: number;
  /** Tokens the provider reported for those calls: they're billed even when the turn fails. */
  readonly usage: TokenUsage;
  /** What those tokens cost, in USD. */
  readonly costUsd: number;
}

export class ExtractionError extends Error implements ExtractionErrorInit {
  override readonly name = "ExtractionError";
  readonly code: ExtractionFailure;
  readonly retryable: boolean;
  readonly detail: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly usage: TokenUsage;
  readonly costUsd: number;

  constructor(init: ExtractionErrorInit) {
    super(MESSAGES[init.code]);
    this.code = init.code;
    this.retryable = init.retryable;
    this.detail = init.detail;
    if (init.status !== undefined) this.status = init.status;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    this.attempts = init.attempts;
    this.latencyMs = init.latencyMs;
    this.usage = init.usage;
    this.costUsd = init.costUsd;
  }
}

/** A provider failure before it's attributed to attempts: what `classifyCallError` returns. */
export type CallFailure = Pick<
  ExtractionErrorInit,
  "code" | "retryable" | "detail" | "status" | "retryAfterMs"
>;

/** Error class names are safe to log; anything stranger is reported as `Error`. */
function safeName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z0-9_$]{1,64}$/.test(name) ? name : "Error";
}

/**
 * Parses `retry-after-ms`, then `retry-after` in seconds or as an HTTP date, into milliseconds
 * from `nowMs`. Undefined when neither header holds a usable value.
 */
export function retryAfterMs(
  headers: Readonly<Record<string, string>> | undefined,
  nowMs: number,
): number | undefined {
  const ms = headers?.["retry-after-ms"]?.trim();
  if (ms !== undefined && /^\d+(\.\d+)?$/.test(ms)) return Math.round(Number(ms));
  const after = headers?.["retry-after"]?.trim();
  if (after === undefined || after === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(after)) return Math.round(Number(after) * 1000);
  const at = Date.parse(after);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error || error instanceof DOMException) &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * Maps whatever a provider call threw to a failure code. `signal` is the one the call ran with:
 * when it aborted with a `TimeoutError` (the turn's deadline) the failure is a timeout at the
 * provider; any other abort is the caller cancelling.
 */
export function classifyCallError(error: unknown, signal: AbortSignal, nowMs: number): CallFailure {
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    const timedOut =
      (reason instanceof Error || reason instanceof DOMException) && reason.name === "TimeoutError";
    return timedOut
      ? { code: "provider_error", retryable: false, detail: "timeout" }
      : { code: "cancelled", retryable: false, detail: "aborted" };
  }
  if (isAbort(error)) return { code: "provider_error", retryable: true, detail: "timeout" };
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    const wait = retryAfterMs(error.responseHeaders, nowMs);
    const withWait = wait === undefined ? {} : { retryAfterMs: wait };
    if (status === undefined) {
      return { code: "provider_error", retryable: true, detail: "network", ...withWait };
    }
    if (status === 401 || status === 403) {
      return { code: "key_rejected", retryable: false, detail: `http_${status}`, status };
    }
    if (status === 429) {
      return { code: "rate_limited", retryable: true, detail: "http_429", status, ...withWait };
    }
    const retryable = status === 408 || status === 409 || status >= 500;
    return { code: "provider_error", retryable, detail: `http_${status}`, status, ...withWait };
  }
  if (LoadAPIKeyError.isInstance(error)) {
    return { code: "key_rejected", retryable: false, detail: "missing_key" };
  }
  return { code: "provider_error", retryable: false, detail: `unexpected:${safeName(error)}` };
}

/** An `ExtractionError` for a failure, with the attempts, usage, and cost so far. */
export function extractionError(
  failure: CallFailure,
  progress: { attempts: number; latencyMs: number; usage?: TokenUsage; costUsd?: number },
): ExtractionError {
  return new ExtractionError({
    ...failure,
    attempts: progress.attempts,
    latencyMs: Math.round(progress.latencyMs),
    usage: progress.usage ?? ZERO_USAGE,
    costUsd: progress.costUsd ?? 0,
  });
}
