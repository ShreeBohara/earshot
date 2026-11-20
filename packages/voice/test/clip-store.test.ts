// The evidence clip store (Phase 5 spec §4.7, WP9; ADR-0036), on both backends: AES-GCM round trips
// under a non-extractable key of its own, a record moved to another id doesn't decrypt, records
// expire after 24 hours and are never played after that, purges delete only what expired, and
// sign-out's `clear` leaves nothing, not even the key. The IndexedDB backend runs on
// fake-indexeddb, with the spec's database, stores, and indexes.
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  CLIP_DB_NAME,
  CLIP_DB_VERSION,
  CLIP_TTL_MS,
  type ClipBackend,
  type ClipRecord,
  ClipStore,
  clipAad,
  clipId,
  indexedDbClipBackend,
  memoryClipBackend,
  openClipRecord,
} from "../src/evidence";

const SESSION = "0000000a-0000-7000-8000-0000000c1001";
const OTHER_SESSION = "0000000a-0000-7000-8000-0000000c1002";
const TURN = "0000000b-0000-7000-8000-0000000d0001";
const TURN_2 = "0000000b-0000-7000-8000-0000000d0002";
const T0 = Date.parse("2026-11-20T15:00:00.000Z");
const HOUR = 60 * 60 * 1000;

/** A synthetic turn: a ramp, so every sample differs and a byte out of place shows. */
function ramp(samples: number, from = 0): Int16Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = ((from + i * 37) % 65_536) - 32_768;
  return pcm;
}

