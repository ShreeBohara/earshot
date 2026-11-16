import {
  ConcurrencyError,
  type EventDraft,
  type EventRegistry,
  EventValidationError,
  fromJsonl,
  InMemoryEventStore,
  NO_EVENTS,
  StreamError,
} from "@earshot/events";
import {
  contractSessionIds,
  demoSessionId,
  demoSessionJsonl,
  describeEventStoreContract,
  draft,
  SESSION_ID,
  started,
  utterance,
  utteranceV1,
  uuid,
} from "@earshot/events/testing";
import type { PGlite } from "@electric-sql/pglite";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { appendEvents, PgEventStore, readEvents, UnknownSessionError } from "../src/event-store";
import { sessionEvents } from "../src/schema";
import { withTenant } from "../src/tenant";
import { A, B, cloneDb, migratedDb } from "./db";
import { createTenant } from "./tenants";

const B_SESSION_ID = uuid(0xbbbb);

let template: PGlite;
const opened: PGlite[] = [];

// A owns every session the contract appends to; B owns one session of its own.
beforeAll(async () => {
  const { client, db } = await migratedDb();
  await createTenant(db, A, contractSessionIds);
  await createTenant(db, B, [B_SESSION_ID]);
  template = client;
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((client) => client.close()));
});

afterAll(async () => {
  await template.close();
});

/** A fresh copy of the template database, closed after the test. */
async function fresh() {
  const copy = await cloneDb(template);
  opened.push(copy.client);
  return copy;
}

const seqs = (events: readonly { seq: number }[]) => events.map((event) => event.seq);

describeEventStoreContract("PgEventStore", async () => new PgEventStore((await fresh()).db, A));

