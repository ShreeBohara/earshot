import { describe, expect, it } from "vitest";
import { main as newAuditKey } from "../scripts/new-audit-key";
import {
  AUDIT_RETIRED_KEYS_ENV,
  AUDIT_SIGNING_KEY_ENV,
  type AuditSigningState,
  auditKeySecretValues,
  auditPublicKeys,
  checkpointMessage,
  DEV_AUDIT_KID,
  DEV_AUDIT_SIGNING_KEY,
  fromBase64Url,
  fromHex,
  generateAuditSigningKey,
  loadAuditSigningKey,
  parseRetiredAuditKeys,
  signCheckpoint,
  toBase64Url,
  toHex,
  verifyCheckpoint,
} from "../src/audit-signing";
import { findSecretFragment } from "../src/redact";

const WID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HEAD = new Uint8Array(32).map((_, i) => i * 7);
const AT = new Date("2026-11-20T10:00:00.123Z");

/** A key made for this test only; its private half lives in this process and nowhere else. */
async function testKey(now = AT) {
  const key = await generateAuditSigningKey(now);
  const d = (JSON.parse(key.secret) as { d: string }).d;
  return { ...key, d };
}

async function signerOf(state: AuditSigningState) {
  if (!("signer" in state)) throw new Error(`no signer: ${state.status}`);
  return state.signer;
}

describe("loadAuditSigningKey", () => {
  it("imports a generated key, and signs checkpoints its public half verifies", async () => {
    const key = await testKey();
    const state = await loadAuditSigningKey(
      { EARSHOT_AUDIT_SIGNING_KEY: key.secret },
      { development: false },
    );
    expect(state.status).toBe("configured");
    const signer = await signerOf(state);
    expect(signer.kid).toBe(key.kid);
    expect(signer.development).toBe(false);
    expect(signer.publicKey).toEqual({
      kid: key.kid,
      alg: "Ed25519",
      x: JSON.parse(key.publicJwk).x,
      status: "active",
    });

    const checkpoint = await signCheckpoint(signer, { workspaceId: WID, seq: 3, head: HEAD }, AT);
    expect(checkpoint.ts).toBe("2026-11-20T10:00:00.123Z");
    expect(checkpoint.signature).toHaveLength(64);
    expect(
      await verifyCheckpoint([signer.publicKey], {
        workspaceId: WID,
        seq: 3,
        head: toHex(HEAD),
        ts: checkpoint.ts,
        kid: checkpoint.kid,
        signature: toBase64Url(checkpoint.signature),
      }),
    ).toEqual({ ok: true, key: signer.publicKey });
  });

  it("names keys audit-<date>-<4 hex> and prints a JWK the loader accepts", async () => {
    const key = await testKey(new Date("2026-12-24T23:59:59Z"));
    expect(key.kid).toMatch(/^audit-2026-12-24-[0-9a-f]{4}$/);
    expect(JSON.parse(key.publicJwk)).toEqual({
      kty: "OKP",
      crv: "Ed25519",
      x: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      kid: key.kid,
    });
    expect(key.publicJwk).not.toContain(key.d);
    expect(Object.keys(JSON.parse(key.secret))).toEqual(["kty", "crv", "d", "x", "kid"]);
  });

  it("uses the development key in development only", async () => {
    const dev = await loadAuditSigningKey({}, { development: true });
    expect(dev.status).toBe("development");
    expect((await signerOf(dev)).kid).toBe(DEV_AUDIT_KID);
    expect((await signerOf(dev)).development).toBe(true);

    expect(await loadAuditSigningKey({}, { development: false })).toEqual({ status: "missing" });
    expect(
      await loadAuditSigningKey({ EARSHOT_AUDIT_SIGNING_KEY: "  \n" }, { development: false }),
    ).toEqual({ status: "missing" });

    const refused = await loadAuditSigningKey(
      { EARSHOT_AUDIT_SIGNING_KEY: DEV_AUDIT_SIGNING_KEY },
      { development: false },
    );
    expect(refused).toEqual({
      status: "invalid",
      message: expect.stringContaining("development-only key"),
    });
    // Set explicitly in development, it's still the development key.
    expect(
      (
        await loadAuditSigningKey(
          { EARSHOT_AUDIT_SIGNING_KEY: DEV_AUDIT_SIGNING_KEY },
          { development: true },
        )
      ).status,
    ).toBe("development");
  });

  it("refuses malformed values without quoting them", async () => {
    const key = await testKey();
    const other = await testKey();
    const parsed = JSON.parse(key.secret) as Record<string, string>;
    const bad = {
      notJson: `{${key.d}`,
      notAnObject: JSON.stringify([key.d]),
      wrongCurve: JSON.stringify({ ...parsed, crv: "X25519" }),
      wrongKty: JSON.stringify({ ...parsed, kty: "EC" }),
      shortD: JSON.stringify({ ...parsed, d: key.d.slice(0, 40) }),
      noKid: JSON.stringify({ ...parsed, kid: undefined }),
      badKid: JSON.stringify({ ...parsed, kid: `kid with spaces ${key.d}` }),
      // Another key's public half: the probe signature doesn't verify.
      mismatched: JSON.stringify({ ...parsed, x: JSON.parse(other.publicJwk).x }),
    };
    for (const [name, value] of Object.entries(bad)) {
      const state = await loadAuditSigningKey(
        { EARSHOT_AUDIT_SIGNING_KEY: value },
        { development: true },
      );
      expect(state.status, name).toBe("invalid");
      const message = "message" in state ? state.message : "";
      expect(message, name).toContain(AUDIT_SIGNING_KEY_ENV);
      expect(findSecretFragment(JSON.stringify(state), key.d), name).toBeUndefined();
      expect(findSecretFragment(JSON.stringify(state), other.d), name).toBeUndefined();
    }
    const mismatched = await loadAuditSigningKey(
      { EARSHOT_AUDIT_SIGNING_KEY: bad.mismatched },
      { development: false },
    );
    // Node checks x against d when it imports the JWK; a runtime that doesn't is caught by the
    // probe signature instead.
    expect("message" in mismatched && mismatched.message).toMatch(
      /isn't a usable Ed25519 key|isn't the public half/,
    );
  });

  it("keeps the private half out of the signer and the state", async () => {
    const key = await testKey();
    const state = await loadAuditSigningKey(
      { EARSHOT_AUDIT_SIGNING_KEY: key.secret },
      { development: false },
    );
    const signer = await signerOf(state);
    const seen = JSON.stringify({ state, signer, keys: Object.keys(signer) });
    expect(findSecretFragment(seen, key.d)).toBeUndefined();
    expect(findSecretFragment(String(signer), key.d)).toBeUndefined();
  });
});

