import { UtteranceFinalV2 } from "@earshot/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { SttEvent } from "../src/stt/adapter";
import { createDeepgramFluxAdapter } from "../src/stt/deepgram-flux";
import { FakeSocketServer, settle } from "../src/testing/fake-socket";
import { flux, fluxTurnInfo } from "./fixtures/providers";
import { counterIds } from "./support/ids";
import { ManualClock } from "./support/manual-clock";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmbHV4In0.c2lnbmF0dXJlLWZsdXg";

let server: FakeSocketServer;
let clock: ManualClock;

beforeEach(() => {
  server = new FakeSocketServer();
  server.onConnection = (socket) => socket.accept("bearer");
  clock = new ManualClock();
});

async function connect(
  options: Parameters<typeof createDeepgramFluxAdapter>[0] = {},
  baseOffsetMs = 0,
) {
  const adapter = createDeepgramFluxAdapter({
    socket: server.factory,
    clock,
    createId: counterIds(),
    ...options,
  });
  const connection = await adapter.connect({
    credential: {
      provider: "deepgram",
      credential: JWT,
      expiresAt: "2026-11-15T12:00:30.000Z",
      url: "wss://api.deepgram.com",
    },
    keyterms: ["Acme"],
    baseOffsetMs,
  });
  const events: SttEvent[] = [];
  connection.on((event) => events.push(event));
  return { connection, events, socket: server.last };
}

describe("connecting", () => {
  it("asks /v2/listen for flux-general-en with [bearer, jwt] and keyterms", async () => {
    const { socket } = await connect({ eotThreshold: 0.8, eotTimeoutMs: 4_000 });
    expect(`${socket.url.origin}${socket.url.pathname}`).toBe("wss://api.deepgram.com/v2/listen");
    expect(socket.protocols).toEqual(["bearer", JWT]);
    const params = socket.url.searchParams;
    expect(params.get("model")).toBe("flux-general-en");
    expect(params.get("encoding")).toBe("linear16");
    expect(params.get("sample_rate")).toBe("16000");
    expect(params.getAll("keyterm")).toEqual(["Acme"]);
    expect(params.get("eot_threshold")).toBe("0.8");
    expect(params.get("eot_timeout_ms")).toBe("4000");
    expect(params.has("eager_eot_threshold")).toBe(false);
  });
});

describe("turns", () => {
  it("shows Update and EagerEndOfTurn as partials", async () => {
    const { socket, events } = await connect({}, 2_000);
    socket.sendJson(flux.connected);
    socket.sendJson(flux.update);
    socket.sendJson(flux.eager);
    await settle();
    expect(events).toEqual([
      { type: "partial", text: "Acme renewed", startMs: 2_120, endMs: 2_960 },
      { type: "partial", text: "Acme renewed", startMs: 2_120, endMs: 2_960 },
    ]);
  });

  it("emits EndOfTurn as a final with numeric confidences, then an end of turn, once", async () => {
    const { socket, events } = await connect({}, 2_000);
    socket.sendJson(flux.endOfTurn);
    socket.sendJson(flux.endOfTurn);
    await settle();
    expect(events.map((event) => event.type)).toEqual(["final", "end_of_turn"]);
    const final = events[0];
    if (final?.type !== "final") throw new Error("expected a final");
    expect(UtteranceFinalV2.parse(final.utterance)).toEqual(final.utterance);
    expect(final.utterance.words?.map((word) => word.confidence)).toEqual([0.97, 0.88, 0.92]);
    expect(final.utterance.confidence).toBeCloseTo((0.97 + 0.88 + 0.92) / 3, 10);
    expect(final.utterance).toMatchObject({
      text: "Acme renewed today.",
      startMs: 2_120,
      endMs: 3_400,
    });
  });

  it("counts an unparseable confidence as 0", async () => {
    const { socket, events } = await connect();
    socket.sendJson(fluxTurnInfo("EndOfTurn", 4, [["um", 0.1, 0.2, "not-a-number"]]));
    await settle();
    const final = events[0];
    expect(final?.type === "final" && final.utterance.words?.[0]?.confidence).toBe(0);
  });

  it("starts a new turn for a new turn_index", async () => {
    const { socket, events } = await connect();
    socket.sendJson(flux.endOfTurn);
    socket.sendJson(fluxTurnInfo("EndOfTurn", 1, [["Next", 2.0, 2.3, "0.9"]]));
    await settle();
    expect(events.filter((event) => event.type === "final")).toHaveLength(2);
  });
});

describe("control messages", () => {
  it("sends ForceEndTurn and Configure, and handles Flux's Configure answers", async () => {
    const { connection, socket, events } = await connect();
    connection.finalize();
    const ok = connection.updateKeyterms(["Globex"]);
    socket.sendJson(flux.configureSuccess);
    await expect(ok).resolves.toBeUndefined();
    const refused = connection.updateKeyterms(["Hooli"]);
    socket.sendJson(flux.configureFailure);
    await expect(refused).rejects.toMatchObject({ code: "keyterms_rejected" });
    expect(socket.json).toEqual([
      { type: "ForceEndTurn" },
      { type: "Configure", keyterms: ["Globex"] },
      { type: "Configure", keyterms: ["Hooli"] },
    ]);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  });

  it("keeps an idle socket alive with 100 ms of silence, and maps times around it", async () => {
    const { connection, socket, events } = await connect({}, 10_000);
    connection.send(new Int16Array(16_000).fill(100)); // 1 s of session audio
    connection.keepAlive(); // 100 ms the session never had
    connection.send(new Int16Array(16_000).fill(100)); // 1 s more
    expect(socket.audioMessages.map((message) => message.length)).toEqual([16_000, 1_600, 16_000]);
    expect(socket.audioMessages[1]?.every((sample) => sample === 0)).toBe(true);
    // A word the provider places at 1.5–1.8 s of its stream is at 1.4–1.7 s of session audio.
    socket.sendJson(fluxTurnInfo("EndOfTurn", 0, [["late", 1.5, 1.8, "0.9"]]));
    // One placed inside the silence lands where the silence was.
    socket.sendJson(fluxTurnInfo("EndOfTurn", 1, [["edge", 1.05, 1.08, "0.9"]]));
    await settle();
    const words = events.flatMap((event) =>
      event.type === "final" ? (event.utterance.words ?? []) : [],
    );
    expect(words.map((word) => [word.startMs, word.endMs])).toEqual([
      [11_400, 11_700],
      [11_000, 11_000],
    ]);
  });

  it("raises an Error message as a non-fatal provider error", async () => {
    const { socket, events } = await connect();
    socket.sendJson(flux.error);
    await settle();
    expect(events).toEqual([
      { type: "error", code: "provider_error", message: "Unknown message type.", fatal: false },
    ]);
  });

  it("counts the keepalive silence as audio in the client's usage", async () => {
    const { connection, socket } = await connect();
    connection.send(new Int16Array(16_000));
    connection.keepAlive();
    await clock.advance(4_000);
    const closing = connection.close();
    expect(socket.json.at(-1)).toEqual({ type: "CloseStream" });
    socket.close(1000);
    expect(await closing).toEqual({
      provider: "deepgram",
      model: "flux-general-en",
      audioMs: 1_100,
      socketMs: 4_000,
      source: "client",
    });
  });
});