describe("PgEventStore on Postgres", () => {
  it("reads back exactly what InMemoryEventStore returns for the same appends", async () => {
    const pg = new PgEventStore((await fresh()).db, A);
    const memory = new InMemoryEventStore();
    const batches: [string, number, EventDraft[]][] = [
      [
        SESSION_ID,
        NO_EVENTS,
        [draft(1, started()), { ...draft(2, utteranceV1(1)), ts: "2026-11-10T14:15:02.25-05:00" }],
      ],
      [SESSION_ID, 1, [{ ...draft(3, utterance(2, "Café, naïve 😀")), seq: 2 }]],
      [demoSessionId, NO_EVENTS, fromJsonl(demoSessionJsonl).map(({ sessionId: _, ...e }) => e)],
    ];
    for (const [sessionId, expectedLastSeq, events] of batches) {
      const fromMemory = await memory.append(sessionId, expectedLastSeq, events);
      expect(await pg.append(sessionId, expectedLastSeq, events)).toStrictEqual(fromMemory);
    }
    for (const sessionId of [SESSION_ID, demoSessionId]) {
      expect(await pg.read(sessionId)).toStrictEqual(await memory.read(sessionId));
    }
  });

  it("keeps the instant in ts, and the exact string in ts_text only when ts isn't canonical", async () => {
    const { db } = await fresh();
    await new PgEventStore(db, A).append(SESSION_ID, NO_EVENTS, [
      draft(1, started()),
      { ...draft(2, utterance(1)), ts: "2026-11-10T14:15:02.5-05:00" },
    ]);
    const rows = await db
      .select({ seq: sessionEvents.seq, ts: sessionEvents.ts, tsText: sessionEvents.tsText })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, SESSION_ID))
      .orderBy(asc(sessionEvents.seq));
    expect(rows).toEqual([
      { seq: 0, ts: new Date("2026-11-10T19:15:01.000Z"), tsText: null },
      { seq: 1, ts: new Date("2026-11-10T19:15:02.500Z"), tsText: "2026-11-10T14:15:02.5-05:00" },
    ]);
  });

  it("won't store a ts_text that names a different instant from ts", async () => {
    const { db } = await fresh();
    const error = await db
      .insert(sessionEvents)
      .values({
        id: uuid(1),
        workspaceId: A.workspaceId,
        sessionId: SESSION_ID,
        seq: 0,
        type: "session.started",
        schemaVersion: 1,
        payload: started().payload,
        ts: new Date("2026-11-10T19:15:00.000Z"),
        tsText: "2026-11-10T19:15:00.000+01:00",
      })
      .catch((e: unknown) => e);
    expect(String((error as Error).cause)).toMatch(/session_events_ts_text_check/);
  });

  it("refuses ids with uppercase hex, which Postgres would return in lowercase", async () => {
    const store = new PgEventStore((await fresh()).db, A);
    const upperId = { ...draft(1, started()), id: uuid(0xabc).toUpperCase() };
    await expect(store.append(SESSION_ID, NO_EVENTS, [upperId])).rejects.toThrow(
      /^event 0 of the batch: invalid event envelope: id: must be lowercase/,
    );
    const upperSession = SESSION_ID.toUpperCase();
    const append = store.append(upperSession, NO_EVENTS, [draft(1, started())]);
    await expect(append).rejects.toBeInstanceOf(EventValidationError);
    await expect(append).rejects.toThrow(/sessionId: must be lowercase/);

    // Like the in-memory store's map keys, ids match exactly: no case folding.
    await store.append(SESSION_ID, NO_EVENTS, [draft(1, started())]);
    expect(await store.read(upperSession)).toEqual([]);
    expect(await store.append(upperSession, NO_EVENTS, [])).toEqual([]);
  });

  it("refuses payload strings that jsonb can't store", async () => {
    const store = new PgEventStore((await fresh()).db, A);
    await store.append(SESSION_ID, NO_EVENTS, [draft(1, started())]);
    for (const text of ["a NUL \u0000 byte", "half a pair \uD83D here"]) {
      await expect(store.append(SESSION_ID, 0, [draft(2, utterance(1, text))])).rejects.toThrow(
        /^utterance.final v2 at seq 1: invalid payload: text: contains (U\+0000|an unpaired surrogate)/,
      );
    }
    expect(seqs(await store.read(SESSION_ID))).toEqual([0]);

    // Keys too, which only a registry that allows free-form keys lets through.
    const anything: EventRegistry = {
      latestVersion: () => 1,
      payloadSchema: () => undefined,
      validate: (event) => event,
      upcast: (event) => event,
      toLatest: (event) => event,
    };
    const loose = new PgEventStore((await fresh()).db, A, { registry: anything });
    const body = { type: "note.added", schemaVersion: 1, payload: { tags: { "a\u0000b": 1 } } };
    await expect(loose.append(SESSION_ID, NO_EVENTS, [draft(1, body)])).rejects.toThrow(
      "invalid payload: tags.a\u0000b: the key contains U+0000",
    );
  });

  it("refuses a ts in year 0000, which Postgres's calendar doesn't have", async () => {
    const store = new PgEventStore((await fresh()).db, A);
    const append = store.append(SESSION_ID, NO_EVENTS, [
      { ...draft(1, started()), ts: "0000-01-01T00:00:00.000Z" },
    ]);
    await expect(append).rejects.toThrow(/invalid event envelope: ts: year 0000/);
  });

  it("needs the session's row before the session takes events", async () => {
    const store = new PgEventStore((await fresh()).db, A);
    const unknown = uuid(0xdead);
    const append = store.append(unknown, NO_EVENTS, [draft(1, started())]);
    await expect(append).rejects.toBeInstanceOf(UnknownSessionError);
    await expect(append).rejects.toMatchObject({ sessionId: unknown });
    // An empty batch writes nothing, so it needs no row.
    expect(await store.append(unknown, NO_EVENTS, [])).toEqual([]);
  });

  // PGlite has one connection, so two transactions never interleave: concurrent appends queue
  // up, and the second fails the expectedLastSeq check. These triggers stand in for a writer
  // that skips the store's lock and commits between the check and the insert, so that the
  // unique keys fire and the store's mapping of them is what's under test.
  describe("when a writer that skipped the lock gets there first", () => {
    async function withEarlierWriter(values: string) {
      const { client, db } = await fresh();
      const store = new PgEventStore(db, A);
      await store.append(SESSION_ID, NO_EVENTS, [draft(1, started())]);
      await client.exec(`
        create function earlier_writer() returns trigger language plpgsql as $$
        begin
          insert into session_events (id, workspace_id, session_id, seq, type, schema_version, payload, ts)
          values (${values}, 'session.ended', 1, '{"endedAt": "2026-11-10T19:15:59.000Z"}', now());
          return new;
        end $$;
        create trigger earlier_writer before insert on session_events
          for each row when (pg_trigger_depth() = 0) execute function earlier_writer();
      `);
      return { client, store };
    }

    it("reports a clash on (session_id, seq) as a stale ConcurrencyError", async () => {
      const { store } = await withEarlierWriter(
        "gen_random_uuid(), new.workspace_id, new.session_id, new.seq",
      );
      const append = store.append(SESSION_ID, 0, [draft(2, utterance(1))]);
      await expect(append).rejects.toBeInstanceOf(ConcurrencyError);
      await expect(append).rejects.toMatchObject({
        reason: "stale",
        expectedLastSeq: 0,
        actualLastSeq: 1,
        message: `session ${SESSION_ID}: another writer appended seq 1 first (stale)`,
      });
      expect(seqs(await store.read(SESSION_ID))).toEqual([0]);
    });

    it("reports a clash on (session_id, id) as a StreamError", async () => {
      const { client, store } = await withEarlierWriter(
        "new.id, new.workspace_id, new.session_id, new.seq + 1000",
      );
      const append = store.append(SESSION_ID, 0, [draft(2, utterance(1))]);
      await expect(append).rejects.toBeInstanceOf(StreamError);
      await expect(append).rejects.toThrow(`an event id in the batch is already in session`);

      await client.exec("drop trigger earlier_writer on session_events");
      expect(seqs(await store.append(SESSION_ID, 0, [draft(2, utterance(1))]))).toEqual([1]);
    });

    it("reports a session deleted between the check and the insert as UnknownSessionError", async () => {
      const { client, db } = await fresh();
      await client.exec(`
        create function session_deleted() returns trigger language plpgsql as $$
        begin
          delete from sessions where id = new.session_id;
          return new;
        end $$;
        create trigger session_deleted before insert on session_events
          for each row execute function session_deleted();
      `);
      const append = new PgEventStore(db, A).append(SESSION_ID, NO_EVENTS, [draft(1, started())]);
      await expect(append).rejects.toBeInstanceOf(UnknownSessionError);
      await expect(append).rejects.toHaveProperty("cause");
    });
  });

  it("appends and reads inside the caller's transaction, and rolls back with it", async () => {
    const { db } = await fresh();
    const inside = await withTenant(db, A, async (tx) => {
      await appendEvents(tx, SESSION_ID, NO_EVENTS, [draft(1, started())]);
      await appendEvents(tx, SESSION_ID, 0, [draft(2, utterance(1))]);
      return readEvents(tx, SESSION_ID);
    });
    expect(seqs(inside)).toEqual([0, 1]);

    const failing = withTenant(db, A, async (tx) => {
      await appendEvents(tx, SESSION_ID, 1, [draft(3, utterance(2))]);
      throw new Error("the projection failed");
    });
    await expect(failing).rejects.toThrow("the projection failed");
    expect(seqs(await new PgEventStore(db, A).read(SESSION_ID))).toEqual([0, 1]);
  });

  it("holds an advisory lock on the session until the transaction ends", async () => {
    const { db } = await fresh();
    const countLocks = sql`select count(*)::int as n from pg_locks
      where locktype = 'advisory' and pid = pg_backend_pid()`;
    const during = await withTenant(db, A, async (tx) => {
      await appendEvents(tx, SESSION_ID, NO_EVENTS, [draft(1, started())]);
      await appendEvents(tx, SESSION_ID, 0, [draft(2, utterance(1))]);
      return (await tx.execute<{ n: number }>(countLocks)).rows;
    });
    expect(during).toEqual([{ n: 1 }]);
    expect((await db.execute<{ n: number }>(countLocks)).rows).toEqual([{ n: 0 }]);
  });
});

