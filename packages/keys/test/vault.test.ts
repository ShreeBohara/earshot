import { describe, expect, it } from "vitest";
import {
  generateMasterKey,
  importMasterKey,
  openSecret,
  rewrapSecret,
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
