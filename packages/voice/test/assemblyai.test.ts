import { UtteranceFinalV2 } from "@earshot/core";
import { beforeEach, describe, expect, it } from "vitest";
import { SttConnectError, type SttConnection, type SttEvent } from "../src/stt/adapter";
import { assemblyAiUrl, createAssemblyAiAdapter } from "../src/stt/assemblyai";
import { FakeSocketServer, settle } from "../src/testing/fake-socket";
import { assemblyAi } from "./fixtures/providers";
import { counterIds } from "./support/ids";
import { ManualClock } from "./support/manual-clock";

const TOKEN = "aai-temp-token-0123456789abcdef";
// Exactly what POST /api/voice/token answers with.
const credential = {
  provider: "assemblyai",
  credential: TOKEN,
  expiresAt: "2026-11-15T12:01:00.000Z",
  url: "wss://streaming.assemblyai.com",
} as const;

let server: FakeSocketServer;
let clock: ManualClock;

beforeEach(() => {
  server = new FakeSocketServer();
  server.onConnection = (socket) => socket.accept();
  clock = new ManualClock();
});

function adapter(options: Parameters<typeof createAssemblyAiAdapter>[0] = {}) {
  return createAssemblyAiAdapter({
    socket: server.factory,
    clock,
    createId: counterIds(),
    ...options,
  });
}

async function connect(
  options: Parameters<typeof createAssemblyAiAdapter>[0] = {},
  connectOptions: { keyterms?: string[]; baseOffsetMs?: number } = {},
) {
  const connection = await adapter(options).connect({
    credential,
    keyterms: connectOptions.keyterms ?? ["Acme", "Initech"],
    baseOffsetMs: connectOptions.baseOffsetMs ?? 0,
  });
  const events: SttEvent[] = [];
  connection.on((event) => events.push(event));
  return { connection, events, socket: server.last };
}

