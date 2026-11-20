// The flush consumer inside workerd (spec WP7 tests): `queue()`'s acks, retries, and dead
// letters, through createMessageBatch and getQueueResult. Postgres is the in-memory event store,
// which refuses the same batches with the same errors; the Node tests run the real one on PGlite.

import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uuidv7 } from "@earshot/core";
import { UnknownSessionError } from "@earshot/db";
import { defaultProjections, InMemoryEventStore, prepareAppend, replay } from "@earshot/events";
import { describe, expect, it } from "vitest";
import type { FlushStore, SessionRpc } from "../src/flush";
import type { FlushEvent, FlushMessage } from "../src/flush-message";
import { handleFlushQueue } from "../src/queue";

const userId = "user-a";
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function sessionEvents(count: number): FlushEvent[] {
  const ts = "2026-11-19T10:00:00.000Z";
  return Array.from({ length: count }, (_, seq) =>
    seq === 0
      ? {
          id: uuidv7(),
          seq,
          type: "session.started",
          schemaVersion: 1,
          ts,
          payload: { mode: "debrief", engine: "cascaded", providers: {}, startedAt: ts },
        }
      : {
          id: uuidv7(),
          seq,
          type: "usage.recorded",
          schemaVersion: 1,
          ts,
          payload: {
            usageId: uuidv7(),
            kind: "stt",
            provider: "assemblyai",
            model: "universal-streaming-english",
            audioMs: 1_000,
            socketMs: 1_000,
            costUsd: 0.00005,
            priceTable: "2026-11-15",
          },
        },
  );
}

function message(sessionId: string, events: FlushEvent[]): FlushMessage {
  return {
    v: 1,
    sessionId,
    userId,
    workspaceId,
    fromSeq: events[0]?.seq ?? 0,
    toSeq: events.at(-1)?.seq ?? 0,
    events,
  };
}

/**
 * Postgres, faked: the in-memory event store, the sessions that have rows, and replay for the
 * rebuild. Like one transaction, nothing is stored unless the append and the rebuild both pass.
 */
function fakePostgres(sessions: string[]) {
  const store = new InMemoryEventStore();
  const known = new Set(sessions);
  const flushStore: FlushStore = {
    async append(_tenant, sessionId, expectedLastSeq, events) {
      if (!known.has(sessionId)) throw new UnknownSessionError(sessionId);
      const before = await store.read(sessionId);
      const prepared = prepareAppend({
        sessionId,
        expectedLastSeq,
        actualLastSeq: before.length - 1,
        events,
        existingIds: new Set(before.map((event) => event.id)),
      });
      replay([...before, ...prepared], defaultProjections);
      await store.append(sessionId, expectedLastSeq, events);
    },
    async storedIds(_tenant, sessionId, fromSeq) {
      return (await store.read(sessionId, fromSeq)).map((event) => event.id);
    },
  };
  return { store, flushStore };
}

/** A session's Durable Object, faked: its log, and what Postgres confirmed. */
function fakeSessions(logs: Record<string, FlushEvent[]>) {
  const confirmed: Record<string, number> = {};
  const rpc = (sessionId: string): SessionRpc => ({
    async readRange(fromSeq, toSeq) {
      return (logs[sessionId] ?? []).filter((event) => event.seq >= fromSeq && event.seq <= toSeq);
    },
    async confirmFlushed(seq) {
      confirmed[sessionId] = Math.max(confirmed[sessionId] ?? -1, seq);
    },
  });
  return { rpc, confirmed };
}

async function deliver(
  bodies: unknown[],
  setup: { store: FlushStore; session: (sessionId: string) => SessionRpc },
  attempts = 1,
) {
  const deadLetters: unknown[] = [];
  const testEnv = {
    ...env,
    DATABASE_URL: "postgresql://user:pass@db.example/neondb",
    FLUSH_DLQ: {
      send: async (body: unknown) => {
        deadLetters.push(body);
      },
    },
  } as unknown as Env;
  const batch = createMessageBatch(
    "earshot-flush",
    bodies.map((body, index) => ({ id: `m${index}`, timestamp: Date.now(), attempts, body })),
  );
  const ctx = createExecutionContext();
  await handleFlushQueue(batch, testEnv, ctx, {
    store: () => ({ store: setup.store, close: async () => undefined }),
    session: setup.session,
  });
  return { result: await getQueueResult(batch, ctx), deadLetters };
}

