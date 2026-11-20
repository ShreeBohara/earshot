// Evidence clips on this device (Phase 5 spec §4.7, decision 6, WP9; ADR-0036). Each turn's audio,
// PCM16 at 16 kHz as the engine records it (`TurnAudioRecording`), kept in this browser for 24
// hours so a reviewer can hear the words behind a field. Never uploaded: nothing here touches the
// network, and nothing is logged.
//
// - **Where:** IndexedDB `earshot-evidence`, version 1, with two stores: `device` (the wrapping
//   key) and `clips` (one record per turn, keyed `${sessionId}:${turnId}`, indexed on `sessionId`
//   and `expiresAt`). Its own database and its own key, apart from the device keys' (ADR-0009).
// - **How:** AES-GCM under a non-extractable 256-bit key that JavaScript can use but never read,
//   with a fresh 12-byte IV per record. The additional data, `earshot-clip:v1:<sessionId>:<turnId>`,
//   is built from where a record is stored, never from what it says, so a record moved to another
//   id fails to decrypt there.
// - **24 hours:** a record expires 24 hours after it's kept, and is never played after that, even
//   before a purge has deleted it. No browser runs code at the 24-hour mark, so expired records are
//   deleted when Earshot next opens or comes back into view, before each write, and at sign-out,
//   which deletes everything (`clear`).
// - **Too long:** a turn that ran past the 120 s cap kept no audio; its record holds none (the
//   encryption of nothing) and says only that the turn was too long to keep.
import type { TurnAudio } from "../witness/turn-audio";
import { CLIP_SAMPLE_RATE, clipCovers } from "./clip-span";

export const CLIP_DB_NAME = "earshot-evidence";
export const CLIP_DB_VERSION = 1;

/** How long a clip may be played, from when it was kept. */
export const CLIP_TTL_MS = 24 * 60 * 60 * 1000;

const DEVICE_KEY_ID = "wrapping-key";

/** AES-GCM's tag, appended to every ciphertext: all a record holding no audio encrypts to. */
const GCM_TAG_BYTES = 16;

/** One turn's audio, as the `clips` store holds it. */
export interface ClipRecord {
  /** `${sessionId}:${turnId}`. */
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Where the audio starts on the session's audio clock, in ms, as `Evidence.audioMs` counts. */
  readonly startMs: number;
  /** How long the turn ran, in ms (past 120 s for one that kept no audio). */
  readonly durationMs: number;
  readonly sampleRate: typeof CLIP_SAMPLE_RATE;
  readonly codec: "pcm16";
  /** AES-GCM's IV, 12 bytes. ArrayBuffer-backed: WebCrypto refuses a SharedArrayBuffer's views. */
  readonly iv: Uint8Array<ArrayBuffer>;
  /** The PCM, encrypted. */
  readonly data: ArrayBuffer;
  /** When it was kept, and when it stops playing: `createdAt + 24 h`. Epoch ms. */
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** A record without its audio: what the cards read to say whether a span can play. */
export interface ClipMeta {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Samples of audio the record holds: 0 for a turn too long to keep. */
  readonly samples: number;
}

/** A clip that can play now, decrypted. */
export interface Clip extends ClipMeta {
  readonly pcm: Int16Array;
}

/** What `put` keeps: one turn's audio as the engine's `turn_audio` event carries it. */
export interface ClipInput {
  readonly sessionId: string;
  readonly turnId: string;
  /** `pcm` is null when the turn ran past the cap and dropped its audio. */
  readonly audio: TurnAudio;
}

/** Where records live: IndexedDB in the browser, a Map in unit tests. */
export interface ClipBackend {
  getDeviceKey(): Promise<CryptoKey | undefined>;
  /**
   * Keeps `key` as the device key unless one is there already, in one transaction, so two tabs
   * opening at once agree on a key. Resolves to the key kept.
   */
  keepDeviceKey(key: CryptoKey): Promise<CryptoKey>;
  put(record: ClipRecord): Promise<void>;
  get(id: string): Promise<ClipRecord | undefined>;
  /** Visits the session's records one at a time, so a long debrief's audio isn't all in memory. */
  forSession(sessionId: string, visit: (record: ClipRecord) => void): Promise<void>;
  /** Deletes every record with `expiresAt <= now`. Resolves to how many it deleted. */
  deleteExpired(now: number): Promise<number>;
  delete(id: string): Promise<void>;
  /** Every record and the device key. */
  clear(): Promise<void>;
}

/** A record's id, and the place its additional data binds it to. */
export function clipId(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

const encoder = new TextEncoder();

/** The additional data for the record stored at `id`: `earshot-clip:v1:<sessionId>:<turnId>`. */
export function clipAad(id: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`earshot-clip:v1:${id}`);
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("transaction aborted"));
  });
}

