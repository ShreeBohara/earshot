import { UtteranceFinalV2 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  createGroqWitness,
  GROQ_TRANSCRIPTIONS_URL,
  groqUtterance,
  retryAfterMs,
  UNKNOWN_CONFIDENCE,
  type WitnessResult,
} from "../src/witness";
import { groqRateLimited, groqVerbose, groqWordsOnly } from "./fixtures/groq";
import { counterIds } from "./support/ids";
import { ManualClock } from "./support/manual-clock";

/** A canary shaped like a Groq key, unique to this file. */
const KEY = "gsk_witnesscanary0123456789abcdefghijklmnopqrstuv";
const TURN_START_MS = 41_000;

interface Request {
  readonly url: string;
  readonly init: RequestInit;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fake `fetch` answering each request with the next response (or making it hang). */
function fakeFetch(responses: readonly (Response | "hang" | "network")[]) {
  const requests: Request[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    requests.push({ url: String(input), init });
    const next = responses[requests.length - 1] ?? json({ error: "unexpected" }, 500);
    if (next === "network") throw new TypeError("Failed to fetch");
    if (next === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    }
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

/** A manual clock that remembers every delay it was asked for, so a test can wait for one. */
class TimerClock extends ManualClock {
  readonly scheduled: number[] = [];

  override setTimeout(callback: () => void, ms: number): unknown {
    this.scheduled.push(ms);
    return super.setTimeout(callback, ms);
  }
}

/**
 * Waits, in real time, until `condition` holds: the request's promises settle on their own. Up to
 * about 10 s, for CI's slower runners.
 */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the condition never held");
}

function harness(responses: readonly (Response | "hang" | "network")[], key = KEY) {
  const clock = new TimerClock();
  const fake = fakeFetch(responses);
  const logs: string[] = [];
  const witness = createGroqWitness({
    key: async () => key || undefined,
    fetch: fake.fetch,
    clock,
    createId: counterIds(),
    log: { debug: (event, fields) => logs.push(JSON.stringify({ event, ...fields })) },
  });
  return { clock, witness, logs, requests: fake.requests };
}

/** One second of a quiet tone, PCM16 at 16 kHz. */
function pcm(ms = 1_000): Int16Array {
  const samples = new Int16Array((ms * 16_000) / 1000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(800 * Math.sin(i / 7));
  return samples;
}

async function bodyOf(request: Request) {
  const form = request.init.body;
  if (!(form instanceof FormData)) throw new Error("the body isn't multipart form data");
  const file = form.get("file");
  if (!(file instanceof Blob)) throw new Error("no file part");
  return { form, file, bytes: new Uint8Array(await file.arrayBuffer()) };
}

describe("the Groq witness's request", () => {
  it("posts the turn as a WAV to Groq's transcription endpoint with exactly the spec's fields", async () => {
    const h = harness([json(groqVerbose)]);
    const audio = pcm(2_000);
    await h.witness.transcribe(audio, { turnStartMs: TURN_START_MS });
    expect(h.requests).toHaveLength(1);
    const [request] = h.requests;
    if (!request) throw new Error("no request");
    expect(request.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(request.url).toBe(GROQ_TRANSCRIPTIONS_URL);
    expect(request.init.method).toBe("POST");
    expect(request.init.credentials).toBe("omit");
    expect(request.init.referrerPolicy).toBe("no-referrer");
    const { form, file, bytes } = await bodyOf(request);
    expect([...form.keys()]).toEqual([
      "file",
      "model",
      "response_format",
      "timestamp_granularities[]",
      "language",
      "temperature",
    ]);
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["word"]);
    expect(form.get("language")).toBe("en");
    expect(form.get("temperature")).toBe("0");
    expect(form.has("prompt")).toBe(false); // nothing biases this witness
    expect(file.type).toBe("audio/wav");
    expect((file as File).name).toBe("turn.wav");
    expect(bytes.byteLength).toBe(44 + audio.length * 2);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16_000);
  });

  it("sends the key only to api.groq.com, only in Authorization, and nowhere else: not the URL, the body, the result, or a log", async () => {
    const h = harness([json(groqRateLimited, 429, { "retry-after": "1" }), json(groqVerbose)]);
    const pending = h.witness.transcribe(pcm(), { turnStartMs: TURN_START_MS });
    await until(() => h.clock.scheduled.includes(1_000)); // the retry's wait
    await h.clock.advance(1_000);
    const result = await pending;
    expect(h.requests).toHaveLength(2);
    for (const request of h.requests) {
      const url = new URL(request.url);
      expect(url.host).toBe("api.groq.com");
      expect(url.protocol).toBe("https:");
      expect(request.url).not.toContain(KEY);
      const headers = new Headers(request.init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
      for (const [name, value] of headers) {
        if (name !== "authorization") expect(value).not.toContain(KEY);
      }
      const { form, bytes } = await bodyOf(request);
      for (const [, value] of form) {
        if (typeof value === "string") expect(value).not.toContain(KEY);
      }
      // The key's bytes aren't in the WAV either.
      expect(Buffer.from(bytes).includes(Buffer.from(KEY))).toBe(false);
    }
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(h.logs.length).toBeGreaterThan(0);
    expect(h.logs.join("\n")).not.toContain(KEY);
    expect(h.logs.join("\n")).not.toContain("Atmo"); // the log carries no words either
  });

  it("skips a turn as no_key when the device holds no Groq key, with no request", async () => {
    const h = harness([json(groqVerbose)], "");
    const result = await h.witness.transcribe(pcm(), { turnStartMs: TURN_START_MS });
    expect(result).toEqual({ failure: "no_key", latencyMs: 0 });
    expect(h.requests).toHaveLength(0);
  });
});

describe("the Groq witness's answer", () => {
  it("maps verbose_json to an unbiased utterance on the session's clock, with exp(avg_logprob) as the confidence proxy", async () => {
    const h = harness([json(groqVerbose)]);
    const pending = h.witness.transcribe(pcm(7_400), { turnStartMs: TURN_START_MS });
    const result = await pending;
    if (!("utterance" in result)) throw new Error(`failed: ${result.failure}`);
    const { utterance } = result;
    expect(UtteranceFinalV2.parse(utterance)).toEqual(utterance);
    expect(utterance).toMatchObject({
      utteranceId: "00000000-0000-7000-8000-000000000001",
      // Whitespace runs collapse and the leading space goes.
      text: "Debrief from Atmo Systems. Raj Patel says finance wants to restart the onboarding package.",
      witness: "unbiased",
      startMs: TURN_START_MS + 320,
      endMs: TURN_START_MS + 6_900,
    });
    expect(utterance.words?.slice(2, 4)).toEqual([
      { w: "Atmo", startMs: TURN_START_MS + 1_100, endMs: TURN_START_MS + 1_460, confidence: 0.8 },
      {
        w: "Systems",
        startMs: TURN_START_MS + 1_520,
        endMs: TURN_START_MS + 2_100,
        confidence: 0.8,
      },
    ]);
    expect(utterance.words?.at(-1)).toMatchObject({ w: "package", confidence: 0.9 });
    // The utterance's confidence weighs each segment by its length: (0.8 × 1.78 + 0.9 × 4.5) / 6.28.
    expect(utterance.confidence).toBeCloseTo((0.8 * 1.78 + 0.9 * 4.5) / 6.28, 3);
    expect(result.audioMs).toBe(7_400);
  });

  it("gives every word UNKNOWN_CONFIDENCE when only words come back, with no segment to read", () => {
    const utterance = groqUtterance(groqWordsOnly, {
      turnStartMs: 0,
      utteranceId: "00000000-0000-7000-8000-000000000009",
    });
    expect(utterance?.confidence).toBe(UNKNOWN_CONFIDENCE);
    expect(new Set(utterance?.words?.map((word) => word.confidence))).toEqual(
      new Set([UNKNOWN_CONFIDENCE]),
    );
  });

  it("keeps a transcript with no word timings, timed by its segments", () => {
    const { words: _words, ...segmentsOnly } = groqVerbose;
    const utterance = groqUtterance(segmentsOnly, {
      turnStartMs: 5_000,
      utteranceId: "00000000-0000-7000-8000-000000000009",
    });
    expect(utterance).toMatchObject({ startMs: 5_320, endMs: 11_900 });
    expect(utterance?.words).toBeUndefined();
  });

  it("finds no transcript in a body without text, or with nothing in it", () => {
    const id = "00000000-0000-7000-8000-000000000009";
    expect(groqUtterance({ text: "   " }, { turnStartMs: 0, utteranceId: id })).toBeNull();
    expect(groqUtterance({ words: [] }, { turnStartMs: 0, utteranceId: id })).toBeNull();
    expect(groqUtterance("Debrief", { turnStartMs: 0, utteranceId: id })).toBeNull();
  });
});

describe("the Groq witness's failures", () => {
  /** Runs one transcription, letting each delay in `waits` pass once it's been asked for. */
  const run = async (
    responses: readonly (Response | "hang" | "network")[],
    waits: readonly number[] = [],
  ): Promise<{ result: WitnessResult; requests: number }> => {
    const h = harness(responses);
    const pending = h.witness.transcribe(pcm(), { turnStartMs: TURN_START_MS });
    let asked = 0;
    for (const ms of waits) {
      await until(() => h.clock.scheduled.filter((delay) => delay === ms).length > asked);
      asked = h.clock.scheduled.filter((delay) => delay === ms).length;
      await h.clock.advance(ms);
    }
    return { result: await pending, requests: h.requests.length };
  };

  it("retries a 429 once after retry-after, and succeeds", async () => {
    const h = harness([json(groqRateLimited, 429, { "retry-after": "2" }), json(groqVerbose)]);
    const pending = h.witness.transcribe(pcm(), { turnStartMs: TURN_START_MS });
    await until(() => h.clock.scheduled.includes(2_000));
    await h.clock.advance(1_999);
    expect(h.requests).toHaveLength(1);
    await h.clock.advance(1);
    const result = await pending;
    expect(h.requests).toHaveLength(2);
    expect("utterance" in result && result.latencyMs).toBe(2_000);
  });

  it("gives up after a second 429 as rate_limited, and after a second 5xx as provider_error", async () => {
    // No retry-after: the retry waits a second.
    await expect(
      run([json(groqRateLimited, 429), json(groqRateLimited, 429)], [1_000]),
    ).resolves.toMatchObject({ result: { failure: "rate_limited" }, requests: 2 });
    await expect(run([json({}, 503), json({}, 502)], [1_000])).resolves.toMatchObject({
      result: { failure: "provider_error" },
      requests: 2,
    });
  });

  it("doesn't wait out a retry-after past 10 s: the turn fails now", async () => {
    await expect(
      run([json(groqRateLimited, 429, { "retry-after": "30" }), json(groqVerbose)]),
    ).resolves.toMatchObject({ result: { failure: "rate_limited" }, requests: 1 });
  });

  it("doesn't retry a refusal: a bad key or a bad request is a provider_error at once", async () => {
    await expect(run([json({ error: { code: "invalid_api_key" } }, 401)])).resolves.toMatchObject({
      result: { failure: "provider_error" },
      requests: 1,
    });
    await expect(run([json({}, 400)])).resolves.toMatchObject({
      result: { failure: "provider_error" },
      requests: 1,
    });
  });

  it("times out an attempt after 10 s, without retrying it", async () => {
    await expect(run(["hang", json(groqVerbose)], [10_000])).resolves.toMatchObject({
      result: { failure: "timeout", latencyMs: 10_000 },
      requests: 1,
    });
  });

  it("calls a network failure (or a CORS refusal) a provider_error", async () => {
    await expect(run(["network"])).resolves.toMatchObject({
      result: { failure: "provider_error" },
      requests: 1,
    });
  });

  it("calls an answer with no transcript, or that isn't JSON, a provider_error", async () => {
    await expect(run([json({ text: "" })])).resolves.toMatchObject({
      result: { failure: "provider_error" },
    });
    await expect(
      run([new Response("<html>gateway</html>", { status: 200 })]),
    ).resolves.toMatchObject({ result: { failure: "provider_error" } });
  });
});

describe("retryAfterMs", () => {
  it("reads delta seconds and HTTP dates, and nothing else", () => {
    expect(retryAfterMs("2")).toBe(2_000);
    expect(retryAfterMs(" 1.25 ")).toBe(1_250);
    const now = Date.parse("2026-11-20T10:00:00Z");
    expect(retryAfterMs("Fri, 20 Nov 2026 10:00:03 GMT", now)).toBe(3_000);
    expect(retryAfterMs("Fri, 20 Nov 2026 09:00:00 GMT", now)).toBe(0);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
    expect(retryAfterMs("-1")).toBeUndefined();
  });
});