describe("connecting", () => {
  it("passes the token, 16 kHz PCM16, and the keyterms as a JSON array, with no subprotocol", async () => {
    const { socket } = await connect();
    expect(`${socket.url.origin}${socket.url.pathname}`).toBe(
      "wss://streaming.assemblyai.com/v3/ws",
    );
    const params = socket.url.searchParams;
    expect(params.get("token")).toBe(TOKEN);
    expect(params.get("sample_rate")).toBe("16000");
    expect(params.get("encoding")).toBe("pcm_s16le");
    expect(params.get("format_turns")).toBe("false");
    expect(params.get("inactivity_timeout")).toBe("30");
    expect(JSON.parse(params.get("keyterms_prompt") ?? "null")).toEqual(["Acme", "Initech"]);
    expect(socket.protocols).toEqual([]);
  });

  it("cuts the keyterms to AssemblyAI's limits: 100 terms of at most 50 characters", async () => {
    const terms = ["X".repeat(51), ...Array.from({ length: 120 }, (_, i) => `Company ${i}`)];
    const { socket } = await connect({}, { keyterms: terms });
    const sent = JSON.parse(socket.url.searchParams.get("keyterms_prompt") ?? "[]") as string[];
    expect(sent).toHaveLength(100);
    expect(sent).not.toContain("X".repeat(51));
    expect(sent[0]).toBe("Company 0");
  });

  it("leaves out an empty keyterm list, and adds the model and tuning parameters", async () => {
    const { socket } = await connect(
      { speechModel: "universal-streaming-english", params: { max_turn_silence: "900" } },
      { keyterms: [] },
    );
    expect(socket.url.searchParams.has("keyterms_prompt")).toBe(false);
    expect(socket.url.searchParams.get("speech_model")).toBe("universal-streaming-english");
    expect(socket.url.searchParams.get("max_turn_silence")).toBe("900");
  });

  it("appends /v3/ws to the base URL the token route answers with (a regional host here)", () => {
    const url = new URL(
      assemblyAiUrl(
        {
          credential: { ...credential, url: "wss://streaming.eu.assemblyai.com" },
          keyterms: [],
          baseOffsetMs: 0,
        },
        {},
      ),
    );
    expect(`${url.origin}${url.pathname}`).toBe("wss://streaming.eu.assemblyai.com/v3/ws");
    expect(url.searchParams.get("token")).toBe(TOKEN);
  });

  it("refuses a Deepgram credential before opening any socket", async () => {
    const failure = adapter().connect({
      credential: { ...credential, provider: "deepgram" },
      keyterms: [],
      baseOffsetMs: 0,
    });
    await expect(failure).rejects.toMatchObject({ code: "bad_request", retryable: false });
    expect(server.sockets).toHaveLength(0);
  });

  it("rejects when the handshake fails, as a retryable connection_failed", async () => {
    server.onConnection = (socket) => socket.refuse(1006);
    const failure = adapter().connect({ credential, keyterms: [], baseOffsetMs: 0 });
    await expect(failure).rejects.toBeInstanceOf(SttConnectError);
    await expect(failure).rejects.toMatchObject({ code: "connection_failed", retryable: true });
  });

  it("reads AssemblyAI's close codes before opening", async () => {
    server.onConnection = (socket) => socket.refuse(1008, "Unauthorized connection");
    await expect(
      adapter().connect({ credential, keyterms: [], baseOffsetMs: 0 }),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
    server.onConnection = (socket) => socket.refuse(4029, "Too many streams");
    await expect(
      adapter().connect({ credential, keyterms: [], baseOffsetMs: 0 }),
    ).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 12_000,
    });
  });

  it("times out a handshake that never finishes, and closes the socket", async () => {
    server.onConnection = undefined;
    const failure = adapter({ openTimeoutMs: 5_000 }).connect({
      credential,
      keyterms: [],
      baseOffsetMs: 0,
    });
    const assertion = expect(failure).rejects.toMatchObject({ code: "timeout", retryable: true });
    await clock.advance(5_000);
    await assertion;
    expect(server.last.clientClose).toBeDefined();
  });

  it("gives up when the signal aborts, and closes the socket", async () => {
    server.onConnection = undefined;
    const abort = new AbortController();
    const failure = adapter().connect({
      credential,
      keyterms: [],
      baseOffsetMs: 0,
      signal: abort.signal,
    });
    abort.abort(new Error("stopped"));
    await expect(failure).rejects.toThrow("stopped");
    expect(server.last.clientClose).toBeDefined();
  });
});

describe("streaming", () => {
  it("sends PCM16 as binary, byte for byte", async () => {
    const { connection, socket } = await connect();
    const pcm = Int16Array.from({ length: 1_024 }, (_, i) => i - 512);
    connection.send(pcm);
    expect(socket.audio).toEqual(pcm);
  });

  it("updates keyterms mid-stream with UpdateConfiguration, which replaces the list", async () => {
    const { connection, socket } = await connect();
    await connection.updateKeyterms(["Globex", "globex", "Y".repeat(60), "Hooli"]);
    expect(socket.json).toContainEqual({
      type: "UpdateConfiguration",
      keyterms_prompt: ["Globex", "Hooli"],
    });
  });

  it("sends ForceEndpoint to finalize and KeepAlive to stay open", async () => {
    const { connection, socket } = await connect();
    connection.finalize();
    connection.keepAlive();
    expect(socket.json).toEqual([{ type: "ForceEndpoint" }, { type: "KeepAlive" }]);
  });
});