/**
 * IndexedDB storage. CryptoKey objects are structured-cloneable, so the device key is stored as
 * it is, still non-extractable. Rejects where IndexedDB doesn't exist or won't open (iOS Lockdown
 * Mode, some private windows): the caller reads that as "this browser can't keep audio". Tests in
 * Node pass fake-indexeddb's factory and key ranges.
 */
export async function indexedDbClipBackend(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  name: string = CLIP_DB_NAME,
  keyRange: typeof IDBKeyRange | undefined = globalThis.IDBKeyRange,
): Promise<ClipBackend> {
  if (!factory || !keyRange) throw new Error("IndexedDB isn't available");
  const opening = factory.open(name, CLIP_DB_VERSION);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore("device");
    const clips = db.createObjectStore("clips", { keyPath: "id" });
    clips.createIndex("sessionId", "sessionId");
    clips.createIndex("expiresAt", "expiresAt");
  };
  const db = await settle(opening);
  // A later version, or a deletion, from another tab waits on this connection: let it go.
  db.onversionchange = () => db.close();
  const clips = (mode: IDBTransactionMode) => db.transaction("clips", mode).objectStore("clips");

  return {
    getDeviceKey: async () =>
      (await settle(
        db.transaction("device", "readonly").objectStore("device").get(DEVICE_KEY_ID),
      )) as CryptoKey | undefined,
    keepDeviceKey: async (key) => {
      const transaction = db.transaction("device", "readwrite");
      const store = transaction.objectStore("device");
      let kept = key;
      const reading = store.get(DEVICE_KEY_ID);
      reading.onsuccess = () => {
        if (reading.result) kept = reading.result as CryptoKey;
        else store.put(key, DEVICE_KEY_ID);
      };
      await done(transaction);
      return kept;
    },
    put: async (record) => {
      await settle(clips("readwrite").put(record));
    },
    get: async (id) => (await settle(clips("readonly").get(id))) as ClipRecord | undefined,
    forSession: async (sessionId, visit) => {
      const transaction = db.transaction("clips", "readonly");
      const cursor = transaction
        .objectStore("clips")
        .index("sessionId")
        .openCursor(keyRange.only(sessionId));
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        visit(at.value as ClipRecord);
        at.continue();
      };
      await done(transaction);
    },
    deleteExpired: async (now) => {
      const transaction = db.transaction("clips", "readwrite");
      const store = transaction.objectStore("clips");
      let deleted = 0;
      // Keys only: the expired records' audio is never read just to delete it.
      const cursor = store.index("expiresAt").openKeyCursor(keyRange.upperBound(now));
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        store.delete(at.primaryKey);
        deleted += 1;
        at.continue();
      };
      await done(transaction);
      return deleted;
    },
    delete: async (id) => {
      await settle(clips("readwrite").delete(id));
    },
    clear: async () => {
      const transaction = db.transaction(["clips", "device"], "readwrite");
      transaction.objectStore("clips").clear();
      transaction.objectStore("device").clear();
      await done(transaction);
    },
  };
}

