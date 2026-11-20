// The seal (Phase 5 spec §4.3, WP3): a minute after `end`, or after the last write that followed
// it, capped at 30 minutes, SessionDO appends `session.sealed`, its last event, flushes it at once,
// and refuses every client message after it with `sealed`. Cleanup waits for Postgres to confirm a
// log that ends in the seal. `sealNow()` (the web Worker's repair path) answers live, sealing,
// sealed, or gone. Timing runs on a frozen clock.

import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { type ClientMessage, type ServerMessageOf, uuidv7 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { parseRange } from "../../src/flush-message";
import { FLUSH_TIMING, SEAL_TIMING } from "../../src/session/limits";
import {
  armAlarm,
  canaryKey,
  endMessage,
  flushes,
  freezeClock,
  meta,
  metricMessage,
  newSession,
  open,
  reviewInput,
  reviewMessage,
  sessionStub,
  setMeta,
  snoozeMessage,
  startMessage,
  type TestSocket,
  tableNames,
  turnEndMessage,
  usageMessage,
  utteranceMessage,
  utteranceOf,
  withSql,
} from "./helpers";

const usage = () => usageMessage("assemblyai", "universal-streaming-english", 1_000, 1_000);

/** Runs the object's alarm with its clock at `at`. */
async function alarmAt(stub: Parameters<typeof freezeClock>[0], at: number): Promise<void> {
  await freezeClock(stub, at);
  await armAlarm(stub);
  await runDurableObjectAlarm(stub);
}

/** A session that started and ended with the clock frozen at `t0`: returns `ended_ms`. */
async function endedAt(socket: TestSocket, stub: Parameters<typeof freezeClock>[0], t0: number) {
  await freezeClock(stub, t0);
  await socket.request(startMessage());
  await socket.request(endMessage());
  return Number((await meta(stub)).ended_ms);
}

const types = (socket: TestSocket) => socket.events().map((event) => event.type);

describe("when SessionDO seals", () => {
  it("seals a minute after end, and a write after end restarts the minute", async () => {
    const { socket, stub } = await open();
    const ended = await endedAt(socket, stub, Date.now());
    expect(Number((await meta(stub)).seal_due_ms)).toBe(ended + SEAL_TIMING.graceMs);

    await alarmAt(stub, ended + 59_000);
    expect((await meta(stub)).sealed_seq).toBeUndefined();

    // Usage after the end is taken, and restarts the grace from its own time.
    await socket.request(usage());
    expect(Number((await meta(stub)).seal_due_ms)).toBe(ended + 59_000 + SEAL_TIMING.graceMs);
    await alarmAt(stub, ended + 61_000);
    expect((await meta(stub)).sealed_seq).toBeUndefined();

    await alarmAt(stub, ended + 59_000 + SEAL_TIMING.graceMs);
    await socket.waitFor((m) => m.t === "event" && m.event.type === "session.sealed");
    expect(types(socket)).toEqual([
      "session.started",
      "session.ended",
      "usage.recorded",
      "session.sealed",
    ]);
    const sealed = socket.eventsOf("session.sealed")[0];
    expect(sealed?.payload).toEqual({
      sealedAt: new Date(ended + 59_000 + SEAL_TIMING.graceMs).toISOString(),
      by: "session",
    });
    expect(await meta(stub)).toMatchObject({ sealed_seq: "3" });
    expect((await meta(stub)).seal_due_ms).toBeUndefined();
    socket.close();
  });

  it("never waits more than 30 minutes after end, however late the writes come", async () => {
    const { socket, stub } = await open();
    const ended = await endedAt(socket, stub, Date.now());
    await freezeClock(stub, ended + SEAL_TIMING.maxAfterEndMs - 10_000);
    await socket.request(usage());
    expect(Number((await meta(stub)).seal_due_ms)).toBe(ended + SEAL_TIMING.maxAfterEndMs);
    await alarmAt(stub, ended + SEAL_TIMING.maxAfterEndMs);
    expect((await meta(stub)).sealed_seq).toBe("3");
    socket.close();
  });

  it("seals a session it ended itself after idling, the same way", async () => {
    const { socket, stub } = await open();
    const t0 = Date.now();
    await freezeClock(stub, t0);
    await socket.request(startMessage());
    socket.close();
    const idleEnd = t0 + 30 * 60_000 + FLUSH_TIMING.idleEndMs;
    await alarmAt(stub, idleEnd);
    expect(await meta(stub)).toMatchObject({ ended_seq: "1" });
    expect(Number((await meta(stub)).seal_due_ms)).toBe(idleEnd + SEAL_TIMING.graceMs);
    await alarmAt(stub, idleEnd + SEAL_TIMING.graceMs);
    expect((await meta(stub)).sealed_seq).toBe("2");
    expect(parseRange(await stub.readRange(2, 2))[0]).toMatchObject({ type: "session.sealed" });
  });

  it("seals an object that ended before the seal existed at its next alarm", async () => {
    const { socket, stub } = await open();
    const ended = await endedAt(socket, stub, Date.now());
    // An object from before Phase 5: ended, never given a seal time, Postgres already confirmed.
    await setMeta(stub, { cleanup_due_ms: ended + 1 });
    await freezeClock(stub, ended + 5_000);
    await stub.confirmFlushed(1);
    await withSqlDelete(stub, "seal_due_ms");
    await alarmAt(stub, ended + SEAL_TIMING.graceMs);
    expect(await meta(stub)).toMatchObject({ sealed_seq: "2" });
    // The old cleanup time is dropped until Postgres confirms the seal.
    expect((await meta(stub)).cleanup_due_ms).toBeUndefined();
    expect(await tableNames(stub)).toContain("events");
    socket.close();
  });
});

/** Deletes one `meta` setting behind the object's back, then reloads it. */
async function withSqlDelete(stub: Parameters<typeof freezeClock>[0], key: string) {
  await withSql(stub, (sql) => sql.exec("DELETE FROM meta WHERE k = ?", key));
  await evictDurableObject(stub, { webSockets: "hibernate" });
}

describe("after the seal", () => {
  it("is the last event, flushed at once, and nothing follows it", async () => {
    const { socket, stub } = await open();
    const ended = await endedAt(socket, stub, Date.now());
    await expect.poll(async () => (await flushes(stub)).at(-1)?.toSeq).toBe(1);
    await alarmAt(stub, ended + SEAL_TIMING.graceMs);
    // Flushed straight away, without waiting for the 30 s window.
    await expect.poll(async () => (await flushes(stub)).at(-1)?.toSeq).toBe(2);
    const last = (await flushes(stub)).at(-1);
    expect(last?.events?.map((event) => event.type)).toEqual(["session.sealed"]);

    // A later alarm, the repair path, and new messages add nothing.
    await alarmAt(stub, ended + 10 * 60_000);
    expect(await stub.sealNow()).toBe("sealed");
    socket.send(usage());
    await socket.waitFor((m) => m.t === "error" && m.code === "sealed");
    expect(parseRange(await stub.readRange(0, 99)).map((event) => event.type)).toEqual([
      "session.started",
      "session.ended",
      "session.sealed",
    ]);
    socket.close();
  });

  it("refuses every message type with sealed, not retryable, while hello and ack still work", async () => {
    const { socket, stub, ids } = await open();
    const ended = await endedAt(socket, stub, Date.now());
    const end = socket.received.find(
      (m): m is ServerMessageOf<"ack"> => m.t === "ack" && m.seq === 1,
    );
    await alarmAt(stub, ended + SEAL_TIMING.graceMs);
    await socket.waitFor((m) => m.t === "event" && m.event.type === "session.sealed");

    const turnId = uuidv7();
    const proposalId = uuidv7();
    const messages: ClientMessage[] = [
      startMessage(),
      utteranceMessage(turnId, utteranceOf("After the seal.")),
      turnEndMessage(turnId, canaryKey()),
      usage(),
      {
        t: "witness",
        msgId: uuidv7(),
        turnId,
        provider: "groq",
        model: "whisper-large-v3-turbo",
        outcome: "skipped",
        reason: "off",
      },
      metricMessage(turnId),
      endMessage(),
      reviewMessage(reviewInput(proposalId)),
      snoozeMessage(proposalId),
    ];
    for (const message of messages) {
      socket.send(message);
      const msgId = "msgId" in message ? message.msgId : "";
      expect(await socket.error(msgId), message.t).toMatchObject({
        code: "sealed",
        retryable: false,
      });
    }

    // A resend of a message handled before the seal gets its first answer, not `sealed`.
    expect(end?.msgId).toBeDefined();
    const before = socket.received.length;
    socket.send({ ...endMessage(), msgId: end?.msgId ?? "" });
    await socket.waitFor(
      (m) => socket.received.indexOf(m) >= before && m.t === "ack" && m.msgId === end?.msgId,
    );

    // hello and ack aren't writes: a new socket resumes, and acks, as ever.
    socket.close();
    const again = await open(ids, 0);
    expect(again.welcome.lastSeq).toBe(2);
    again.socket.send({ t: "ack", seq: 2 });
    await again.socket.waitForCount((m) => m.t === "event", 2);
    expect(parseRange(await stub.readRange(0, 99))).toHaveLength(3);
    again.socket.close();
  });
});

describe("cleanup", () => {
  it("waits for Postgres to confirm a log that ends in the seal, then runs a day later", async () => {
    const { socket, stub } = await open();
    const ended = await endedAt(socket, stub, Date.now());
    // Postgres confirms the whole log up to the end: not enough before the seal.
    await stub.confirmFlushed(1);
    expect((await meta(stub)).cleanup_due_ms).toBeUndefined();
    await alarmAt(stub, ended + 5_000);
    expect((await meta(stub)).cleanup_due_ms).toBeUndefined();

    await alarmAt(stub, ended + SEAL_TIMING.graceMs);
    expect((await meta(stub)).sealed_seq).toBe("2");
    expect((await meta(stub)).cleanup_due_ms).toBeUndefined();
    await stub.confirmFlushed(2);
    const due = Number((await meta(stub)).cleanup_due_ms);
    expect(due).toBe(ended + SEAL_TIMING.graceMs + FLUSH_TIMING.cleanupAfterConfirmMs);

    await alarmAt(stub, due - 1);
    expect(await tableNames(stub)).toContain("events");
    await alarmAt(stub, due);
    expect(await tableNames(stub)).toEqual([]);
    expect(await socket.closed).toMatchObject({ code: 4006 });
  });
});

describe("sealNow and sealSessions", () => {
  it("answers gone, live, sealing, then sealed", async () => {
    // An object that was never used holds nothing.
    expect(await sessionStub(newSession().sid).sealNow()).toBe("gone");

    const { socket, stub } = await open();
    expect(await stub.sealNow()).toBe("gone"); // connected, never started: no log
    await socket.request(startMessage());
    expect(await stub.sealNow()).toBe("live");
    expect((await meta(stub)).sealed_seq).toBeUndefined();

    await socket.request(endMessage());
    // Sealed now, without waiting for the grace.
    expect(await stub.sealNow()).toBe("sealing");
    await socket.waitFor((m) => m.t === "event" && m.event.type === "session.sealed");
    expect(types(socket)).toEqual(["session.started", "session.ended", "session.sealed"]);
    await expect.poll(async () => (await flushes(stub)).at(-1)?.toSeq).toBe(2);
    expect(await stub.sealNow()).toBe("sealed");
    socket.close();
  });

  it("fans out through the edge Worker's RPC, at most 500 lowercase session ids a call", async () => {
    const live = await open();
    await live.socket.request(startMessage());
    const ended = await open();
    await ended.socket.request(startMessage());
    await ended.socket.request(endMessage());
    const unused = newSession().sid;

    const result = await exports.default.sealSessions([live.ids.sid, ended.ids.sid, unused]);
    expect(result).toEqual({
      ok: true,
      sessions: { [live.ids.sid]: "live", [ended.ids.sid]: "sealing", [unused]: "gone" },
    });
    expect(await exports.default.sealSessions([ended.ids.sid])).toEqual({
      ok: true,
      sessions: { [ended.ids.sid]: "sealed" },
    });
    const invalid = { ok: false, reason: "invalid_session_id" };
    expect(await exports.default.sealSessions([unused.toUpperCase()])).toEqual(invalid);
    expect(await exports.default.sealSessions(["health"])).toEqual(invalid);
    const many = Array.from({ length: 501 }, () => newSession().sid);
    expect(await exports.default.sealSessions(many)).toEqual({ ok: false, reason: "too_many" });
    live.socket.close();
    ended.socket.close();
  });

  it("leaves a session purged during the grace purged: no seal, and gone", async () => {
    const { socket, stub, ids } = await open();
    const ended = await endedAt(socket, stub, Date.now());
    expect(await exports.default.purgeSessions([ids.sid])).toEqual({ ok: true, purged: 1 });
    await alarmAt(stub, ended + SEAL_TIMING.graceMs);
    expect(Object.keys(await meta(stub))).toEqual(["purged_ms"]);
    expect(await stub.sealNow()).toBe("gone");
    expect(parseRange(await stub.readRange(0, 99))).toEqual([]);
  });
});