describe("tenant isolation for session events", () => {
  async function aWithEvents() {
    const { db } = await fresh();
    await new PgEventStore(db, A).append(SESSION_ID, NO_EVENTS, [
      draft(1, started()),
      draft(2, utterance(1)),
    ]);
    return db;
  }

  it("shows B nothing of A's session", async () => {
    const db = await aWithEvents();
    expect(await new PgEventStore(db, B).read(SESSION_ID)).toEqual([]);
    expect(await withTenant(db, B, (tx) => readEvents(tx, SESSION_ID, 1))).toEqual([]);
  });

  it("won't let B append to A's session, or learn whether it has events", async () => {
    const db = await aWithEvents();
    const asB = new PgEventStore(db, B);
    // B sees an empty log, so the only expectedLastSeq that passes the check is NO_EVENTS...
    await expect(asB.append(SESSION_ID, 1, [draft(3, utterance(2))])).rejects.toMatchObject({
      name: "ConcurrencyError",
      reason: "gap",
    });
    // ...and that one finds no such session in B's workspace. The store says so before it
    // inserts, so the primary key can't clash with A's seq 0 and tell B that A's events exist.
    await expect(asB.append(SESSION_ID, NO_EVENTS, [draft(3, started())])).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
    expect(seqs(await new PgEventStore(db, A).read(SESSION_ID))).toEqual([0, 1]);
    // B's own session still takes events.
    expect(seqs(await asB.append(B_SESSION_ID, NO_EVENTS, [draft(4, started())]))).toEqual([0]);
  });

  it("won't let B write a row into A's workspace: row-level security refuses it", async () => {
    const db = await aWithEvents();
    const error = await withTenant(db, B, (tx) =>
      tx.insert(sessionEvents).values({
        id: uuid(3),
        workspaceId: A.workspaceId,
        sessionId: SESSION_ID,
        seq: 2,
        type: "session.ended",
        schemaVersion: 1,
        payload: { endedAt: "2026-11-10T19:15:40.000Z" },
        ts: new Date("2026-11-10T19:15:40.000Z"),
      }),
    ).catch((e: unknown) => e);
    expect(String((error as Error).cause)).toMatch(
      /new row violates row-level security policy for table "session_events"/,
    );
    expect(seqs(await new PgEventStore(db, A).read(SESSION_ID))).toEqual([0, 1]);
  });
});
