// Test support for EventStore implementations: event builders, the demo session file, and the
// contract every store shares with InMemoryEventStore. It imports Vitest and node:fs, so only
// tests should import it, as `@earshot/events/testing`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConcurrencyError, EventValidationError, StreamError, UnknownEventError } from "./errors";
import { fromJsonl, toJsonl } from "./jsonl";
import { type EventDraft, type EventStore, NO_EVENTS } from "./store";

/** The type, version, and payload of an event, before it gets an id, seq, and timestamp. */
export type EventBody = { type: string; schemaVersion: number; payload: Record<string, unknown> };

/** Reads a file from this package's `fixtures/`, such as `demo-session.jsonl`. */
export function readFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

/** A valid UUIDv7-shaped id from a small number. */
export function uuid(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

export const SESSION_ID = uuid(0xa11ce);
export const OTHER_SESSION_ID = uuid(0xb0b);

/** One second per event, from 2026-11-10T19:15:00Z. */
export function tsFor(seq: number): string {
  return new Date(Date.UTC(2026, 10, 10, 19, 15, seq)).toISOString();
}

/** A draft for `append`, with id `uuid(n)`. */
export function draft(n: number, body: EventBody): EventDraft {
  return { id: uuid(n), ts: tsFor(n), ...body };
}

export function started(payload: Record<string, unknown> = {}): EventBody {
  return {
    type: "session.started",
    schemaVersion: 1,
    payload: {
      mode: "debrief",
      engine: "cascaded",
      providers: { speechToText: { provider: "deepgram", model: "nova-3" } },
      startedAt: "2026-11-10T19:15:00.000Z",
      ...payload,
    },
  };
}

export function utterance(n: number, text = `Utterance ${n}.`, witness = "biased"): EventBody {
  return {
    type: "utterance.final",
    schemaVersion: 2,
    payload: {
      utteranceId: uuid(2000 + n),
      text,
      confidence: 0.9,
      startMs: n * 1000,
      endMs: n * 1000 + 800,
      witness,
    },
  };
}

export function utteranceV1(n: number, text = `Utterance ${n}.`): EventBody {
  const { witness: _, ...payload } = utterance(n, text).payload;
  return { type: "utterance.final", schemaVersion: 1, payload };
}

export function proposal(n: number, type = "task", value: unknown = "Send the deck"): EventBody {
  return {
    type: "proposal.created",
    schemaVersion: 1,
    payload: {
      proposalId: uuid(3000 + n),
      type,
      targetEntityId: null,
      fields: {
        title: {
          value,
          evidence: {
            utteranceId: uuid(2001),
            span: [0, 4],
            audioMs: [1000, 1400],
            confidence: 0.9,
          },
        },
      },
      riskFlags: [],
    },
  };
}

export function review(
  n: number,
  decision: string,
  extra: Record<string, unknown> = {},
): EventBody {
  return {
    type: "proposal.reviewed",
    schemaVersion: 1,
    payload: { proposalId: uuid(3000 + n), decision, reviewerMs: 1500, ...extra },
  };
}

export function ended(payload: Record<string, unknown> = {}): EventBody {
  return {
    type: "session.ended",
    schemaVersion: 1,
    payload: { endedAt: "2026-11-10T19:15:40.000Z", costUsd: 0.004, ...payload },
  };
}

/** `demo-session.jsonl`: the 40-second debrief behind the replay gate and the replay demo. */
export const demoSessionJsonl: string = readFixture("demo-session.jsonl");

/** The session id every line of `demo-session.jsonl` carries. */
export const demoSessionId: string = (() => {
  const [first] = fromJsonl(demoSessionJsonl);
  if (!first) throw new Error("demo-session.jsonl has no events");
  return first.sessionId;
})();

/**
 * Every session the contract appends to. A store that needs a session to exist before it takes
 * events, as the Postgres store does, creates these in its factory.
 */
export const contractSessionIds: readonly string[] = [SESSION_ID, OTHER_SESSION_ID, demoSessionId];

/** Builds a fresh, empty store for one test. */
export type EventStoreFactory = () => EventStore | Promise<EventStore>;

const seqs = (events: readonly { seq: number }[]) => events.map((event) => event.seq);

/**
 * Registers the tests every `EventStore` must pass, so that each one behaves like
 * `InMemoryEventStore`, the reference: numbering and reads, an immutable log that keeps exactly
 * what was written, optimistic concurrency, validation, and a byte-for-byte round trip of
 * `demo-session.jsonl`. Call it at the top level of a test file. `factory` runs once per test,
 * and only appends to `contractSessionIds` follow.
 */
export function describeEventStoreContract(name: string, factory: EventStoreFactory): void {
  /** A store holding `session.started` and one utterance, so its log ends at seq 1. */
  async function storeWithTwoEvents(): Promise<EventStore> {
    const store = await factory();
    await store.append(SESSION_ID, NO_EVENTS, [draft(1, started()), draft(2, utterance(1))]);
    return store;
  }

  describe(`${name} (EventStore contract)`, () => {
    describe("append and read", () => {
      it("numbers events 0, 1, 2, … across appends and fills in the session", async () => {
        const store = await factory();
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

      it("returns from append the events that read returns", async () => {
        const store = await factory();
        const first = await store.append(SESSION_ID, NO_EVENTS, [
          draft(1, started()),
          draft(2, utterance(1)),
        ]);
        const second = await store.append(SESSION_ID, 1, [draft(3, proposal(1))]);
        expect(await store.read(SESSION_ID)).toEqual([...first, ...second]);
      });

      it("reads from a given seq", async () => {
        const store = await storeWithTwoEvents();
        expect(seqs(await store.read(SESSION_ID, 1))).toEqual([1]);
        expect(await store.read(SESSION_ID, 2)).toEqual([]);
      });

      it("reads an unknown session as empty", async () => {
        const store = await factory();
        expect(await store.read(uuid(9))).toEqual([]);
        expect(await store.read("not-a-uuid")).toEqual([]);
      });

      it("keeps sessions apart", async () => {
        const store = await storeWithTwoEvents();
        await store.append(OTHER_SESSION_ID, NO_EVENTS, [draft(10, started())]);
        expect(seqs(await store.read(OTHER_SESSION_ID))).toEqual([0]);
        expect(seqs(await store.read(SESSION_ID))).toEqual([0, 1]);
      });

      it("stores old schema versions as written; upcasting happens on read", async () => {
        const store = await factory();
        await store.append(SESSION_ID, NO_EVENTS, [draft(1, started()), draft(2, utteranceV1(1))]);
        const [, stored] = await store.read(SESSION_ID);
        expect(stored?.schemaVersion).toBe(1);
        expect(stored?.payload).not.toHaveProperty("witness");
      });

      it("keeps the log immutable", async () => {
        const store = await factory();
        const body = started();
        await store.append(SESSION_ID, NO_EVENTS, [draft(1, body)]);
        body.payload.mode = "conversation";
        const [event] = await store.read(SESSION_ID);
        expect(event?.payload.mode).toBe("debrief");
        expect(Object.isFrozen(event)).toBe(true);
        expect(Object.isFrozen(event?.payload.providers)).toBe(true);
      });

      it("keeps ts exactly as written, offset and precision included", async () => {
        const store = await factory();
        const stamps = [
          "2026-11-10T14:15:00.5-05:00",
          "2026-11-10T19:15:01Z",
          "2026-11-10T19:15:02.123456789Z",
          "2026-11-10T19:15:03.000+00:00",
          "2026-11-10T19:15:04.100Z",
        ];
        const bodies = [started(), utterance(1), utterance(2), utterance(3), utterance(4)];
        await store.append(
          SESSION_ID,
          NO_EVENTS,
          bodies.map((body, i) => ({ ...draft(i + 1, body), ts: stamps[i] ?? "" })),
        );
        expect((await store.read(SESSION_ID)).map((event) => event.ts)).toEqual(stamps);
      });

      it("keeps payload strings and numbers exactly", async () => {
        const store = await factory();
        const body = utterance(1, 'Dana said "ship it" — 今日は 😀\\ok\n\ttabbed');
        Object.assign(body.payload, {
          confidence: 0.1 + 0.2,
          startMs: Number.MAX_SAFE_INTEGER - 1,
          endMs: Number.MAX_SAFE_INTEGER,
          words: [{ w: "Dana", startMs: 0, endMs: 1, confidence: 1e-7 }],
        });
        const appended = await store.append(SESSION_ID, NO_EVENTS, [
          draft(1, started()),
          draft(2, body),
        ]);
        const log = await store.read(SESSION_ID);
        expect(log).toEqual(appended);
        expect(log[1]?.payload).toEqual(body.payload);
      });

      it("round-trips demo-session.jsonl byte for byte", async () => {
        const store = await factory();
        const events = fromJsonl(demoSessionJsonl);
        // Pre-numbered drafts, as SessionDO will flush them: the store checks every seq.
        await store.append(
          demoSessionId,
          NO_EVENTS,
          events.map(({ sessionId: _, ...rest }) => rest),
        );
        expect(toJsonl(await store.read(demoSessionId))).toBe(demoSessionJsonl);
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
        await expect(
          store.append(SESSION_ID, NO_EVENTS, [draft(3, started())]),
        ).rejects.toMatchObject({ reason: "stale", actualLastSeq: 1 });
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
          (await factory()).append(SESSION_ID, 0, [draft(1, started())]),
        ).rejects.toMatchObject({
          reason: "gap",
          actualLastSeq: NO_EVENTS,
          message: expect.stringContaining("but the session has no events (gap)"),
        });
      });

      it("checks expectedLastSeq for an empty batch too, and writes nothing", async () => {
        const store = await storeWithTwoEvents();
        expect(await store.append(SESSION_ID, 1, [])).toEqual([]);
        await expect(store.append(SESSION_ID, 0, [])).rejects.toMatchObject({ reason: "stale" });
        await expect(store.append(SESSION_ID, 2, [])).rejects.toMatchObject({ reason: "gap" });
        expect(seqs(await store.read(SESSION_ID))).toEqual([0, 1]);
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
        const batches = [[draft(3, utterance(2))], [draft(4, utterance(3))]];
        const results = await Promise.allSettled(
          batches.map((batch) => store.append(SESSION_ID, 1, batch)),
        );
        const winner = results.findIndex((result) => result.status === "fulfilled");
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results[1 - winner]).toMatchObject({
          status: "rejected",
          reason: expect.objectContaining({
            name: "ConcurrencyError",
            reason: "stale",
            actualLastSeq: 2,
          }),
        });
        const log = await store.read(SESSION_ID);
        expect(seqs(log)).toEqual([0, 1, 2]);
        expect(log[2]?.id).toBe(batches[winner]?.[0]?.id);
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
        const unknown = {
          type: "followup.asked",
          schemaVersion: 1,
          payload: { question: "When?" },
        };
        await expect(
          (await factory()).append(SESSION_ID, NO_EVENTS, [draft(1, unknown)]),
        ).rejects.toBeInstanceOf(UnknownEventError);
      });

      it("rejects a session id that isn't a UUID", async () => {
        const append = (await factory()).append("acme-debrief", NO_EVENTS, [draft(1, started())]);
        await expect(append).rejects.toBeInstanceOf(EventValidationError);
        await expect(append).rejects.toThrow(
          /^event 0 of the batch: invalid event envelope: sessionId/,
        );
      });

      it("rejects an event id that's already in the session", async () => {
        const store = await storeWithTwoEvents();
        const append = store.append(SESSION_ID, 1, [draft(2, utterance(2))]);
        await expect(append).rejects.toBeInstanceOf(StreamError);
        await expect(append).rejects.toThrow(`event id ${uuid(2)} is already in session`);
        expect(seqs(await store.read(SESSION_ID))).toEqual([0, 1]);
      });

      it("rejects an id repeated within one batch", async () => {
        const store = await factory();
        const append = store.append(SESSION_ID, NO_EVENTS, [
          draft(1, started()),
          { ...draft(2, utterance(1)), id: uuid(1) },
        ]);
        await expect(append).rejects.toBeInstanceOf(StreamError);
        expect(await store.read(SESSION_ID)).toEqual([]);
      });

      it("rejects malformed seq arguments", async () => {
        const store = await factory();
        await expect(store.append(SESSION_ID, -2, [])).rejects.toBeInstanceOf(RangeError);
        await expect(store.append(SESSION_ID, 0.5, [])).rejects.toBeInstanceOf(RangeError);
        await expect(store.read(SESSION_ID, -1)).rejects.toBeInstanceOf(RangeError);
        await expect(store.read(SESSION_ID, 1.5)).rejects.toBeInstanceOf(RangeError);
      });
    });
  });
}
