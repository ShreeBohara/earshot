import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  DeviceKeyStore,
  indexedDbBackend,
  type KeyBackend,
  memoryBackend,
  type SecretRecord,
} from "../src/device-store";

const SECRET = "sk-test-0123456789abcdefghijklmnopqrstuvwxyzABCD";
const fixedNow = () => new Date("2026-11-15T12:00:00.000Z");

describe.each([
  ["memory", async () => memoryBackend()],
  ["IndexedDB", async () => indexedDbBackend(new IDBFactory())],
])("DeviceKeyStore on %s", (_name, makeBackend: () => Promise<KeyBackend>) => {
  it("round-trips a key and lists only metadata", async () => {
    const store = await DeviceKeyStore.open({ backend: await makeBackend(), now: fixedNow });
    const meta = await store.put("openai", "default", `  ${SECRET}  `);
    expect(meta).toEqual({
      provider: "openai",
      label: "default",
      last4: "ABCD",
      addedAt: "2026-11-15T12:00:00.000Z",
    });
    expect(await store.get("openai", "default")).toBe(SECRET);
    expect(await store.list()).toEqual([meta]);
    expect(JSON.stringify(await store.list())).not.toContain(SECRET);
  });

  it("stores only ciphertext", async () => {
    const backend = await makeBackend();
    const store = await DeviceKeyStore.open({ backend });
    await store.put("deepgram", "default", SECRET);
    const [record] = await backend.listSecrets();
    const stored = new TextDecoder().decode(record?.ciphertext);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(SECRET.slice(0, 12));
  });

  it("keeps the device key non-extractable", async () => {
    const backend = await makeBackend();
    await DeviceKeyStore.open({ backend });
    const key = await backend.getDeviceKey();
    expect(key?.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key as CryptoKey)).rejects.toThrow();
  });

  it("refuses a ciphertext moved into another slot", async () => {
    const backend = await makeBackend();
    const store = await DeviceKeyStore.open({ backend });
    await store.put("openai", "work", SECRET);
    const [record] = (await backend.listSecrets()) as [SecretRecord];
    await backend.putSecret({ ...record, id: "openai:personal", label: "personal" });
    await expect(store.get("openai", "personal")).rejects.toThrow();
  });

  it("reopens with the same device key and forgets everything on clear", async () => {
    const backend = await makeBackend();
    const first = await DeviceKeyStore.open({ backend });
    await first.put("groq", "default", SECRET);
    const second = await DeviceKeyStore.open({ backend });
    expect(await second.get("groq", "default")).toBe(SECRET);

    await second.remove("groq", "default");
    expect(await second.get("groq", "default")).toBeUndefined();

    await second.put("groq", "default", SECRET);
    await second.clear();
    expect(await backend.getDeviceKey()).toBeUndefined();
    expect(await backend.listSecrets()).toEqual([]);
  });

  it("records when a key was validated and rejects empty keys", async () => {
    const store = await DeviceKeyStore.open({ backend: await makeBackend(), now: fixedNow });
    await store.put("anthropic", "default", SECRET);
    await store.markValidated("anthropic", "default");
    expect((await store.list())[0]?.validatedAt).toBe("2026-11-15T12:00:00.000Z");
    await expect(store.put("anthropic", "blank", "   ")).rejects.toThrow("empty");
  });
});