describe("checkpoints", () => {
  it("sign exactly the canonical message", () => {
    expect(
      checkpointMessage({ workspaceId: WID, seq: 12, head: HEAD, ts: AT.toISOString(), kid: "k1" }),
    ).toBe(
      `{"v":1,"wid":"${WID}","seq":12,"head":"${toHex(HEAD)}","ts":"2026-11-20T10:00:00.123Z","kid":"k1"}`,
    );
  });

  it("refuse parts that could make the message ambiguous", () => {
    const good = { workspaceId: WID, seq: 1, head: HEAD, ts: AT.toISOString(), kid: "k1" };
    for (const bad of [
      { workspaceId: WID.toUpperCase() },
      { workspaceId: "not-a-uuid" },
      { seq: 0 },
      { seq: 1.5 },
      { seq: Number.MAX_SAFE_INTEGER + 1 },
      { head: new Uint8Array(31) },
      { head: "AB".repeat(32) },
      { ts: "2026-11-20T10:00:00Z" },
      { ts: "2026-11-20T10:00:00.123+00:00" },
      { ts: "2026-02-30T10:00:00.000Z" },
      { kid: 'k"1' },
      { kid: "" },
    ]) {
      expect(() => checkpointMessage({ ...good, ...bad }), JSON.stringify(bad)).toThrow(TypeError);
    }
  });

  it("fail with a wrong key id, another key, a changed claim, or a changed signature", async () => {
    const key = await testKey();
    const other = await testKey();
    const signer = await signerOf(
      await loadAuditSigningKey({ EARSHOT_AUDIT_SIGNING_KEY: key.secret }, { development: false }),
    );
    const otherSigner = await signerOf(
      await loadAuditSigningKey(
        { EARSHOT_AUDIT_SIGNING_KEY: other.secret },
        { development: false },
      ),
    );
    const signed = await signCheckpoint(signer, { workspaceId: WID, seq: 3, head: HEAD }, AT);
    const claims = { workspaceId: WID, seq: 3, head: HEAD, ts: signed.ts, kid: signed.kid };
    const keys = [signer.publicKey, otherSigner.publicKey];

    expect((await verifyCheckpoint(keys, { ...claims, signature: signed.signature })).ok).toBe(
      true,
    );
    expect(
      await verifyCheckpoint([otherSigner.publicKey], { ...claims, signature: signed.signature }),
    ).toEqual({ ok: false, reason: "unknown_kid" });
    // The other key's id on this key's signature.
    expect(
      await verifyCheckpoint(keys, { ...claims, kid: other.kid, signature: signed.signature }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    for (const change of [
      { seq: 4 },
      { head: new Uint8Array(32) },
      { ts: AT.toISOString().replace("123", "124") },
    ]) {
      expect(
        await verifyCheckpoint(keys, { ...claims, ...change, signature: signed.signature }),
        JSON.stringify(change),
      ).toEqual({ ok: false, reason: "bad_signature" });
    }
    const flipped = new Uint8Array(signed.signature);
    flipped[10] = (flipped[10] ?? 0) ^ 1;
    expect(await verifyCheckpoint(keys, { ...claims, signature: flipped })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyCheckpoint(keys, { ...claims, signature: flipped.slice(1) })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyCheckpoint(keys, { ...claims, signature: "%%%" })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("count a retired key's signature only up to its retirement", async () => {
    const key = await testKey();
    const signer = await signerOf(
      await loadAuditSigningKey({ EARSHOT_AUDIT_SIGNING_KEY: key.secret }, { development: false }),
    );
    const retired = parseRetiredAuditKeys(
      JSON.stringify([{ ...JSON.parse(key.publicJwk), retiredAt: "2026-11-21T00:00:00Z" }]),
    );
    const before = await signCheckpoint(signer, { workspaceId: WID, seq: 1, head: HEAD }, AT);
    const after = await signCheckpoint(
      signer,
      { workspaceId: WID, seq: 2, head: HEAD },
      new Date("2026-11-22T00:00:00Z"),
    );
    const claims = (signed: typeof before, seq: number) => ({
      workspaceId: WID,
      seq,
      head: HEAD,
      ts: signed.ts,
      kid: signed.kid,
      signature: signed.signature,
    });
    expect((await verifyCheckpoint(retired, claims(before, 1))).ok).toBe(true);
    expect(await verifyCheckpoint(retired, claims(after, 2))).toEqual({
      ok: false,
      reason: "signed_after_retirement",
    });
  });
});

describe("retired keys", () => {
  it("parse public JWKs, with an optional retirement time", async () => {
    const a = await testKey();
    const b = await testKey();
    expect(parseRetiredAuditKeys(undefined)).toEqual([]);
    expect(parseRetiredAuditKeys(" ")).toEqual([]);
    expect(
      parseRetiredAuditKeys(
        JSON.stringify([
          JSON.parse(a.publicJwk),
          { ...JSON.parse(b.publicJwk), retiredAt: "2026-12-01T09:00:00+01:00", use: "sig" },
        ]),
      ),
    ).toEqual([
      { kid: a.kid, alg: "Ed25519", x: JSON.parse(a.publicJwk).x, status: "retired" },
      {
        kid: b.kid,
        alg: "Ed25519",
        x: JSON.parse(b.publicJwk).x,
        status: "retired",
        retiredAt: "2026-12-01T08:00:00.000Z",
      },
    ]);
    // A single object is accepted too.
    expect(parseRetiredAuditKeys(a.publicJwk)).toHaveLength(1);
  });

  it("refuse a private key, and never quote it", async () => {
    const key = await testKey();
    for (const value of [
      key.secret,
      JSON.stringify([JSON.parse(key.publicJwk), JSON.parse(key.secret)]),
    ]) {
      let error: unknown;
      try {
        parseRetiredAuditKeys(value);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(AUDIT_RETIRED_KEYS_ENV);
      expect((error as Error).message).toContain("private key");
      expect(findSecretFragment(String(error), key.d)).toBeUndefined();
    }
  });

  it("refuse anything else that isn't a list of Ed25519 public keys", async () => {
    const key = await testKey();
    const jwk = JSON.parse(key.publicJwk) as Record<string, string>;
    for (const value of [
      "not json",
      JSON.stringify([{ ...jwk, crv: "P-256" }]),
      JSON.stringify([{ ...jwk, x: "short" }]),
      JSON.stringify([{ ...jwk, kid: "" }]),
      JSON.stringify([{ ...jwk, retiredAt: "yesterday" }]),
      JSON.stringify([jwk, jwk]),
      JSON.stringify(["a string"]),
    ]) {
      expect(() => parseRetiredAuditKeys(value), value).toThrow(AUDIT_RETIRED_KEYS_ENV);
    }
  });

  it("list the active key first, and refuse a retired key that reuses its id", async () => {
    const key = await testKey();
    const old = await testKey();
    const state = await loadAuditSigningKey(
      { EARSHOT_AUDIT_SIGNING_KEY: key.secret },
      { development: false },
    );
    const retired = parseRetiredAuditKeys(old.publicJwk);
    expect(auditPublicKeys(state, retired).map((k) => [k.kid, k.status])).toEqual([
      [key.kid, "active"],
      [old.kid, "retired"],
    ]);
    expect(auditPublicKeys({ status: "missing" }, retired)).toEqual(retired);
    const clash = parseRetiredAuditKeys(
      JSON.stringify({ ...JSON.parse(old.publicJwk), kid: key.kid }),
    );
    expect(() => auditPublicKeys(state, clash)).toThrow(/active key's kid/);
  });
});

describe("auditKeySecretValues", () => {
  it("scrubs the whole value and its d on its own", async () => {
    const key = await testKey();
    expect(auditKeySecretValues(` ${key.secret}\n`)).toEqual([key.secret, key.d]);
    expect(auditKeySecretValues(undefined)).toEqual([]);
    expect(auditKeySecretValues("not json at all")).toEqual(["not json at all"]);
  });
});

describe("encodings", () => {
  it("round-trip base64url and hex", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(65));
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(toBase64Url(new Uint8Array([251, 255]))).toBe("-_8");
    expect(fromBase64Url("-_8=")).toEqual(new Uint8Array([251, 255]));
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(() => fromBase64Url("a+b")).toThrow(TypeError);
    expect(() => fromHex("abc")).toThrow(TypeError);
  });
});

describe("audit-key:new", () => {
  it("prints the secret and the public JWK, and refuses arguments", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { now: () => AT, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };

    expect(await newAuditKey({ argv: ["--"], ...io })).toBe(0);
    expect(err).toEqual([]);
    const [secretLine, publicLine] = out.filter((line) => line.startsWith("{"));
    const secret = JSON.parse(secretLine ?? "") as { d: string; kid: string };
    const publicJwk = JSON.parse(publicLine ?? "") as Record<string, string>;
    expect(publicJwk).not.toHaveProperty("d");
    expect(publicJwk.kid).toBe(secret.kid);
    expect(out.join("\n")).toContain(AUDIT_SIGNING_KEY_ENV);
    expect(out.join("\n")).toContain(AUDIT_RETIRED_KEYS_ENV);
    const state = await loadAuditSigningKey(
      { EARSHOT_AUDIT_SIGNING_KEY: secretLine },
      { development: false },
    );
    expect(state.status).toBe("configured");

    out.length = 0;
    expect(await newAuditKey({ argv: ["--out", "key.json"], ...io })).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).not.toContain("key.json");
  });
});
