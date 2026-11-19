import { UtteranceFinalV2 } from "@earshot/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { SttEvent } from "../src/stt/adapter";
import { createDeepgramNova3Adapter } from "../src/stt/deepgram-nova3";
import { FakeSocketServer, settle } from "../src/testing/fake-socket";
import { nova3 } from "./fixtures/providers";
import { counterIds } from "./support/ids";
import { ManualClock } from "./support/manual-clock";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXRlc3Q";
const credential = {
  provider: "deepgram",
  credential: JWT,
  expiresAt: "2026-11-15T12:00:30.000Z",
  url: "wss://api.deepgram.com",
} as const;

let server: FakeSocketServer;
let clock: ManualClock;

beforeEach(() => {
  server = new FakeSocketServer();
  server.onConnection = (socket) => socket.accept("bearer");
  clock = new ManualClock();
});

async function connect(
  options: Parameters<typeof createDeepgramNova3Adapter>[0] = {},
  connectOptions: { keyterms?: string[]; baseOffsetMs?: number } = {},
) {
  const adapter = createDeepgramNova3Adapter({
    socket: server.factory,
    clock,
    createId: counterIds(),
    ...options,
  });
  const connection = await adapter.connect({
    credential,
    keyterms: connectOptions.keyterms ?? ["Acme Corp", "Initech"],
    baseOffsetMs: connectOptions.baseOffsetMs ?? 0,
  });
  const events: SttEvent[] = [];
  connection.on((event) => events.push(event));
  return { adapter, connection, events, socket: server.last };
}

const finals = (events: SttEvent[]) =>
  events.flatMap((event) => (event.type === "final" ? [event.utterance] : []));

describe("connecting", () => {
  it("presents the JWT as the subprotocol pair [bearer, jwt], never in the URL", async () => {
    const { socket } = await connect();
    expect(socket.protocols).toEqual(["bearer", JWT]);
    expect(socket.url.toString()).not.toContain(JWT);
  });

  it("asks /v1/listen for nova-3, 16 kHz linear16, interim results, and one keyterm per term", async () => {
    const { socket } = await connect();
    expect(`${socket.url.origin}${socket.url.pathname}`).toBe("wss://api.deepgram.com/v1/listen");
    const params = socket.url.searchParams;
    expect(params.get("model")).toBe("nova-3");
    expect(params.get("encoding")).toBe("linear16");
    expect(params.get("sample_rate")).toBe("16000");
    expect(params.get("channels")).toBe("1");
    expect(params.get("interim_results")).toBe("true");
    expect(params.get("smart_format")).toBe("true");
    expect(params.get("endpointing")).toBe("500");
    expect(params.get("utterance_end_ms")).toBe("1300");
    expect(params.getAll("keyterm")).toEqual(["Acme Corp", "Initech"]);
    expect(params.has("redact_usage")).toBe(false);
  });

  it("cuts keyterms to 50, and sets redact_usage only when asked", async () => {
    const terms = Array.from({ length: 70 }, (_, i) => `Co ${i}`);
    const { socket } = await connect({ redactUsage: true }, { keyterms: terms });
    expect(socket.url.searchParams.getAll("keyterm")).toHaveLength(50);
    expect(socket.url.searchParams.get("redact_usage")).toBe("true");
  });

  it("treats a failed handshake (a refused JWT looks the same) as connection_failed", async () => {
    server.onConnection = (socket) => socket.refuse(1006);
    await expect(
      createDeepgramNova3Adapter({ socket: server.factory, clock }).connect({
        credential,
        keyterms: [],
        baseOffsetMs: 0,
      }),
    ).rejects.toMatchObject({ code: "connection_failed", retryable: true });
  });
});

