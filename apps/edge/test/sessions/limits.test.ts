// Limits and close codes (spec WP6 step 6): messages a second, turns per window, capture time.
import { SESSION_CLOSE_CODES, uuidv7 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { FLUSH_TIMING, SESSION_LIMITS } from "../../src/session/limits";
import {
  canaryKey,
  meta,
  open,
  setMeta,
  startMessage,
  turnEndMessage,
  usageMessage,
  utteranceMessage,
  utteranceOf,
} from "./helpers";

describe("the targets", () => {
  it("are the spec's", () => {
    expect(SESSION_LIMITS).toMatchObject({
      messagesPerSecond: 20,
      turnsPerWindow: 30,
      turnWindowMs: 10 * 60_000,
      captureMs: 30 * 60_000,
    });
    expect(FLUSH_TIMING).toMatchObject({
      maxPendingEvents: 20,
      maxPendingMs: 30_000,
      resendAfterEndMs: [3_600_000, 21_600_000],
      cleanupAfterConfirmMs: 86_400_000,
    });
    for (const { code, reason } of Object.values(SESSION_CLOSE_CODES)) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4099);
      expect(new TextEncoder().encode(reason).byteLength).toBeLessThanOrEqual(123);
    }
  });
});

describe("messages a second", () => {
  it("closes the socket at the first message past the rate, and handles nothing after it", async () => {
    const { socket } = await open();
    await socket.request(startMessage());
    const turnId = uuidv7();
    // A burst well past the bucket, ending with a turn_end: it must never run, because some of
    // the utterances before it were over the rate.
    const burst = Array.from({ length: SESSION_LIMITS.messageBurst + 10 }, (_, n) =>
      utteranceMessage(turnId, utteranceOf(`Line ${n}.`)),
    );
    for (const message of burst) socket.send(message);
    socket.send(turnEndMessage(turnId, canaryKey()));

    expect((await socket.closed).code).toBe(SESSION_CLOSE_CODES.rate_limited.code);
    expect(socket.received.some((m) => m.t === "error" && m.code === "rate_limited")).toBe(false);
    // Every stored event reaches the socket, so its events are the log up to the close.
    const events = socket.events();
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    // Only messages inside the burst were stored; the client resends the rest on reconnect.
    const stored = events.filter((event) => event.type === "utterance.final").length;
    expect(stored).toBeGreaterThan(0);
    expect(stored).toBeLessThan(burst.length);
  }, 20_000);
});

describe("turns per window", () => {
  it("refuses the 31st turn in ten minutes with turn_limit, and repeats that answer", async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    const now = Date.now();
    const starts = Array.from({ length: SESSION_LIMITS.turnsPerWindow }, (_, n) => now - n * 1_000);
    await setMeta(stub, { turn_starts: JSON.stringify(starts) });

    const turn = turnEndMessage(uuidv7(), canaryKey());
    socket.send(turn);
    expect(await socket.error(turn.msgId)).toEqual({
      t: "error",
      code: "turn_limit",
      retryable: false,
      msgId: turn.msgId,
    });
    expect(await socket.ack(turn.msgId)).toEqual({ t: "ack", msgId: turn.msgId });
    expect(socket.eventsOf("turn.completed")).toEqual([]);

    // Turns older than the window don't count.
    await setMeta(stub, { turn_starts: JSON.stringify(starts.map((s) => s - 11 * 60_000)) });
    const later = turnEndMessage(uuidv7(), canaryKey());
    expect((await socket.request(later)).seq).toBeDefined();
    expect(JSON.parse((await meta(stub)).turn_starts ?? "[]")).toHaveLength(1);
    socket.close();
  });
});

describe("capture time", () => {
  it("refuses speech 30 minutes after start, but still records usage", async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    await setMeta(stub, { capture_started_ms: Date.now() - SESSION_LIMITS.captureMs - 1 });
    const turnId = uuidv7();
    for (const message of [
      utteranceMessage(turnId, utteranceOf("One more thing.")),
      turnEndMessage(turnId, canaryKey()),
    ]) {
      socket.send(message);
      expect(await socket.error(message.msgId)).toMatchObject({
        code: "duration_limit",
        retryable: false,
      });
    }
    const usage = usageMessage("assemblyai", "universal-streaming-english", 1_000, 1_000);
    expect((await socket.request(usage)).seq).toBe(1);
    socket.close();
  });
});
