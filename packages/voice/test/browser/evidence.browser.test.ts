// Evidence clips in Chromium (Phase 5 spec §4.7, WP9): the store on the browser's own IndexedDB and
// WebCrypto, and the player through a real AudioContext, which plays the span and reports it ended.
// The unit tests (test/clip-*.test.ts) hold the arithmetic and the store's rules; this shows the
// browser runs them. Each test uses a database of its own and deletes it after.
import { afterEach, describe, expect, it } from "vitest";
import {
  ClipPlayer,
  type ClipRecord,
  ClipStore,
  clipId,
  indexedDbClipBackend,
} from "../../src/evidence";

const SESSION = "0000000a-0000-7000-8000-0000000e1001";
const TURN = "0000000b-0000-7000-8000-0000000f0001";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freshBackend() {
  const name = `earshot-evidence-test-${crypto.randomUUID()}`;
  const backend = await indexedDbClipBackend(indexedDB, name);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        const deleting = indexedDB.deleteDatabase(name);
        deleting.onsuccess = () => resolve();
        deleting.onerror = () => resolve();
        deleting.onblocked = () => resolve();
      }),
  );
  return backend;
}

/** A 440 Hz tone, PCM16 at 16 kHz. */
function tone(ms: number): Int16Array {
  const pcm = new Int16Array(ms * 16);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.round(8_000 * Math.sin((2 * Math.PI * 440 * i) / 16_000));
  }
  return pcm;
}

describe("evidence clips in Chromium", () => {
  it("round-trips a turn through IndexedDB and WebCrypto, and refuses it moved", async () => {
    const backend = await freshBackend();
    const store = await ClipStore.open({ backend });
    const pcm = tone(1_500);
    await store.put({
      sessionId: SESSION,
      turnId: TURN,
      audio: { startMs: 4_000, durationMs: 1_500, pcm },
    });
    expect((await store.find(SESSION, 4_700))?.pcm).toEqual(pcm);
    expect((await backend.getDeviceKey())?.extractable).toBe(false);

    const record = (await backend.get(clipId(SESSION, TURN))) as ClipRecord;
    const moved = `${SESSION.slice(0, -1)}2`;
    await backend.put({ ...record, id: clipId(moved, TURN), sessionId: moved });
    expect(await store.find(moved, 4_700)).toBeNull();
    await store.clear();
    expect(await store.list(SESSION)).toEqual([]);
  });

  it("purges by the expiresAt index on the browser's own IndexedDB, deleting only what expired", async () => {
    let now = Date.parse("2026-11-20T15:00:00.000Z");
    const backend = await freshBackend();
    const store = await ClipStore.open({ backend, now: () => now });
    const audio = (startMs: number) => ({ startMs, durationMs: 100, pcm: tone(100) });
    await store.put({ sessionId: SESSION, turnId: TURN, audio: audio(0) });
    now += 12 * 60 * 60 * 1000;
    await store.put({ sessionId: SESSION, turnId: `${TURN.slice(0, -1)}2`, audio: audio(1_000) });
    now += 12 * 60 * 60 * 1000;
    expect(await store.find(SESSION, 50)).toBeNull();
    expect(await store.purge()).toBe(1);
    expect((await store.list(SESSION)).map((clip) => clip.startMs)).toEqual([1_000]);
    expect(await store.find(SESSION, 1_050)).not.toBeNull();
  });

  it("plays a padded span through a real AudioContext, and reports when it ends", async () => {
    const contexts: AudioContext[] = [];
    const player = new ClipPlayer({
      createContext: () => {
        const context = new AudioContext();
        contexts.push(context);
        return context;
      },
    });
    cleanups.push(async () => {
      player.stop();
      for (const context of contexts) await context.close();
    });
    player.unlock();
    // Words 200 to 400 ms into a 1 s clip: 0 to 650 ms plays, the padding clamped at the start.
    const ended = new Promise<void>((resolve) => {
      const stop = player.subscribe(() => {
        if (player.playing === null) {
          stop();
          resolve();
        }
      });
    });
    const span = player.play("p:field", { startMs: 0, pcm: tone(1_000) }, [200, 400]);
    expect(span).toMatchObject({ start: 0, end: 650 * 16 });
    expect(player.playing).toBe("p:field");
    expect(contexts[0]?.state).not.toBe("closed");
    await ended;
    expect(player.playing).toBeNull();
  });
});
