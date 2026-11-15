// On-device key storage (ADR-0009). Provider keys stay in the browser, encrypted at rest with a
// non-extractable AES-GCM key that JavaScript can use but never read. A key leaves the device
// only inside a request that needs it.
import { last4, type ProviderId } from "./providers";

export interface StoredKeyMeta {
  readonly provider: ProviderId;
  readonly label: string;
  readonly last4: string;
  readonly addedAt: string;
  readonly validatedAt?: string;
}

/** What the backend persists. The secret itself only exists as `ciphertext`. */
export interface SecretRecord extends StoredKeyMeta {
  readonly id: string;
  /** ArrayBuffer-backed: WebCrypto rejects views over a SharedArrayBuffer. */
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly ciphertext: ArrayBuffer;
}

/** Where records live: IndexedDB in the browser, a Map in tests and server rendering. */
export interface KeyBackend {
  getDeviceKey(): Promise<CryptoKey | undefined>;
  setDeviceKey(key: CryptoKey): Promise<void>;
  getSecret(id: string): Promise<SecretRecord | undefined>;
  putSecret(record: SecretRecord): Promise<void>;
  deleteSecret(id: string): Promise<void>;
  listSecrets(): Promise<SecretRecord[]>;
  clear(): Promise<void>;
}

const DB_NAME = "earshot-keys";
const DEVICE_KEY_ID = "wrapping-key";

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** IndexedDB storage. CryptoKey objects are structured-cloneable, so the device key is stored as-is. */
export async function indexedDbBackend(
  factory: IDBFactory = globalThis.indexedDB,
  name = DB_NAME,
): Promise<KeyBackend> {
  const opening = factory.open(name, 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore("device");
    opening.result.createObjectStore("secrets", { keyPath: "id" });
  };
  const db = await settle(opening);
  const store = (name: "device" | "secrets", mode: IDBTransactionMode) =>
    db.transaction(name, mode).objectStore(name);

  return {
    getDeviceKey: async () =>
      (await settle(store("device", "readonly").get(DEVICE_KEY_ID))) as CryptoKey | undefined,
    setDeviceKey: async (key) => {
      await settle(store("device", "readwrite").put(key, DEVICE_KEY_ID));
    },
    getSecret: async (id) =>
      (await settle(store("secrets", "readonly").get(id))) as SecretRecord | undefined,
    putSecret: async (record) => {
      await settle(store("secrets", "readwrite").put(record));
    },
    deleteSecret: async (id) => {
      await settle(store("secrets", "readwrite").delete(id));
    },
    listSecrets: async () =>
      (await settle(store("secrets", "readonly").getAll())) as SecretRecord[],
    clear: async () => {
      await settle(store("secrets", "readwrite").clear());
      await settle(store("device", "readwrite").clear());
    },
  };
}

/** In-memory storage for tests and server rendering. Nothing persists. */
export function memoryBackend(): KeyBackend {
  let deviceKey: CryptoKey | undefined;
  const secrets = new Map<string, SecretRecord>();
  return {
    getDeviceKey: async () => deviceKey,
    setDeviceKey: async (key) => {
      deviceKey = key;
    },
    getSecret: async (id) => secrets.get(id),
    putSecret: async (record) => {
      secrets.set(record.id, record);
    },
    deleteSecret: async (id) => {
      secrets.delete(id);
    },
    listSecrets: async () => [...secrets.values()],
    clear: async () => {
      secrets.clear();
      deviceKey = undefined;
    },
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const slotId = (provider: ProviderId, label: string) => `${provider}:${label}`;

/** Additional authenticated data: a ciphertext only decrypts in the slot it was written to. */
const slotAad = (provider: ProviderId, label: string) =>
  encoder.encode(`earshot:device:v1:${provider}:${label}`);

function toMeta(record: SecretRecord): StoredKeyMeta {
  const { provider, label, last4, addedAt, validatedAt } = record;
  return validatedAt === undefined
    ? { provider, label, last4, addedAt }
    : { provider, label, last4, addedAt, validatedAt };
}

export interface DeviceKeyStoreOptions {
  readonly backend?: KeyBackend;
  readonly now?: () => Date;
}

export class DeviceKeyStore {
  readonly #backend: KeyBackend;
  readonly #key: CryptoKey;
  readonly #now: () => Date;

  private constructor(backend: KeyBackend, key: CryptoKey, now: () => Date) {
    this.#backend = backend;
    this.#key = key;
    this.#now = now;
  }

  /** Opens the store, creating this device's non-extractable wrapping key on first use. */
  static async open(options: DeviceKeyStoreOptions = {}): Promise<DeviceKeyStore> {
    const backend = options.backend ?? (await indexedDbBackend());
    let key = await backend.getDeviceKey();
    if (!key) {
      key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      await backend.setDeviceKey(key);
    }
    return new DeviceKeyStore(backend, key, options.now ?? (() => new Date()));
  }

  /** Metadata only: provider, label, last four characters, dates. Never the secret. */
  async list(): Promise<StoredKeyMeta[]> {
    const records = await this.#backend.listSecrets();
    return records
      .map(toMeta)
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
  }

  async put(provider: ProviderId, label: string, secret: string): Promise<StoredKeyMeta> {
    const value = secret.trim();
    if (value.length === 0) throw new Error("A key can't be empty.");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: slotAad(provider, label) },
      this.#key,
      encoder.encode(value),
    );
    const record: SecretRecord = {
      id: slotId(provider, label),
      provider,
      label,
      last4: last4(value),
      addedAt: this.#now().toISOString(),
      iv,
      ciphertext,
    };
    await this.#backend.putSecret(record);
    return toMeta(record);
  }

  /** Decrypts in memory for one request. Callers must not persist or log the result. */
  async get(provider: ProviderId, label: string): Promise<string | undefined> {
    const record = await this.#backend.getSecret(slotId(provider, label));
    if (!record) return undefined;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv, additionalData: slotAad(provider, label) },
      this.#key,
      record.ciphertext,
    );
    return decoder.decode(plain);
  }

  async markValidated(provider: ProviderId, label: string): Promise<void> {
    const record = await this.#backend.getSecret(slotId(provider, label));
    if (record)
      await this.#backend.putSecret({ ...record, validatedAt: this.#now().toISOString() });
  }

  async remove(provider: ProviderId, label: string): Promise<void> {
    await this.#backend.deleteSecret(slotId(provider, label));
  }

  /** Forgets every key and the device key itself. */
  async clear(): Promise<void> {
    await this.#backend.clear();
  }
}
