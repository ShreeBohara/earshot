import { UtteranceFinalV2 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import type { SttConnection, SttEvent } from "../src/stt/adapter";
import {
  createFakeSttAdapter,
  FAKE_STT_MARKER,
  type FakeSttOptions,
  fakeCredential,
  spreadWords,
} from "../src/testing/fake-stt";
import { counterIds } from "./support/ids";
import { ManualClock } from "./support/manual-clock";

const SCRIPT: FakeSttOptions["script"] = {
  turns: [
    { text: "Acme renewed for two years", startMs: 1_000, endMs: 2_600 },
    { text: "Send the proposal Friday", startMs: 5_000, endMs: 6_400 },
  ],
};

const ms = (n: number) => new Int16Array(n * 16);

// Turn 0's words, spread by character count over its 1,600 ms (script time 1,000–2,600): Acme
// 1,000–1,237, renewed 1,296–1,711, for 1,770–1,948, two 2,007–2,185, years 2,244–2,541.

async function open(options: Partial<FakeSttOptions> = {}, baseOffsetMs = 0) {
  const adapter = createFakeSttAdapter({ script: SCRIPT, createId: counterIds(), ...options });
  const connection = await adapter.connect({
    credential: fakeCredential(),
    keyterms: ["Acme"],
    baseOffsetMs,
  });
  const events: SttEvent[] = [];
  connection.on((event) => events.push(event));
  return { adapter, connection, events };
}

/** Feeds `total` ms in 64 ms messages. */
function feed(connection: SttConnection, total: number) {
  for (let sent = 0; sent < total; sent += 64) connection.send(ms(Math.min(64, total - sent)));
}

const texts = (events: SttEvent[]) =>
  events.flatMap((event) => (event.type === "final" ? [event.utterance.text] : []));

describe("spreadWords", () => {
  it("spreads a turn over its words by character count", () => {
    const words = spreadWords("a bbb", 0, 600);
    expect(words.map((word) => word.w)).toEqual(["a", "bbb"]);
    // Shares of (1+1)/6 and (3+1)/6 of 600 ms; each word's own part leaves its gap after it.
    expect(words.map((word) => [word.startMs, word.endMs])).toEqual([
      [0, 100],
      [200, 500],
    ]);
  });
});

describe("push-to-talk timeline (presses)", () => {
  it("emits partials as words are heard, and the turn's final at once on finalize()", async () => {
    const { connection, events } = await open();
    // A press covering turn 0: its stretch starts at the press, so script 1,000 ms is stream 0.
    feed(connection, 1_000);
    const partials = events.filter((event) => event.type === "partial");
    expect(partials.map((event) => event.type === "partial" && event.text)).toEqual([
      "Acme",
      "Acme renewed",
      "Acme renewed for",
    ]);
    feed(connection, 800); // past the turn's end: every word heard
    connection.finalize();
    expect(events.at(-2)).toMatchObject({ type: "final" });
    expect(events.at(-1)).toEqual({ type: "end_of_turn" });
    const final = events.at(-2);
    if (final?.type !== "final") throw new Error("expected a final");
    expect(UtteranceFinalV2.parse(final.utterance)).toEqual(final.utterance);
    expect(final.utterance).toMatchObject({
      text: "Acme renewed for two years",
      startMs: 0,
      witness: "biased",
    });
  });

  it("lines each press up with the next turn", async () => {
    const { connection, events } = await open();
    feed(connection, 1_800);
    connection.finalize();
    feed(connection, 1_600);
    connection.finalize();
    expect(texts(events)).toEqual(["Acme renewed for two years", "Send the proposal Friday"]);
    const second = events.filter((event) => event.type === "final")[1];
    // The second press began where the first stretch ended, at 1,800 ms of stream.
    expect(second?.type === "final" && second.utterance.startMs).toBe(1_800);
  });

  it("finalizes with only the words heard when released early", async () => {
    const { connection, events } = await open();
    feed(connection, 750); // "renewed" ends at 711 ms of stream; "for" starts at 770
    connection.finalize();
    expect(texts(events)).toEqual(["Acme renewed"]);
  });

  it("ends a turn by itself after the endpointing silence, then lets finalize() close the press", async () => {
    const { connection, events } = await open({ endpointingMs: 500 });
    feed(connection, 2_200); // the turn ends at 1,600 ms of stream; +500 ms of silence
    expect(events.slice(-2).map((event) => event.type)).toEqual(["final", "end_of_turn"]);
    connection.finalize();
    expect(events.at(-1)).toEqual({ type: "end_of_turn" });
    expect(texts(events)).toHaveLength(1);
  });
});

describe("hands-free timeline (absolute)", () => {
  it("treats script times as session audio and ends each turn after its endpointing delay", async () => {
    const { connection, events } = await open({ timeline: "absolute", endpointingMs: 700 });
    feed(connection, 3_200); // the turn ends at 2,600 ms; 700 ms of silence hasn't passed yet
    expect(texts(events)).toEqual([]);
    feed(connection, 200);
    expect(texts(events)).toEqual(["Acme renewed for two years"]);
    feed(connection, 4_000);
    expect(texts(events)).toEqual(["Acme renewed for two years", "Send the proposal Friday"]);
    const first = events.find((event) => event.type === "final");
    expect(first?.type === "final" && first.utterance.words?.[0]?.startMs).toBe(1_000);
  });
});

describe("faults", () => {
  it("drops the socket at a set audio time, losing the rest of that message", async () => {
    const { adapter, connection, events } = await open({ faults: { dropAtMs: [1_200] } });
    feed(connection, 1_280);
    expect(events.slice(-2).map((event) => event.type)).toEqual(["error", "closed"]);
    expect(events.at(-1)).toMatchObject({ expected: false, code: 1006 });
    expect(adapter.stats()).toMatchObject({ drops: 1, samplesReceived: 1_200 * 16 });
    connection.send(ms(64));
    expect(adapter.stats().samplesReceived).toBe(1_200 * 16);
  });

  it("hears replayed audio on a new socket, so no words are lost", async () => {
    const adapter = createFakeSttAdapter({
      script: SCRIPT,
      createId: counterIds(),
      faults: { dropAtMs: [600] },
    });
    const first = await adapter.connect({
      credential: fakeCredential(),
      keyterms: [],
      baseOffsetMs: 0,
    });
    feed(first, 1_800); // drops at 600 ms
    const second = await adapter.connect({
      credential: fakeCredential(),
      keyterms: [],
      baseOffsetMs: 0,
    });
    const events: SttEvent[] = [];
    second.on((event) => events.push(event));
    feed(second, 1_800); // the engine replays from the last final (none yet): from 0
    second.finalize();
    expect(texts(events)).toEqual(["Acme renewed for two years"]);
    expect(adapter.stats().baseOffsetsMs).toEqual([0, 0]);
  });

  it("misses the words under audio that was never replayed", async () => {
    const adapter = createFakeSttAdapter({
      script: SCRIPT,
      createId: counterIds(),
      faults: { dropAtMs: [300] },
    });
    const first = await adapter.connect({
      credential: fakeCredential(),
      keyterms: [],
      baseOffsetMs: 0,
    });
    feed(first, 384); // "Acme" (0–237 ms of stream) arrives before the drop at 300
    const second = await adapter.connect({
      credential: fakeCredential(),
      keyterms: [],
      baseOffsetMs: 900,
    });
    const events: SttEvent[] = [];
    second.on((event) => events.push(event));
    feed(second, 900); // a reconnect that skipped 300–900 ms: "renewed" and "for" are lost
    second.finalize();
    expect(texts(events)).toEqual(["Acme two years"]);
  });

  it("holds finals back by finalDelayMs", async () => {
    const clock = new ManualClock();
    const { connection, events } = await open({ clock, faults: { finalDelayMs: 300 } });
    feed(connection, 1_800);
    connection.finalize();
    expect(texts(events)).toEqual([]);
    await clock.advance(300);
    expect(texts(events)).toEqual(["Acme renewed for two years"]);
    expect(events.at(-1)).toEqual({ type: "end_of_turn" });
  });

  it("refuses the first connects, then accepts", async () => {
    const adapter = createFakeSttAdapter({
      script: SCRIPT,
      faults: { refuseConnects: { count: 2, code: "rate_limited" } },
    });
    const attempt = () =>
      adapter.connect({ credential: fakeCredential(), keyterms: [], baseOffsetMs: 0 });
    await expect(attempt()).rejects.toMatchObject({ code: "rate_limited", retryable: true });
    await expect(attempt()).rejects.toThrow(FAKE_STT_MARKER);
    await expect(attempt()).resolves.toBeDefined();
    expect(adapter.stats()).toMatchObject({ refusedConnects: 2, connects: 1 });
  });

  it("raises scripted errors, and can refuse keyterm updates", async () => {
    const { connection, events } = await open({
      faults: { errorsAtMs: [{ atMs: 100, code: "provider_error" }], rejectKeyterms: true },
    });
    feed(connection, 128);
    expect(events).toContainEqual({
      type: "error",
      code: "provider_error",
      message: `${FAKE_STT_MARKER}: scripted error`,
      fatal: false,
    });
    await expect(connection.updateKeyterms(["Globex"])).rejects.toMatchObject({
      code: "keyterms_rejected",
    });
  });
});

describe("determinism and stats", () => {
  it("gives the same events for the same audio and calls (with a fixed clock and ids)", async () => {
    const run = async () => {
      const { connection, events } = await open({ timeline: "presses", clock: new ManualClock() });
      feed(connection, 1_800);
      connection.finalize();
      feed(connection, 1_600);
      connection.finalize();
      await connection.close();
      return JSON.stringify(events);
    };
    expect(await run()).toBe(await run());
  });

  it("counts what it received: connects, PCM bytes, finalizes, keepalives, and keyterms", async () => {
    const { adapter, connection } = await open();
    feed(connection, 640);
    connection.keepAlive();
    connection.finalize();
    await connection.updateKeyterms(["Globex", " "]);
    expect(adapter.stats()).toMatchObject({
      connects: 1,
      samplesReceived: 10_240,
      bytesReceived: 20_480,
      finalizes: 1,
      keepAlives: 1,
      connectKeyterms: [["Acme"]],
      keytermUpdates: [["Globex"]],
    });
  });

  it("reports its usage as the free `fake` model on close", async () => {
    const clock = new ManualClock();
    const { connection, events } = await open({ clock });
    feed(connection, 1_000);
    await clock.advance(2_500);
    const usage = await connection.close();
    expect(usage).toEqual({
      provider: "fake",
      model: "fake",
      audioMs: 1_000,
      socketMs: 2_500,
      source: "client",
    });
    expect(events.at(-1)).toEqual({ type: "closed", code: 1000, expected: true, usage });
  });
});
