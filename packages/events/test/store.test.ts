import { describe, expect, it } from "vitest";
import {
  ConcurrencyError,
  EventValidationError,
  InMemoryEventStore,
  NO_EVENTS,
  StreamError,
  UnknownEventError,
} from "../src";
import { draft, SESSION_ID, started, utterance, utteranceV1, uuid } from "./helpers";

/** A store holding `session.started` and one utterance, so its log ends at seq 1. */
async function storeWithTwoEvents() {
  const store = new InMemoryEventStore();
  await store.append(SESSION_ID, NO_EVENTS, [draft(1, started()), draft(2, utterance(1))]);
  return store;
}

const seqs = (events: readonly { seq: number }[]) => events.map((event) => event.seq);

describe("append and read", () => {
  it("numbers events 0, 1, 2, … across appends and fills in the session", async () => {
    const store = new InMemoryEventStore();
    expect(seqs(await store.append(SESSION_ID, NO_EVENTS, [draft(1, started())]))).toEqual([0]);
    const next = await store.append(SESSION_ID, 0, [
      draft(2, utterance(1)),
      draft(3, utterance(2)),
    ]);
    expect(seqs(next)).toEqual([1, 2]);
    const log = await store.read(SESSION_ID);
    expect(seqs(log)).toEqual([0, 1, 2]);
    expect(log.every((event) => event.sessionId === SESSION_ID)).toBe(true);
    expect(log.map((event) => event.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
  });

  it("reads from a given seq", async () => {
    const store = await storeWithTwoEvents();
    expect(seqs(await store.read(SESSION_ID, 1))).toEqual([1]);
    expect(await store.read(SESSION_ID, 2)).toEqual([]);
  });

  it("reads an unknown session as empty", async () => {
    expect(await new InMemoryEventStore().read(uuid(9))).toEqual([]);
  });

  it("keeps sessions apart", async () => {
    const store = await storeWithTwoEvents();
    const other = uuid(0xb0b);
    await store.append(other, NO_EVENTS, [draft(10, started())]);
    expect(seqs(await store.read(other))).toEqual([0]);
    expect(seqs(await store.read(SESSION_ID))).toEqual([0, 1]);
  });

  it("stores old schema versions as written; upcasting happens on read", async () => {
    const store = new InMemoryEventStore();
    await store.append(SESSION_ID, NO_EVENTS, [draft(1, started()), draft(2, utteranceV1(1))]);
    const [, stored] = await store.read(SESSION_ID);
    expect(stored?.schemaVersion).toBe(1);
    expect(stored?.payload).not.toHaveProperty("witness");
  });

  it("keeps the log immutable", async () => {
    const store = new InMemoryEventStore();
    const body = started();
    await store.append(SESSION_ID, NO_EVENTS, [draft(1, body)]);
    body.payload.mode = "conversation";
    const [event] = await store.read(SESSION_ID);
    expect(event?.payload.mode).toBe("debrief");
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event?.payload.providers)).toBe(true);
  });
});

