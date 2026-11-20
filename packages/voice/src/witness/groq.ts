// The second witness on Groq (Phase 4 spec WP9 step 1, decision 6): one turn's audio, as a WAV, to
// Groq's OpenAI-compatible transcription endpoint with `whisper-large-v3-turbo`, straight from the
// browser on the user's own Groq key. Groq answers CORS preflights with `*` (probed 2026-11-20).
//
// The request, exactly as the spec gives it: multipart `file` (PCM16 mono 16 kHz WAV), `model`,
// `response_format=verbose_json`, `timestamp_granularities[]=word`, `language=en`,
// `temperature=0`, and no `prompt`, so nothing biases this witness toward the CRM's spellings. The
// key goes only to `api.groq.com`, only in `Authorization: Bearer`, read from the device store for
// the request and dropped after it; no cookie and no referrer go with it.
//
// Handling: a 10 s timeout per attempt, and one retry on 429 or 5xx after `retry-after` (a wait
// past 10 s isn't worth it: that turn fails instead). Words move to the session's audio clock, the
// turn's start plus each word's time, and the utterance is labelled `witness: "unbiased"`.
//
// Confidence is a proxy, exp(segment `avg_logprob`) clamped to [0, 1], which SessionDO never
// compares with the biased witness's. Groq documents no per-word confidence, and says word-only
// granularity "returns only word, start, and end timestamps", so segments may not come back at all
// (spec Appendix B, question 4: the live check settles it). Without them every word gets
// `UNKNOWN_CONFIDENCE`.
import { UtteranceFinalV2, uuidv7 } from "@earshot/core";
import { type Clock, systemClock } from "../stt/socket";
import {
  type TranscribeOptions,
  type UnbiasedUtterance,
  WITNESS_MODEL,
  WITNESS_PROVIDER,
  type WitnessFailure,
  type WitnessResult,
  type WitnessRunner,
} from "./runner";
import { audioMsOf, encodeWav } from "./wav";

export const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
/** Each attempt gives up after this long (spec WP9). */
export const GROQ_REQUEST_TIMEOUT_MS = 10_000;
/** A `retry-after` longer than this isn't waited for: the turn fails as it stands. */
export const GROQ_MAX_RETRY_WAIT_MS = 10_000;
/** The wait before the retry when a 429 or 5xx carries no `retry-after`. */
export const GROQ_DEFAULT_RETRY_WAIT_MS = 1_000;
/** Each word's confidence when the response carries no segment `avg_logprob` to read it from. */
export const UNKNOWN_CONFIDENCE = 0.5;