describe("queue()", () => {
  it("acks every batch and skips Postgres when DATABASE_URL isn't set", async () => {
    const batch = createMessageBatch("earshot-flush", [
      { id: "m0", timestamp: Date.now(), attempts: 1, body: message(uuidv7(), sessionEvents(1)) },
    ]);
    const ctx = createExecutionContext();
    await handleFlushQueue(batch, env, ctx);
    expect(await getQueueResult(batch, ctx)).toMatchObject({ ackAll: true, retryMessages: [] });
  });

  it("hands the store development's signer in development, and none without a usable key elsewhere", async () => {
    const signers: unknown[] = [];
    const run = async (overrides: Record<string, unknown>) => {
      const batch = createMessageBatch("earshot-flush", []);
      const ctx = createExecutionContext();
      const testEnv = {
        ...env,
        DATABASE_URL: "postgresql://user:pass@db.example/neondb",
        ...overrides,
      } as unknown as Env;
      await handleFlushQueue(batch, testEnv, ctx, {
        store: (_url, signer) => {
          signers.push(signer);
          return { store: fakePostgres([]).flushStore, close: async () => undefined };
        },
        session: fakeSessions({}).rpc,
      });
      await getQueueResult(batch, ctx);
    };
    await run({ DEPLOY_ENV: "development" });
    await run({ DEPLOY_ENV: "production", EARSHOT_AUDIT_SIGNING_KEY: undefined });
    await run({ DEPLOY_ENV: "production", EARSHOT_AUDIT_SIGNING_KEY: "{not a key" });
    expect(signers[0]).toMatchObject({ kid: "audit-development", development: true });
    expect(signers.slice(1)).toEqual([null, null]);
  });

  it("acks each message it applied, and confirms the range to the session", async () => {
    const sid = uuidv7();
    const events = sessionEvents(5);
    const pg = fakePostgres([sid]);
    const sessions = fakeSessions({ [sid]: events });
    const { result } = await deliver(
      [message(sid, events.slice(0, 3)), message(sid, events.slice(3))],
      { store: pg.flushStore, session: sessions.rpc },
    );
    expect(result.explicitAcks.sort()).toEqual(["m0", "m1"]);
    expect(result.retryMessages).toEqual([]);
    expect((await pg.store.read(sid)).map((event) => event.id)).toEqual(events.map((e) => e.id));
    expect(sessions.confirmed[sid]).toBe(4);
  });

  it("acks a duplicate delivery, and a delivery whose first ack was lost", async () => {
    const sid = uuidv7();
    const events = sessionEvents(3);
    const pg = fakePostgres([sid]);
    const sessions = fakeSessions({ [sid]: events });
    await pg.store.append(sid, -1, events); // an earlier delivery committed
    const { result } = await deliver([message(sid, events), message(sid, events)], {
      store: pg.flushStore,
      session: sessions.rpc,
    });
    expect(result.explicitAcks.sort()).toEqual(["m0", "m1"]);
    expect(await pg.store.read(sid)).toHaveLength(3);
    expect(sessions.confirmed[sid]).toBe(2);
  });

  it("repairs a gap from the session's Durable Object", async () => {
    const sid = uuidv7();
    const events = sessionEvents(6);
    const pg = fakePostgres([sid]);
    const sessions = fakeSessions({ [sid]: events });
    const { result } = await deliver([message(sid, events.slice(4))], {
      store: pg.flushStore,
      session: sessions.rpc,
    });
    expect(result.explicitAcks).toEqual(["m0"]);
    expect((await pg.store.read(sid)).map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("retries a second writer's conflict and an unknown session", async () => {
    const conflicted = uuidv7();
    const unknown = uuidv7();
    const pg = fakePostgres([conflicted]);
    await pg.store.append(conflicted, -1, sessionEvents(2)); // different ids at seqs 0 and 1
    const sessions = fakeSessions({});
    const { result } = await deliver(
      [message(conflicted, sessionEvents(2)), message(unknown, sessionEvents(1))],
      { store: pg.flushStore, session: sessions.rpc },
      3,
    );
    expect(result.explicitAcks).toEqual([]);
    // (The test runtime doesn't record delaySeconds; flush.test.ts in Node checks the delays.)
    expect(result.retryMessages.map((retry) => retry.msgId).sort()).toEqual(["m0", "m1"]);
    expect(sessions.confirmed).toEqual({});
  });

  it("dead-letters a batch Postgres refuses, and a malformed message, without retrying", async () => {
    const sid = uuidv7();
    const pg = fakePostgres([sid]);
    const sessions = fakeSessions({});
    const twoStarts = sessionEvents(1).concat({
      ...(sessionEvents(1)[0] as FlushEvent),
      id: uuidv7(),
      seq: 1,
    });
    const malformed = { v: 1, sessionId: sid };
    const { result, deadLetters } = await deliver([message(sid, twoStarts), malformed], {
      store: pg.flushStore,
      session: sessions.rpc,
    });
    expect(result.explicitAcks.sort()).toEqual(["m0", "m1"]);
    expect(result.retryMessages).toEqual([]);
    expect(deadLetters).toHaveLength(2);
    expect(await pg.store.read(sid)).toEqual([]);
  });
});
