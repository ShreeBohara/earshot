// The message flow (spec §4.2, WP6 step 4): every message's events and answer, resends, and
// refusals.
import { DEMO_UTTERANCES, demoTurnId } from "@earshot/agent/testing";
import { SESSION_CLOSE_CODES, uuidv7 } from "@earshot/core";
import { defaultProjections, replay } from "@earshot/events";
import { describe, expect, it } from "vitest";
import {
  canaryKey,
  endMessage,
  metricMessage,
  open,
  startMessage,
  turnEndMessage,
  usageMessage,
  utteranceMessage,
  utteranceOf,
} from "./helpers";

const firstUtterance = DEMO_UTTERANCES[0];
if (!firstUtterance) throw new Error("no demo utterance");

describe("a session from start to end", () => {
  it("appends one event per message, contiguous from 0, and acks each with its seq", async () => {
    const { socket, ids } = await open();
    const turnId = demoTurnId(1);
    const start = startMessage();
    expect(await socket.request(start)).toEqual({ t: "ack", msgId: start.msgId, seq: 0 });

    const utterance = utteranceMessage(turnId, firstUtterance);
    expect((await socket.request(utterance)).seq).toBe(1);

    const turnEnd = turnEndMessage(turnId, canaryKey());
    const turnAck = await socket.request(turnEnd);
    const usage = usageMessage("assemblyai", "universal-streaming-english", 9_000, 12_000);
    const usageAck = await socket.request(usage);
    const metric = metricMessage(turnId);
    const metricAck = await socket.request(metric);
    const end = endMessage();
    const endAck = await socket.request(end);

    const events = socket.events();
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect(events.every((event) => event.sessionId === ids.sid)).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "utterance.final",
      // Demo turn 1 drafts one contact: Dana Lee.
      "proposal.created",
      "usage.recorded",
      "turn.completed",
      "usage.recorded",
      "turn.measured",
      "session.ended",
    ]);
    expect(turnAck.seq).toBe(4);
    expect(usageAck.seq).toBe(5);
    expect(metricAck.seq).toBe(6);
    expect(endAck.seq).toBe(7);

    // Envelope ids are UUIDv7s minted by the DO, and ts is the DO's clock, not the client's.
    for (const event of events) {
      expect(event.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(Math.abs(Date.parse(event.ts) - Date.now())).toBeLessThan(60_000);
    }
    // Written as `session.started` v2 (Phase 6 WP1): the rep's time zone, as `start` sent it.
    expect(events[0]).toMatchObject({ type: "session.started", schemaVersion: 2 });
    expect(events[0]?.payload).toEqual({
      mode: "debrief",
      engine: "cascaded",
      providers: start.providers,
      startedAt: start.startedAt,
      timeZone: start.timeZone,
    });
    // Written as `utterance.final` v3 (Phase 5 WP13): the client's words, said into the microphone.
    expect(events[1]).toMatchObject({ type: "utterance.final", schemaVersion: 3 });
    expect(events[1]?.payload).toEqual({ ...firstUtterance, input: "speech" });
    expect(events.at(-2)?.payload).toEqual({
      turnId,
      mode: "push_to_talk",
      speechEndToFinalMs: 620,
      finalToProposalMs: 1_280,
      proposalToPaintMs: 110,
      totalMs: 2_010,
    });
    // The log replays with the same projections Postgres builds.
    const projections = replay(events, defaultProjections);
    expect(projections.session).toMatchObject({ status: "ended" });
    expect(projections.utterances).toHaveLength(1);
    expect(projections.proposals).toHaveLength(1);
    expect(socket.invalid).toEqual([]);
    socket.close();
  });

  it("answers a resend with the same ack and appends nothing", async () => {
    const { socket } = await open();
    const start = startMessage();
    const utterance = utteranceMessage(uuidv7(), utteranceOf("We talked pricing."));
    const usage = usageMessage("deepgram", "nova-3", 1_000, 2_000);
    const first = [
      await socket.request(start),
      await socket.request(utterance),
      await socket.request(usage),
    ];
    const eventsBefore = socket.events().length;
    for (const [index, message] of [start, utterance, usage].entries()) {
      const before = socket.received.length;
      socket.send(message);
      await socket.waitFor((_m) => socket.received.length > before);
      const again = socket.received.at(-1);
      expect(again).toEqual(first[index]);
    }
    expect(socket.events()).toHaveLength(eventsBefore);
    socket.close();
  });

  it("records the time zone start sent in session.started v2, and null when it sent none", async () => {
    const sent = await open();
    await sent.socket.request(startMessage({ timeZone: "Asia/Kolkata" }));
    const [withZone] = sent.socket.eventsOf("session.started");
    expect(withZone).toMatchObject({ schemaVersion: 2, payload: { timeZone: "Asia/Kolkata" } });
    expect(replay(sent.socket.events(), defaultProjections).session?.timeZone).toBe("Asia/Kolkata");
    sent.socket.close();

    const { timeZone: _, ...withoutZone } = startMessage();
    const none = await open();
    await none.socket.request(withoutZone);
    const [noZone] = none.socket.eventsOf("session.started");
    expect(noZone).toMatchObject({ schemaVersion: 2, payload: { timeZone: null } });
    expect(replay(none.socket.events(), defaultProjections).session?.timeZone).toBeNull();
    none.socket.close();
  });

  it("gives a second start, or the same utterance under a new msgId, the first one's seq", async () => {
    const { socket } = await open();
    await socket.request(startMessage());
    const restart = startMessage();
    expect(await socket.request(restart)).toEqual({ t: "ack", msgId: restart.msgId, seq: 0 });
    const utterance = utteranceOf("Same words, sent twice.");
    const turnId = uuidv7();
    expect((await socket.request(utteranceMessage(turnId, utterance))).seq).toBe(1);
    expect((await socket.request(utteranceMessage(turnId, utterance))).seq).toBe(1);
    expect(socket.events()).toHaveLength(2);
    socket.close();
  });
});

