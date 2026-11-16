import { describe, expect, it } from "vitest";
import {
  generateMasterKey,
  importMasterKey,
  loadVaultMasterKey,
  openSecret,
  rewrapSecret,
  sameMasterKey,
  sealSecret,
  vaultContext,
} from "../src/vault";

const SECRET = "pat-na1-0123456789abcdef0123456789abcdef";
const context = vaultContext("2f0e4d2a-0000-4000-8000-000000000001", "crm", "hubspot");

describe("vault", () => {
  it("seals and opens a secret", async () => {
    const master = await importMasterKey(generateMasterKey());
    const sealed = await sealSecret(master, SECRET, context);
    expect(new TextDecoder().decode(sealed.ciphertext)).not.toContain(SECRET);
    expect(await openSecret(master, sealed, context)).toBe(SECRET);
  });

  it("uses a fresh data key and IV every time", async () => {
    const master = await importMasterKey(generateMasterKey());
    const [a, b] = await Promise.all([
      sealSecret(master, SECRET, context),
      sealSecret(master, SECRET, context),
    ]);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.wrappedDek).not.toEqual(b.wrappedDek);
  });

  it("won't open a secret under another row's context", async () => {
    const master = await importMasterKey(generateMasterKey());
    const sealed = await sealSecret(master, SECRET, context);
    const other = vaultContext("2f0e4d2a-0000-4000-8000-000000000002", "crm", "hubspot");
    await expect(openSecret(master, sealed, other)).rejects.toThrow();
  });

  it("detects tampering with the ciphertext or the wrapped key", async () => {
    const master = await importMasterKey(generateMasterKey());
    const sealed = await sealSecret(master, SECRET, context);
    const flip = (bytes: Uint8Array) => bytes.map((b, i) => (i === 0 ? b ^ 1 : b));
    await expect(
      openSecret(master, { ...sealed, ciphertext: flip(sealed.ciphertext) }, context),
    ).rejects.toThrow();
    await expect(
      openSecret(master, { ...sealed, wrappedDek: flip(sealed.wrappedDek) }, context),
    ).rejects.toThrow();
  });

  it("rotates the master key without touching the ciphertext", async () => {
    const oldMaster = await importMasterKey(generateMasterKey());
    const newMaster = await importMasterKey(generateMasterKey());
    const sealed = await sealSecret(oldMaster, SECRET, context);
    const rotated = await rewrapSecret(oldMaster, newMaster, sealed, context);

    expect(rotated.ciphertext).toEqual(sealed.ciphertext);
    expect(await openSecret(newMaster, rotated, context)).toBe(SECRET);
    await expect(openSecret(oldMaster, rotated, context)).rejects.toThrow();
  });

  it("rejects a master key of the wrong size or encoding", async () => {
    await expect(importMasterKey(btoa("too short"))).rejects.toThrow("32 bytes");
    await expect(importMasterKey("not base64 at all!")).rejects.toThrow("base64");
  });

  it("keeps the master key from being exported or used on data", async () => {
    const master = await importMasterKey(generateMasterKey());
    expect(master.extractable).toBe(false);
    expect(master.usages.sort()).toEqual(["unwrapKey", "wrapKey"]);
  });
});

describe("loadVaultMasterKey (the vault's on/off switch)", () => {
  it("turns the vault off when EARSHOT_VAULT_MASTER_KEY is unset or blank", async () => {
    expect(await loadVaultMasterKey({})).toBeNull();
    expect(await loadVaultMasterKey({ EARSHOT_VAULT_MASTER_KEY: undefined })).toBeNull();
    expect(await loadVaultMasterKey({ EARSHOT_VAULT_MASTER_KEY: "" })).toBeNull();
    expect(await loadVaultMasterKey({ EARSHOT_VAULT_MASTER_KEY: " \n" })).toBeNull();
  });

  it("loads a key that wraps and unwraps but can't be exported", async () => {
    const encoded = generateMasterKey();
    const master = await loadVaultMasterKey({ EARSHOT_VAULT_MASTER_KEY: `${encoded}\n` });
    if (!master) throw new Error("expected the vault to be on");
    expect(master.extractable).toBe(false);
    expect(master.usages.sort()).toEqual(["unwrapKey", "wrapKey"]);

    const sealed = await sealSecret(master, SECRET, context);
    expect(await openSecret(await importMasterKey(encoded), sealed, context)).toBe(SECRET);
  });

  it("throws on a malformed key, naming the variable but never quoting it", async () => {
    for (const value of ["definitely not base64!", btoa("sixteen byte key")]) {
      const error = await loadVaultMasterKey({ EARSHOT_VAULT_MASTER_KEY: value }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/EARSHOT_VAULT_MASTER_KEY is set, but it isn't a usable/);
      expect(String(error)).not.toContain(value);
      expect(String((error as Error).cause)).not.toContain(value);
    }
  });
});

describe("sameMasterKey", () => {
  it("recognizes one key imported twice, and tells two keys apart", async () => {
    const encoded = generateMasterKey();
    const [a, b, other] = await Promise.all(
      [encoded, encoded, generateMasterKey()].map((key) => importMasterKey(key)),
    );
    if (!a || !b || !other) throw new Error("expected three keys");
    expect(await sameMasterKey(a, b)).toBe(true);
    expect(await sameMasterKey(a, other)).toBe(false);
  });
});
