// The flush producer and cleanup (spec WP6 steps 8–9): Queue messages of at most 64 KB, sent at
// 20 events or 30 s, at once on end; the consumer's RPCs; re-sends; and deletion a day after
// Postgres confirms the session.

import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { uuidv7 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  FLUSH_MESSAGE_TARGET_BYTES,
  FlushMessage,
  jsonBytes,
  parseRange,
} from "../../src/flush-message";
import { FLUSH_TIMING, SESSION_LIMITS } from "../../src/session/limits";
import {
  armAlarm,
  endMessage,
  failSink,
  flushes,
  meta,
  open,
  setMeta,
  startMessage,
  tableNames,
  usageMessage,
  utteranceMessage,
  utteranceOf,
  withSql,
} from "./helpers";

const usage = () => usageMessage("assemblyai", "universal-streaming-english", 1_000, 1_000);

describe("sending", () => {
  it("waits for the window's alarm below 20 events, then sends one message for the range", async () => {
    const { socket, stub, ids } = await open();
    await socket.request(startMessage());
    for (let n = 0; n < 4; n++) await socket.request(usage());
    expect(await flushes(stub)).toEqual([]);
    const alarmAt = await withSql(stub, (_sql, state) => state.storage.getAlarm());
    expect(alarmAt).not.toBeNull();
    expect(alarmAt ?? 0).toBeLessThanOrEqual(Date.now() + FLUSH_TIMING.maxPendingMs);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const [message, ...rest] = await flushes(stub);
    expect(rest).toEqual([]);
    expect(FlushMessage.parse(message)).toMatchObject({
      v: 1,
      sessionId: ids.sid,
      userId: ids.uid,
      workspaceId: ids.wid,
      fromSeq: 0,
      toSeq: 4,
    });
    expect(message?.events?.map((event) => event.type)).toEqual([
      "session.started",
      "usage.recorded",
      "usage.recorded",
      "usage.recorded",
      "usage.recorded",
    ]);
    expect((await meta(stub)).enqueued_seq).toBe("4");
    // Running the alarm again sends nothing new: it acts only on what's due.
    await runDurableObjectAlarm(stub);
    expect(await flushes(stub)).toHaveLength(1);
    socket.close();
  });

  it("sends as soon as 20 events wait, without the alarm", async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    // session.started and 19 usage records make 20 events waiting.
    for (let n = 1; n < FLUSH_TIMING.maxPendingEvents; n++) await socket.requestPaced(usage());
    await expect.poll(async () => (await flushes(stub)).length).toBe(1);
    expect((await flushes(stub))[0]).toMatchObject({ fromSeq: 0, toSeq: 19 });
    socket.close();
  });

  it("packs events into messages of at most 64 KB, contiguous and in order", {
    timeout: 15_000,
  }, async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    const turnId = uuidv7();
    const long = "word ".repeat(790); // just under the 4,000-character utterance cap
    for (let n = 0; n < 40; n++) {
      await socket.requestPaced(utteranceMessage(turnId, utteranceOf(`${n} ${long}`, n * 1_000)));
    }
    await socket.request(endMessage());
    await expect.poll(async () => (await flushes(stub)).at(-1)?.toSeq).toBe(41);
    const messages = await flushes(stub);
    expect(messages.length).toBeGreaterThan(2);
    let next = 0;
    for (const message of messages) {
      expect(jsonBytes(message)).toBeLessThanOrEqual(FLUSH_MESSAGE_TARGET_BYTES);
      expect(message.fromSeq).toBe(next);
      next = message.toSeq + 1;
    }
    socket.close();
  });

  it("sends at once on end", async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    await socket.request(endMessage());
    await expect.poll(async () => (await flushes(stub)).length).toBe(1);
    expect((await flushes(stub))[0]).toMatchObject({ fromSeq: 0, toSeq: 1 });
    socket.close();
  });

  it("keeps a range whose send failed, and sends it on the next alarm", async () => {
    const { socket, stub } = await open();
    await failSink(stub, true);
    await socket.request(startMessage());
    await socket.request(endMessage());
    await expect.poll(async () => (await meta(stub)).unflushed_since_ms).toBeDefined();
    expect((await meta(stub)).enqueued_seq).toBeUndefined();
    await failSink(stub, false);
    await runDurableObjectAlarm(stub);
    expect(await flushes(stub)).toMatchObject([{ fromSeq: 0, toSeq: 1 }]);
    expect((await meta(stub)).enqueued_seq).toBe("1");
    socket.close();
  });
});