describe("refusals", () => {
  it("refuses speech, usage, metrics, and end before start, with not_started (retryable)", async () => {
    const { socket } = await open();
    const turnId = uuidv7();
    for (const message of [
      utteranceMessage(turnId, utteranceOf("Too early.")),
      turnEndMessage(turnId, canaryKey()),
      usageMessage("assemblyai", "universal-streaming-english", 1, 1),
      metricMessage(turnId),
      endMessage(),
    ]) {
      socket.send(message);
      expect(await socket.error(message.msgId)).toEqual({
        t: "error",
        code: "not_started",
        retryable: true,
        msgId: message.msgId,
      });
    }
    expect(socket.events()).toEqual([]);
    socket.close();
  });

  it("refuses speech and a new start after end, with already_ended", async () => {
    const { socket } = await open();
    await socket.request(startMessage());
    await socket.request(endMessage());
    for (const message of [
      utteranceMessage(uuidv7(), utteranceOf("Too late.")),
      turnEndMessage(uuidv7(), canaryKey()),
      startMessage(),
    ]) {
      socket.send(message);
      expect(await socket.error(message.msgId)).toMatchObject({
        code: "already_ended",
        retryable: false,
      });
    }
    // A late usage record is still taken: it's what the session cost. It follows the end's
    // recap (Phase 5 WP10), skipped here, with no key.
    const usage = usageMessage("assemblyai", "universal-streaming-english", 500, 900);
    expect((await socket.request(usage)).seq).toBe(3);
    socket.close();
  });

  it("refuses frames that aren't valid messages", async () => {
    const { socket } = await open();
    const cases: [string | ArrayBuffer, string][] = [
      ["not json", "bad_message"],
      [JSON.stringify({ t: "launch" }), "bad_message"],
      [new TextEncoder().encode("{}").buffer as ArrayBuffer, "bad_message"],
      [
        JSON.stringify({ t: "hello", protocol: 1, lastSeq: -1, pad: "x".repeat(70_000) }),
        "too_large",
      ],
    ];
    for (const [frame, code] of cases) {
      const before = socket.received.length;
      socket.sendRaw(frame);
      await socket.waitFor(() => socket.received.length > before);
      expect(socket.received.at(-1)).toEqual({ t: "error", code, retryable: false });
    }
    socket.close();
  });

  it("refuses a key-shaped string outside turn_end.key, and text Postgres couldn't store", async () => {
    const { socket } = await open();
    await socket.request(startMessage());
    const strayKey = utteranceMessage(uuidv7(), utteranceOf(`my key is ${canaryKey()}`));
    const before = socket.received.length;
    socket.send(strayKey);
    await socket.waitFor(() => socket.received.length > before);
    // The refusal names the msgId, so the client drops the message instead of resending it.
    expect(socket.received.at(-1)).toEqual({
      t: "error",
      code: "bad_message",
      retryable: false,
      msgId: strayKey.msgId,
    });

    const nul = utteranceMessage(uuidv7(), utteranceOf("a\u0000b"));
    socket.send(nul);
    expect(await socket.error(nul.msgId)).toEqual({
      t: "error",
      code: "bad_message",
      retryable: false,
      msgId: nul.msgId,
    });
    expect(socket.events()).toHaveLength(1);
    socket.close();
  });

  it("closes with unsupported_protocol on a hello for another protocol version", async () => {
    const { socket } = await open();
    socket.send({ t: "hello", protocol: 2, lastSeq: -1 });
    expect((await socket.closed).code).toBe(SESSION_CLOSE_CODES.unsupported_protocol.code);
  });
});