/** Debug logging: outcomes, statuses, and counts only. Never the key, the audio, or the words. */
export interface WitnessLog {
  debug(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
}

const SILENT_LOG: WitnessLog = { debug: () => {} };

export interface GroqWitnessOptions {
  /**
   * The Groq key from the device store, read for each request and dropped after it. Undefined
   * when the device holds none: the turn is skipped as `no_key`.
   */
  readonly key: () => Promise<string | undefined> | string | undefined;
  /** Defaults to the global `fetch`; tests pass a fake. */
  readonly fetch?: typeof fetch;
  /** For timeouts, the retry wait, and latency. */
  readonly clock?: Clock;
  /** Utterance ids. Defaults to UUIDv7. */
  readonly createId?: () => string;
  readonly timeoutMs?: number;
  readonly maxRetryWaitMs?: number;
  readonly log?: WitnessLog;
}

type Attempt =
  | { readonly kind: "ok"; readonly body: unknown }
  | {
      readonly kind: "retry";
      readonly failure: "rate_limited" | "provider_error";
      /** How long to wait first; undefined when the response didn't say. */
      readonly retryAfterMs: number | undefined;
      readonly status: number;
    }
  | { readonly kind: "fail"; readonly failure: WitnessFailure; readonly status: number | null };

/** The multipart body for one attempt: the spec's fields, in its order, and no `prompt`. */
function requestBody(wav: Uint8Array<ArrayBuffer>): FormData {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "turn.wav");
  form.append("model", WITNESS_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("language", "en");
  form.append("temperature", "0");
  return form;
}

/**
 * `retry-after` in ms: delta seconds ("2", "1.5") or an HTTP date. Undefined when absent or
 * unreadable.
 */
export function retryAfterMs(
  header: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  // An HTTP date names its day and month ("Fri, 20 Nov 2026 10:00:03 GMT"); without a letter it's
  // no date, whatever Date.parse makes of it ("-1" is the year 1 BC).
  if (!/[A-Za-z]/.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

export function createGroqWitness(options: GroqWitnessOptions): WitnessRunner {
  return new GroqWitness(options);
}

class GroqWitness implements WitnessRunner {
  readonly provider = WITNESS_PROVIDER;
  readonly model = WITNESS_MODEL;
  readonly #key: GroqWitnessOptions["key"];
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;
  readonly #createId: () => string;
  readonly #timeoutMs: number;
  readonly #maxRetryWaitMs: number;
  readonly #log: WitnessLog;

  constructor(options: GroqWitnessOptions) {
    this.#key = options.key;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#clock = options.clock ?? systemClock;
    this.#createId = options.createId ?? uuidv7;
    this.#timeoutMs = options.timeoutMs ?? GROQ_REQUEST_TIMEOUT_MS;
    this.#maxRetryWaitMs = options.maxRetryWaitMs ?? GROQ_MAX_RETRY_WAIT_MS;
    this.#log = options.log ?? SILENT_LOG;
  }

  async transcribe(pcm16: Int16Array, options: TranscribeOptions): Promise<WitnessResult> {
    const started = this.#clock.now();
    const latencyMs = () => Math.max(0, Math.round(this.#clock.now() - started));
    let key: string | undefined;
    try {
      key = (await this.#key()) || undefined;
    } catch {
      key = undefined;
    }
    if (key === undefined) {
      this.#log.debug("witness skipped", { reason: "no_key" });
      return { failure: "no_key", latencyMs: latencyMs() };
    }
    const wav = encodeWav(pcm16);
    for (let attempt = 1; ; attempt++) {
      const result = await this.#attempt(key, wav, options.signal);
      if (result.kind === "ok") {
        const utterance = groqUtterance(result.body, {
          turnStartMs: options.turnStartMs,
          utteranceId: this.#createId(),
        });
        if (!utterance) {
          // A body without text, or with nothing heard: there's no unbiased transcript.
          this.#log.debug("witness failed", { attempt, reason: "no_transcript" });
          return { failure: "provider_error", latencyMs: latencyMs() };
        }
        this.#log.debug("witness transcribed", { attempt, words: utterance.words?.length ?? 0 });
        return { utterance, audioMs: audioMsOf(pcm16.length), latencyMs: latencyMs() };
      }
      if (result.kind === "fail") {
        this.#log.debug("witness failed", {
          attempt,
          status: result.status,
          reason: result.failure,
        });
        return { failure: result.failure, latencyMs: latencyMs() };
      }
      const waitMs = result.retryAfterMs ?? GROQ_DEFAULT_RETRY_WAIT_MS;
      if (attempt >= 2 || waitMs > this.#maxRetryWaitMs) {
        this.#log.debug("witness failed", {
          attempt,
          status: result.status,
          reason: result.failure,
        });
        return { failure: result.failure, latencyMs: latencyMs() };
      }
      this.#log.debug("witness retrying", { status: result.status, waitMs });
      if (!(await this.#sleep(waitMs, options.signal))) {
        return { failure: "timeout", latencyMs: latencyMs() };
      }
    }
  }

  async #attempt(
    key: string,
    wav: Uint8Array<ArrayBuffer>,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = this.#clock.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.#fetch(GROQ_TRANSCRIPTIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: requestBody(wav),
        signal: controller.signal,
        // The key is the only credential: no cookies, and the page's URL stays out of Groq's logs.
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      if (response.ok) {
        try {
          return { kind: "ok", body: await response.json() };
        } catch {
          return { kind: "fail", failure: timedOut ? "timeout" : "provider_error", status: null };
        }
      }
      void response.body?.cancel().catch(() => {});
      if (response.status === 429 || response.status >= 500) {
        return {
          kind: "retry",
          failure: response.status === 429 ? "rate_limited" : "provider_error",
          retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
          status: response.status,
        };
      }
      // 400, 401, 403, 413, …: another try would get the same answer.
      return { kind: "fail", failure: "provider_error", status: response.status };
    } catch {
      // A timeout, the caller's abort, a network failure, or a CORS refusal.
      return { kind: "fail", failure: timedOut ? "timeout" : "provider_error", status: null };
    } finally {
      this.#clock.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Waits `ms`, or less if `signal` aborts; false when it did. */
  #sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => {
        this.#clock.clearTimeout(timer);
        resolve(false);
      };
      const timer = this.#clock.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(true);
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
}

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Whitespace runs as one space, trimmed. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function readSegments(value: unknown): Segment[] {
  if (!Array.isArray(value)) return [];
  const out: Segment[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const segment = item as { start?: unknown; end?: unknown; avg_logprob?: unknown };
    const logprob = segment.avg_logprob;
    if (!isTime(segment.start) || !isTime(segment.end)) continue;
    if (typeof logprob !== "number" || !Number.isFinite(logprob)) continue;
    out.push({
      start: segment.start,
      end: Math.max(segment.start, segment.end),
      confidence: Math.min(1, Math.max(0, Math.exp(logprob))),
    });
  }
  return out;
}

/** The segments' confidence, weighted by how long each lasts; undefined without segments. */
function overallConfidence(segments: readonly Segment[]): number | undefined {
  if (segments.length === 0) return undefined;
  let weighted = 0;
  let total = 0;
  for (const segment of segments) {
    const weight = Math.max(segment.end - segment.start, 0.001);
    weighted += segment.confidence * weight;
    total += weight;
  }
  return weighted / total;
}

/**
 * Groq's `verbose_json` as `utterance.final` v2 from the unbiased witness: the text with its
 * whitespace collapsed, each word on the session's clock (`turnStartMs` plus its time, in whole
 * ms), and the confidence proxy. Null for a body with no text, or text with nothing in it.
 */
export function groqUtterance(
  body: unknown,
  options: { readonly turnStartMs: number; readonly utteranceId: string },
): UnbiasedUtterance | null {
  if (typeof body !== "object" || body === null) return null;
  const response = body as { text?: unknown; duration?: unknown; words?: unknown };
  if (typeof response.text !== "string") return null;
  const text = collapse(response.text);
  if (text === "") return null;
  const base = Math.max(0, Math.round(options.turnStartMs));
  const at = (seconds: number) => base + Math.round(seconds * 1000);
  const segments = readSegments((body as { segments?: unknown }).segments);
  const overall = overallConfidence(segments);
  const confidenceAt = (seconds: number) =>
    segments.find((segment) => seconds >= segment.start && seconds <= segment.end)?.confidence ??
    overall ??
    UNKNOWN_CONFIDENCE;
  const words: NonNullable<UtteranceFinalV2["words"]> = [];
  if (Array.isArray(response.words)) {
    for (const item of response.words as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const word = item as { word?: unknown; start?: unknown; end?: unknown };
      if (typeof word.word !== "string" || !isTime(word.start) || !isTime(word.end)) continue;
      const w = collapse(word.word);
      if (w === "") continue;
      const startMs = at(word.start);
      words.push({
        w,
        startMs,
        endMs: Math.max(startMs, at(word.end)),
        confidence: round3(confidenceAt((word.start + word.end) / 2)),
      });
    }
  }
  const first = words[0]?.startMs ?? (segments[0] ? at(segments[0].start) : base);
  const lastSegment = segments.at(-1);
  const last =
    words.at(-1)?.endMs ??
    (lastSegment ? at(lastSegment.end) : isTime(response.duration) ? at(response.duration) : first);
  const utterance = UtteranceFinalV2.safeParse({
    utteranceId: options.utteranceId,
    text,
    confidence: round3(overall ?? UNKNOWN_CONFIDENCE),
    ...(words.length > 0 ? { words } : {}),
    startMs: first,
    endMs: Math.max(first, last),
    witness: "unbiased",
  });
  return utterance.success ? { ...utterance.data, witness: "unbiased" } : null;
}