describe("turns", () => {
  it("maps a partial Turn to a partial with every word so far, on the session clock", async () => {
    const { socket, events } = await connect({}, { baseOffsetMs: 30_000 });
    socket.sendJson(assemblyAi.begin);
    socket.sendJson(assemblyAi.partial);
    await settle();
    expect(events).toEqual([
      { type: "partial", text: "acme renew", startMs: 31_440, endMs: 31_920 },
    ]);
  });

  it("maps an end-of-turn Turn to an utterance.final v2 and an end of turn", async () => {
    const { socket, events } = await connect({}, { baseOffsetMs: 30_000 });
    socket.sendJson(assemblyAi.endOfTurn);
    await settle();
    expect(events.map((event) => event.type)).toEqual(["final", "end_of_turn"]);
    const final = events[0];
    if (final?.type !== "final") throw new Error("expected a final");
    expect(UtteranceFinalV2.parse(final.utterance)).toEqual(final.utterance);
    expect(final.utterance).toMatchObject({
      text: "acme renewed for two years",
      startMs: 31_440,
      endMs: 33_040,
      witness: "biased",
    });
    expect(final.utterance.words?.[1]).toEqual({
      w: "renewed",
      startMs: 31_760,
      endMs: 32_160,
      confidence: 0.87,
    });
    expect(final.utterance.confidence).toBeCloseTo((0.91 + 0.87 + 0.99 + 0.95 + 0.93) / 5, 10);
  });

  it("with formatTurns, waits for the formatted copy and emits it once", async () => {
    const { socket, events } = await connect({ formatTurns: true });
    expect(socket.url.searchParams.get("format_turns")).toBe("true");
    socket.sendJson(assemblyAi.endOfTurn);
    socket.sendJson(assemblyAi.formattedEndOfTurn);
    socket.sendJson(assemblyAi.formattedEndOfTurn);
    await settle();
    const finals = events.filter((event) => event.type === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.type === "final" && finals[0].utterance.text).toBe(
      "Acme renewed for two years.",
    );
  });

  it("ignores an end-of-turn repeat for the same turn_order", async () => {
    const { socket, events } = await connect();
    socket.sendJson(assemblyAi.endOfTurn);
    socket.sendJson(assemblyAi.endOfTurn);
    await settle();
    expect(events.filter((event) => event.type === "final")).toHaveLength(1);
  });

  it("raises a provider error message as a non-fatal error", async () => {
    const { socket, events } = await connect();
    socket.sendJson({ error: "Audio chunk too short" });
    await settle();
    expect(events).toEqual([
      { type: "error", code: "provider_error", message: "Audio chunk too short", fatal: false },
    ]);
  });
});

describe("closing and usage", () => {
  it("sends Terminate, waits for Termination, and reports AssemblyAI's own billing numbers", async () => {
    const { connection, socket, events } = await connect();
    await clock.advance(7_000);
    const closing = connection.close();
    expect(socket.json.at(-1)).toEqual({ type: "Terminate" });
    socket.sendJson(assemblyAi.termination);
    socket.close(1000);
    const usage = await closing;
    expect(usage).toEqual({
      provider: "assemblyai",
      model: "universal-streaming-english",
      audioMs: 12_480,
      socketMs: 15_020,
      source: "provider",
    });
    expect(events.at(-1)).toEqual({ type: "closed", code: 1000, expected: true, usage });
  });

  it("closes the socket itself if the provider never does, with the client's own count", async () => {
    const { connection, socket } = await connect();
    connection.send(new Int16Array(16_000));
    await clock.advance(3_000);
    const closing = connection.close();
    await clock.advance(2_000);
    expect(socket.clientClose).toEqual({ code: 1000, reason: "client closing" });
    expect(await closing).toEqual({
      provider: "assemblyai",
      model: "universal-streaming-english",
      audioMs: 1_000,
      socketMs: 5_000,
      source: "client",
    });
  });

  it("reports an unexpected close as a fatal connection_lost, then closed", async () => {
    const { connection, socket, events } = await connect();
    socket.close(1006);
    await settle();
    expect(events.map((event) => event.type)).toEqual(["error", "closed"]);
    expect(events[0]).toMatchObject({ code: "connection_lost", fatal: true });
    expect(events[1]).toMatchObject({ expected: false, code: 1006 });
    connection.send(new Int16Array(512)); // dropped quietly
    expect(socket.audio).toHaveLength(0);
  });

  it("resolves close() once, however often it's called", async () => {
    const { connection, socket } = await connect();
    const first = connection.close();
    const second = connection.close();
    expect(first).toBe(second);
    socket.close(1000);
    await first;
    expect(
      (socket.json as unknown[]).filter((m) => (m as { type: string }).type === "Terminate"),
    ).toHaveLength(1);
  });
});

// Type-level check: the adapter's connection satisfies the spec's SttConnection interface.
export type _Check = SttConnection;