function clock(start = T0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function turn(startMs: number, pcm: Int16Array | null, durationMs?: number) {
  return { startMs, durationMs: durationMs ?? Math.round((pcm?.length ?? 0) / 16), pcm };
}

describe.each([
  ["memory", async () => memoryClipBackend()],
  ["IndexedDB", async () => indexedDbClipBackend(new IDBFactory(), CLIP_DB_NAME, IDBKeyRange)],
])("ClipStore on %s", (_name, makeBackend: () => Promise<ClipBackend>) => {
  it("round-trips a turn's audio, stores only ciphertext, and finds it by any ms it covers", async () => {
    const time = clock();
    const backend = await makeBackend();
    const store = await ClipStore.open({ backend, now: time.now });
    const pcm = ramp(32_000); // 2 s
    const meta = await store.put({ sessionId: SESSION, turnId: TURN, audio: turn(5_000, pcm) });
    expect(meta).toEqual({
      id: `${SESSION}:${TURN}`,
      sessionId: SESSION,
      turnId: TURN,
      startMs: 5_000,
      durationMs: 2_000,
      createdAt: T0,
      expiresAt: T0 + CLIP_TTL_MS,
      samples: 32_000,
    });

    for (const ms of [5_000, 6_000, 7_000]) {
      const found = await store.find(SESSION, ms);
      expect(found?.pcm).toEqual(pcm);
      expect(found?.id).toBe(clipId(SESSION, TURN));
    }
    expect(await store.find(SESSION, 4_999)).toBeNull();
    expect(await store.find(SESSION, 7_001)).toBeNull();
    expect(await store.find(OTHER_SESSION, 6_000)).toBeNull();

    // The record is the spec's: PCM16 at 16 kHz, a 12-byte IV, and ciphertext, never the PCM.
    const record = (await backend.get(clipId(SESSION, TURN))) as ClipRecord;
    expect(record).toMatchObject({ sampleRate: 16_000, codec: "pcm16", startMs: 5_000 });
    expect(record.iv.byteLength).toBe(12);
    expect(record.data.byteLength).toBe(pcm.byteLength + 16);
    const stored = new Uint8Array(record.data);
    const plain = new Uint8Array(pcm.buffer);
    expect(stored.slice(0, 64)).not.toEqual(plain.slice(0, 64));
  });

  it("keeps its own key, non-extractable, from the first clip, and binds each record to its id", async () => {
    const backend = await makeBackend();
    const store = await ClipStore.open({ backend });
    expect(await backend.getDeviceKey()).toBeUndefined();
    await store.put({ sessionId: SESSION, turnId: TURN, audio: turn(0, ramp(8_000)) });
    const key = await backend.getDeviceKey();
    expect(key?.extractable).toBe(false);
    expect(key?.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(crypto.subtle.exportKey("raw", key as CryptoKey)).rejects.toThrow();
    expect(new TextDecoder().decode(clipAad(clipId(SESSION, TURN)))).toBe(
      `earshot-clip:v1:${SESSION}:${TURN}`,
    );
    const record = (await backend.get(clipId(SESSION, TURN))) as ClipRecord;
    await expect(openClipRecord(key as CryptoKey, record)).resolves.toEqual(ramp(8_000));
  });

  it("refuses a record moved to another id: it doesn't decrypt there, and is deleted", async () => {
    const backend = await makeBackend();
    const store = await ClipStore.open({ backend });
    const pcm = ramp(16_000);
    await store.put({ sessionId: SESSION, turnId: TURN, audio: turn(0, pcm) });
    const record = (await backend.get(clipId(SESSION, TURN))) as ClipRecord;
    const key = (await backend.getDeviceKey()) as CryptoKey;

    // Moved to another turn of the same session, fields and all.
    const movedTurn: ClipRecord = { ...record, id: clipId(SESSION, TURN_2), turnId: TURN_2 };
    await expect(openClipRecord(key, movedTurn)).rejects.toThrow();
    // Moved to another session.
    const movedSession: ClipRecord = {
      ...record,
      id: clipId(OTHER_SESSION, TURN),
      sessionId: OTHER_SESSION,
    };
    await expect(openClipRecord(key, movedSession)).rejects.toThrow();

    await backend.delete(record.id);
    await backend.put(movedSession);
    expect(await store.find(OTHER_SESSION, 500)).toBeNull();
    expect(await backend.get(movedSession.id)).toBeUndefined();

    // A record whose fields claim a session its id isn't in is ignored, never decrypted.
    await backend.put({ ...record, sessionId: OTHER_SESSION });
    expect(await store.find(OTHER_SESSION, 500)).toBeNull();
    expect(await store.list(OTHER_SESSION)).toEqual([]);
    // Put back where it was written, it plays.
    await backend.put(record);
    expect((await store.find(SESSION, 500))?.pcm).toEqual(pcm);
  });

  it("never plays a clip after 24 hours, even before a purge deletes it", async () => {
    const time = clock();
    const backend = await makeBackend();
    const store = await ClipStore.open({ backend, now: time.now });
    await store.put({ sessionId: SESSION, turnId: TURN, audio: turn(0, ramp(16_000)) });
    time.advance(CLIP_TTL_MS - 1);
    expect(await store.find(SESSION, 500)).not.toBeNull();
    time.advance(1);
    // Expired: still on the device, listed as such, but never played.
    expect(await store.find(SESSION, 500)).toBeNull();
    expect(await store.list(SESSION)).toMatchObject([{ expiresAt: T0 + CLIP_TTL_MS }]);
    expect(await backend.get(clipId(SESSION, TURN))).toBeDefined();
  });

  it("purges only what expired, before each write too", async () => {
    const time = clock();
    const backend = await makeBackend();
    const store = await ClipStore.open({ backend, now: time.now });
    const changes: number[] = [];
    store.subscribe(() => changes.push(time.now()));
    await store.put({ sessionId: SESSION, turnId: TURN, audio: turn(0, ramp(16_000)) });
    time.advance(12 * HOUR);
    await store.put({ sessionId: SESSION, turnId: TURN_2, audio: turn(5_000, ramp(16_000)) });
    time.advance(12 * HOUR);

    // The first turn's 24 hours are up; the second's aren't.
    expect(await store.purge()).toBe(1);
    expect((await store.list(SESSION)).map((clip) => clip.turnId)).toEqual([TURN_2]);
    expect(await store.purge()).toBe(0);

    // A write purges first: the second turn expires, and the new one is kept.
    time.advance(12 * HOUR);
    await store.put({ sessionId: OTHER_SESSION, turnId: TURN, audio: turn(0, ramp(1_600)) });
    expect(await store.list(SESSION)).toEqual([]);
    expect(await store.list(OTHER_SESSION)).toHaveLength(1);
    expect(changes.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps a turn too long to keep as a record with no audio, and nothing for a turn with none", async () => {
    const backend = await makeBackend();
    const store = await ClipStore.open({ backend });
    const tooLong = await store.put({
      sessionId: SESSION,
      turnId: TURN,
      audio: turn(1_000, null, 121_000),
    });
    expect(tooLong).toMatchObject({ startMs: 1_000, durationMs: 121_000, samples: 0 });
    expect(await store.find(SESSION, 60_000)).toBeNull();
    expect(await store.list(SESSION)).toMatchObject([{ turnId: TURN, samples: 0 }]);

    expect(
      await store.put({
        sessionId: SESSION,
        turnId: TURN_2,
        audio: turn(200_000, new Int16Array()),
      }),
    ).toBeNull();
    expect(await store.list(SESSION)).toHaveLength(1);
  });

  it("clears every clip and the key itself, and a write after it keeps under a new key", async () => {
    const backend = await makeBackend();
    const store = await ClipStore.open({ backend });
    await store.put({ sessionId: SESSION, turnId: TURN, audio: turn(0, ramp(1_600)) });
    await store.put({ sessionId: OTHER_SESSION, turnId: TURN, audio: turn(0, ramp(1_600)) });
    const first = await backend.getDeviceKey();

    await store.clear();
    expect(await store.list(SESSION)).toEqual([]);
    expect(await store.list(OTHER_SESSION)).toEqual([]);
    expect(await backend.getDeviceKey()).toBeUndefined();
    expect(await store.find(SESSION, 50)).toBeNull();

    await store.put({ sessionId: SESSION, turnId: TURN_2, audio: turn(0, ramp(1_600)) });
    const second = await backend.getDeviceKey();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect((await store.find(SESSION, 50))?.pcm).toEqual(ramp(1_600));
  });

  it("keeps nothing from a write that began before a clear", async () => {
    const backend = await makeBackend();
    const store = await ClipStore.open({ backend });
    const writing = store.put({ sessionId: SESSION, turnId: TURN, audio: turn(0, ramp(1_600)) });
    await store.clear();
    expect(await writing).toBeNull();
    expect(await store.list(SESSION)).toEqual([]);
    expect(await backend.getDeviceKey()).toBeUndefined();
  });

  it("reopens with the same key, so another page plays what this one kept", async () => {
    const backend = await makeBackend();
    const first = await ClipStore.open({ backend });
    await first.put({ sessionId: SESSION, turnId: TURN, audio: turn(0, ramp(1_600)) });
    const second = await ClipStore.open({ backend });
    expect((await second.find(SESSION, 50))?.pcm).toEqual(ramp(1_600));
  });
});

describe("the IndexedDB backend", () => {
  it("is the spec's: earshot-evidence v1, stores device and clips, indexes on sessionId and expiresAt", async () => {
    const factory = new IDBFactory();
    await ClipStore.open({
      backend: await indexedDbClipBackend(factory, CLIP_DB_NAME, IDBKeyRange),
    });
    expect(CLIP_DB_NAME).toBe("earshot-evidence");
    expect(CLIP_DB_VERSION).toBe(1);
    const opening = factory.open(CLIP_DB_NAME);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames].sort()).toEqual(["clips", "device"]);
    const clips = db.transaction("clips", "readonly").objectStore("clips");
    expect(clips.keyPath).toBe("id");
    expect([...clips.indexNames].sort()).toEqual(["expiresAt", "sessionId"]);
    db.close();
  });

  it("agrees on one key when two pages open it at once", async () => {
    const factory = new IDBFactory();
    const [a, b] = await Promise.all([
      indexedDbClipBackend(factory, CLIP_DB_NAME, IDBKeyRange),
      indexedDbClipBackend(factory, CLIP_DB_NAME, IDBKeyRange),
    ]);
    const [first, second] = await Promise.all([
      ClipStore.open({ backend: a }),
      ClipStore.open({ backend: b }),
    ]);
    // Both keep their first clip at once: each makes a key, and one transaction keeps one.
    await Promise.all([
      first.put({ sessionId: SESSION, turnId: TURN, audio: turn(0, ramp(1_600)) }),
      second.put({ sessionId: SESSION, turnId: TURN_2, audio: turn(1_000, ramp(1_600, 7)) }),
    ]);
    expect((await second.find(SESSION, 50))?.pcm).toEqual(ramp(1_600));
    expect((await first.find(SESSION, 1_050))?.pcm).toEqual(ramp(1_600, 7));
  });

  it("refuses to open without IndexedDB, as in iOS Lockdown Mode", async () => {
    // Node has no IndexedDB of its own, so the defaults find none.
    await expect(indexedDbClipBackend()).rejects.toThrow("IndexedDB isn't available");
    await expect(ClipStore.open()).rejects.toThrow("IndexedDB isn't available");
  });
});