describe("control messages", () => {
  it("sends Finalize, KeepAlive, and CloseStream", async () => {
    const { connection, socket } = await connect();
    connection.finalize();
    connection.keepAlive();
    const closing = connection.close();
    expect(socket.json).toEqual([
      { type: "Finalize" },
      { type: "KeepAlive" },
      { type: "CloseStream" },
    ]);
    socket.close(1000);
    await closing;
  });

  it("updates keyterms with Configure and resolves on ConfigureSuccess", async () => {
    const { connection, socket } = await connect();
    const update = connection.updateKeyterms(["Globex", "Hooli"]);
    expect(socket.json.at(-1)).toEqual({ type: "Configure", keyterms: ["Globex", "Hooli"] });
    socket.sendJson(nova3.configureSuccess);
    await expect(update).resolves.toBeUndefined();
  });

  it("rejects an update the server refuses, and reports it without dropping the socket", async () => {
    const { connection, socket, events } = await connect();
    const update = connection.updateKeyterms(Array.from({ length: 50 }, (_, i) => `Term ${i}`));
    socket.sendJson(nova3.configureFailure);
    await expect(update).rejects.toMatchObject({ code: "keyterms_rejected" });
    expect(events).toContainEqual({
      type: "error",
      code: "keyterms_rejected",
      message: "CONFIGURE_KEYTERM_LIMIT_EXCEEDED",
      fatal: false,
    });
    expect(socket.isOpen).toBe(true);
  });

  it("counts an unanswered update as applied after a grace period, pairing later replies in order", async () => {
    const { connection, socket, events } = await connect();
    const first = connection.updateKeyterms(["A1"]);
    await clock.advance(3_000);
    await expect(first).resolves.toBeUndefined();
    const second = connection.updateKeyterms(["B2"]);
    socket.sendJson(nova3.configureFailure); // the late answer to the first
    socket.sendJson(nova3.configureSuccess); // the answer to the second
    await expect(second).resolves.toBeUndefined();
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  });
});

describe("results", () => {
  it("shows interim results, then committed segments plus the interim one, as partials", async () => {
    const { socket, events } = await connect({}, { baseOffsetMs: 5_000 });
    socket.sendJson(nova3.interim);
    socket.sendJson(nova3.segment1);
    socket.sendJson(nova3.interim2);
    await settle();
    expect(events).toEqual([
      { type: "partial", text: "Acme", startMs: 5_080, endMs: 5_480 },
      { type: "partial", text: "Acme renewed", startMs: 5_080, endMs: 5_960 },
      { type: "partial", text: "Acme renewed for", startMs: 5_080, endMs: 6_200 },
    ]);
  });

  it("joins is_final segments into one utterance at speech_final", async () => {
    const { socket, events } = await connect({}, { baseOffsetMs: 5_000 });
    socket.sendJson(nova3.segment1);
    socket.sendJson(nova3.segment2Endpoint);
    await settle();
    const [utterance, ...rest] = finals(events);
    expect(rest).toEqual([]);
    expect(UtteranceFinalV2.parse(utterance)).toEqual(utterance);
    expect(utterance).toMatchObject({
      text: "Acme renewed for two years.",
      startMs: 5_080,
      endMs: 6_920,
    });
    expect(utterance?.words?.map((word) => word.w)).toEqual([
      "Acme",
      "renewed",
      "for",
      "two",
      "years.",
    ]);
    expect(utterance?.words?.[4]).toEqual({
      w: "years.",
      startMs: 6_520,
      endMs: 6_920,
      confidence: 0.94,
    });
    // speech_final is an endpoint, not the end of a turn.
    expect(events.some((event) => event.type === "end_of_turn")).toBe(false);
  });

  it("ends the turn on a Finalize answer, emitting whatever was pending first", async () => {
    const { socket, events } = await connect();
    socket.sendJson(nova3.segment1);
    socket.sendJson(nova3.finalizeAnswer);
    await settle();
    expect(events.slice(-2).map((event) => event.type)).toEqual(["final", "end_of_turn"]);
    expect(finals(events)[0]?.text).toBe("Acme renewed Thanks.");
  });

  it("ends the turn on an empty Finalize answer, with no final", async () => {
    const { socket, events } = await connect();
    socket.sendJson(nova3.emptyFinalizeAnswer);
    await settle();
    expect(events).toEqual([{ type: "end_of_turn" }]);
  });

  it("ends the turn on UtteranceEnd, the hands-free end of turn", async () => {
    const { socket, events } = await connect();
    socket.sendJson(nova3.segment1);
    socket.sendJson(nova3.speechStarted);
    socket.sendJson(nova3.utteranceEnd);
    await settle();
    expect(events.map((event) => event.type)).toEqual(["partial", "final", "end_of_turn"]);
  });
});

describe("usage", () => {
  it("takes the audio duration from Metadata, and the socket time from the client", async () => {
    const { connection, socket } = await connect();
    await clock.advance(11_000);
    const closing = connection.close();
    socket.sendJson(nova3.metadata);
    socket.close(1000);
    expect(await closing).toEqual({
      provider: "deepgram",
      model: "nova-3",
      audioMs: 9_650,
      socketMs: 11_000,
      source: "provider",
    });
  });
});