describe("optimistic concurrency", () => {
  it("rejects a stale expectedLastSeq and writes nothing", async () => {
    const store = await storeWithTwoEvents();
    const append = store.append(SESSION_ID, 0, [draft(3, utterance(2))]);
    await expect(append).rejects.toBeInstanceOf(ConcurrencyError);
    await expect(append).rejects.toMatchObject({
      sessionId: SESSION_ID,
      expectedLastSeq: 0,
      actualLastSeq: 1,
      reason: "stale",
    });
    expect(seqs(await store.read(SESSION_ID))).toEqual([0, 1]);
  });

  it("rejects a new-session append once the session has events", async () => {
    const store = await storeWithTwoEvents();
    await expect(store.append(SESSION_ID, NO_EVENTS, [draft(3, started())])).rejects.toMatchObject({
      reason: "stale",
      actualLastSeq: 1,
    });
  });

  it("rejects an expectedLastSeq past the end of the log, which would leave a gap", async () => {
    const store = await storeWithTwoEvents();
    await expect(store.append(SESSION_ID, 4, [draft(3, utterance(2))])).rejects.toMatchObject({
      name: "ConcurrencyError",
      expectedLastSeq: 4,
      actualLastSeq: 1,
      reason: "gap",
    });
    await expect(
      new InMemoryEventStore().append(SESSION_ID, 0, [draft(1, started())]),
    ).rejects.toMatchObject({
      reason: "gap",
      actualLastSeq: NO_EVENTS,
      message: expect.stringContaining("but the session has no events (gap)"),
    });
  });

  it("rejects pre-numbered events that skip a seq, and writes none of the batch", async () => {
    const store = await storeWithTwoEvents();
    const batch = [
      { ...draft(3, utterance(2)), seq: 2 },
      { ...draft(4, utterance(3)), seq: 4 },
    ];
    await expect(store.append(SESSION_ID, 1, batch)).rejects.toMatchObject({
      name: "ConcurrencyError",
      reason: "gap",
      message: expect.stringContaining("numbered 4, but the next seq is 3"),
    });
    expect(seqs(await store.read(SESSION_ID))).toEqual([0, 1]);
  });

  it("rejects pre-numbered events that overlap the log", async () => {
    const store = await storeWithTwoEvents();
    const batch = [{ ...draft(3, utterance(2)), seq: 1 }];
    await expect(store.append(SESSION_ID, 1, batch)).rejects.toMatchObject({ reason: "stale" });
  });

  it("accepts pre-numbered events that continue the log", async () => {
    const store = await storeWithTwoEvents();
    const batch = [
      { ...draft(3, utterance(2)), seq: 2 },
      { ...draft(4, utterance(3)), seq: 3 },
    ];
    expect(seqs(await store.append(SESSION_ID, 1, batch))).toEqual([2, 3]);
  });

  it("lets exactly one of two concurrent appends win", async () => {
    const store = await storeWithTwoEvents();
    const results = await Promise.allSettled([
      store.append(SESSION_ID, 1, [draft(3, utterance(2))]),
      store.append(SESSION_ID, 1, [draft(4, utterance(3))]),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: expect.any(ConcurrencyError) });
    expect(seqs(await store.read(SESSION_ID))).toEqual([0, 1, 2]);
  });
});

describe("validation", () => {
  it("validates every event and writes nothing if one is invalid", async () => {
    const store = await storeWithTwoEvents();
    const bad = utterance(3);
    bad.payload.confidence = 1.5;
    await expect(
      store.append(SESSION_ID, 1, [draft(3, utterance(2)), draft(4, bad)]),
    ).rejects.toThrow(/utterance.final v2 at seq 3: invalid payload: confidence/);
    expect(seqs(await store.read(SESSION_ID))).toEqual([0, 1]);
  });

  it("rejects event types the registry doesn't know", async () => {
    const unknown = { type: "followup.asked", schemaVersion: 1, payload: { question: "When?" } };
    await expect(
      new InMemoryEventStore().append(SESSION_ID, NO_EVENTS, [draft(1, unknown)]),
    ).rejects.toBeInstanceOf(UnknownEventError);
  });

  it("rejects a session id that isn't a UUID", async () => {
    const append = new InMemoryEventStore().append("acme-debrief", NO_EVENTS, [
      draft(1, started()),
    ]);
    await expect(append).rejects.toBeInstanceOf(EventValidationError);
    await expect(append).rejects.toThrow(
      /^event 0 of the batch: invalid event envelope: sessionId/,
    );
  });

  it("rejects an event id that's already in the session", async () => {
    const store = await storeWithTwoEvents();
    await expect(store.append(SESSION_ID, 1, [draft(2, utterance(2))])).rejects.toBeInstanceOf(
      StreamError,
    );
  });

  it("rejects malformed seq arguments", async () => {
    const store = new InMemoryEventStore();
    await expect(store.append(SESSION_ID, -2, [])).rejects.toBeInstanceOf(RangeError);
    await expect(store.append(SESSION_ID, 0.5, [])).rejects.toBeInstanceOf(RangeError);
    await expect(store.read(SESSION_ID, -1)).rejects.toBeInstanceOf(RangeError);
  });
});