/** In-memory storage for unit tests. Nothing persists. */
export function memoryClipBackend(): ClipBackend {
  let deviceKey: CryptoKey | undefined;
  const records = new Map<string, ClipRecord>();
  return {
    getDeviceKey: async () => deviceKey,
    keepDeviceKey: async (key) => {
      deviceKey ??= key;
      return deviceKey;
    },
    put: async (record) => {
      records.set(record.id, record);
    },
    get: async (id) => records.get(id),
    forSession: async (sessionId, visit) => {
      for (const record of [...records.values()]) if (record.sessionId === sessionId) visit(record);
    },
    deleteExpired: async (now) => {
      let deleted = 0;
      for (const [id, record] of [...records]) {
        if (record.expiresAt <= now) {
          records.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    },
    delete: async (id) => {
      records.delete(id);
    },
    clear: async () => {
      records.clear();
      deviceKey = undefined;
    },
  };
}

function metaOf(record: ClipRecord): ClipMeta {
  const { id, sessionId, turnId, startMs, durationMs, createdAt, expiresAt } = record;
  const samples = Math.max(0, Math.floor((record.data.byteLength - GCM_TAG_BYTES) / 2));
  return { id, sessionId, turnId, startMs, durationMs, createdAt, expiresAt, samples };
}

/** A record of `sessionId` stored where its own fields say it belongs. */
function inSession(record: ClipRecord, sessionId: string): boolean {
  return record.sessionId === sessionId && record.id === clipId(sessionId, record.turnId);
}

/** The PCM's bytes, ArrayBuffer-backed for WebCrypto. */
function pcmBytes(pcm: Int16Array): Uint8Array<ArrayBuffer> {
  return pcm.buffer instanceof ArrayBuffer
    ? new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    : new Uint8Array(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

/**
 * Decrypts the record stored at `record.id` with `key`. Throws when it doesn't decrypt there: a
 * record moved from another id, or written under another key.
 */
export async function openClipRecord(key: CryptoKey, record: ClipRecord): Promise<Int16Array> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: record.iv, additionalData: clipAad(record.id) },
    key,
    record.data,
  );
  return new Int16Array(plain, 0, Math.floor(plain.byteLength / 2));
}

export interface ClipStoreOptions {
  readonly backend?: ClipBackend;
  /** Epoch ms. */
  readonly now?: () => number;
}

/**
 * The clips kept on this device. Open it once per page; `put` after each turn, `find` to play a
 * span, `list` for what the cards say, `purge` and `clear` to delete.
 *
 * The device key is read from storage for each operation rather than held, so a tab that outlives
 * another tab's `clear` writes under the key storage holds now, never a forgotten one.
 */
export class ClipStore {
  readonly #backend: ClipBackend;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  /** Bumped by `clear`: a write that began before it keeps nothing. */
  #epoch = 0;

  private constructor(backend: ClipBackend, now: () => number) {
    this.#backend = backend;
    this.#now = now;
  }

  /**
   * Opens the store, creating its non-extractable device key on first use. Rejects when this
   * browser can't keep audio (no IndexedDB, or it won't open).
   */
  static async open(options: ClipStoreOptions = {}): Promise<ClipStore> {
    const backend = options.backend ?? (await indexedDbClipBackend());
    const store = new ClipStore(backend, options.now ?? Date.now);
    await store.#deviceKey();
    return store;
  }

  /** Called after this store keeps, purges, or clears anything. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Keeps one turn's audio for 24 hours, purging expired records first. A turn with no audio of
   * its own keeps nothing; one that ran past the cap keeps a record that says so. Resolves to what
   * was kept, or null.
   */
  async put(input: ClipInput): Promise<ClipMeta | null> {
    const epoch = this.#epoch;
    const now = this.#now();
    await this.purge(now);
    const { pcm, startMs, durationMs } = input.audio;
    if (epoch !== this.#epoch || (pcm !== null && pcm.length === 0)) return null;
    const id = clipId(input.sessionId, input.turnId);
    const key = await this.#deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: clipAad(id) },
      key,
      pcm === null ? new Uint8Array(0) : pcmBytes(pcm),
    );
    if (epoch !== this.#epoch) return null;
    const record: ClipRecord = {
      id,
      sessionId: input.sessionId,
      turnId: input.turnId,
      startMs,
      durationMs,
      sampleRate: CLIP_SAMPLE_RATE,
      codec: "pcm16",
      iv,
      data,
      createdAt: now,
      expiresAt: now + CLIP_TTL_MS,
    };
    await this.#backend.put(record);
    this.#changed();
    return metaOf(record);
  }

  /**
   * The clip of `sessionId` that covers `audioMs` on the session's clock, decrypted, if one can
   * play now. Null when none covers it, it has expired (never played after 24 hours, purged or
   * not), the turn was too long to keep, or it doesn't decrypt where it's stored, in which case
   * it can never play and is deleted.
   */
  async find(sessionId: string, audioMs: number): Promise<Clip | null> {
    const now = this.#now();
    let match: ClipRecord | undefined;
    await this.#backend.forSession(sessionId, (record) => {
      if (!inSession(record, sessionId) || record.expiresAt <= now) return;
      if (!clipCovers(record, audioMs)) return;
      if (!match || record.createdAt > match.createdAt) match = record;
    });
    if (!match) return null;
    const meta = metaOf(match);
    if (meta.samples === 0) return null;
    const key = await this.#backend.getDeviceKey();
    try {
      if (!key) throw new Error("no device key");
      return { ...meta, pcm: await openClipRecord(key, match) };
    } catch {
      await this.#backend.delete(match.id);
      this.#changed();
      return null;
    }
  }

  /**
   * What's kept for `sessionId`, without the audio: expired records included until a purge
   * deletes them, so a card can say its audio was deleted after 24 hours.
   */
  async list(sessionId: string): Promise<ClipMeta[]> {
    const metas: ClipMeta[] = [];
    await this.#backend.forSession(sessionId, (record) => {
      if (inSession(record, sessionId)) metas.push(metaOf(record));
    });
    return metas.sort((a, b) => a.startMs - b.startMs);
  }

  /** Deletes every record past its 24 hours. Resolves to how many. */
  async purge(now: number = this.#now()): Promise<number> {
    const deleted = await this.#backend.deleteExpired(now);
    if (deleted > 0) this.#changed();
    return deleted;
  }

  /** Deletes every clip and the device key (sign-out, or clips turned off). */
  async clear(): Promise<void> {
    this.#epoch += 1;
    await this.#backend.clear();
    this.#changed();
  }

  /** The device key storage holds, made and kept on first use. */
  async #deviceKey(): Promise<CryptoKey> {
    const stored = await this.#backend.getDeviceKey();
    if (stored) return stored;
    const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    return this.#backend.keepDeviceKey(fresh);
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A listener's bug mustn't stop the store.
      }
    }
  }
}