describe("the consumer's RPCs", () => {
  it("readRange returns stored events; confirmFlushed records Postgres's progress", async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    await socket.request(usage());
    const range = parseRange(await stub.readRange(0, 10));
    expect(range.map((event) => event.seq)).toEqual([0, 1]);
    expect(range[1]).toMatchObject({ type: "usage.recorded", schemaVersion: 1 });
    expect(parseRange(await stub.readRange(5, 4))).toEqual([]);
    await stub.confirmFlushed(1);
    expect((await meta(stub)).flushed_seq).toBe("1");
    await stub.confirmFlushed(0); // older news changes nothing
    expect((await meta(stub)).flushed_seq).toBe("1");
    socket.close();
  });
});

describe("cleanup", () => {
  it("deletes the object's storage a day after Postgres confirms the whole session", async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    await socket.request(endMessage());
    await expect.poll(async () => (await flushes(stub)).length).toBe(1);
    // The whole session ends in its seal (Phase 5): seal it now rather than wait out the grace.
    expect(await stub.sealNow()).toBe("sealing");
    await expect.poll(async () => (await flushes(stub)).at(-1)?.toSeq).toBe(2);
    await stub.confirmFlushed(2);
    const due = Number((await meta(stub)).cleanup_due_ms);
    expect(due - Date.now()).toBeGreaterThan(FLUSH_TIMING.cleanupAfterConfirmMs - 60_000);

    await runDurableObjectAlarm(stub); // early: nothing is due yet
    expect(await tableNames(stub)).toContain("events");
    await setMeta(stub, { cleanup_due_ms: Date.now() - 1 });
    await armAlarm(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await tableNames(stub)).toEqual([]);
    expect(await withSql(stub, (_sql, state) => state.storage.getAlarm())).toBeNull();
    expect(await socket.closed).toMatchObject({ code: 4006 });
  });

  it("re-sends what Postgres hasn't confirmed after the end, at +1 h, +6 h, then daily", async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    await socket.request(usage());
    await socket.request(endMessage());
    await expect.poll(async () => (await flushes(stub)).length).toBe(1);
    await stub.confirmFlushed(0);
    const ended = Number((await meta(stub)).ended_ms);
    expect(Number((await meta(stub)).resend_due_ms)).toBe(ended + 3_600_000);

    await setMeta(stub, { resend_due_ms: Date.now() - 1 });
    await armAlarm(stub);
    await runDurableObjectAlarm(stub);
    const messages = await flushes(stub);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ fromSeq: 1, toSeq: 2 });
    expect(await meta(stub)).toMatchObject({
      resend_count: "1",
      resend_due_ms: String(ended + 6 * 3_600_000),
    });
    socket.close();
  });

  it("ends a session nobody ended once it has been idle past the capture limit", async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    socket.close();
    const longAgo = Date.now() - SESSION_LIMITS.captureMs - FLUSH_TIMING.idleEndMs - 1_000;
    await setMeta(stub, { capture_started_ms: longAgo });
    await withSql(stub, (sql) =>
      sql.exec("UPDATE events SET ts = ?", new Date(longAgo).toISOString()),
    );
    await evictDurableObject(stub);
    await armAlarm(stub);
    await runDurableObjectAlarm(stub);
    const state = await meta(stub);
    expect(state.ended_seq).toBe("1");
    const range = parseRange(await stub.readRange(1, 1));
    expect(range[0]).toMatchObject({ type: "session.ended", payload: { costUsd: 0 } });
    // The window's flush of session.started, then the end's own.
    await expect.poll(async () => (await flushes(stub)).at(-1)?.toSeq).toBe(1);
  });
});
