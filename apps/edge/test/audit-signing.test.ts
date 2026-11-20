import {
  DEV_AUDIT_KID,
  DEV_AUDIT_SIGNING_KEY,
  fromHex,
  generateAuditSigningKey,
  loadAuditSigningKey,
  signCheckpoint,
  toBase64Url,
  toHex,
  verifyCheckpoint,
} from "@earshot/keys/server";
import { describe, expect, it } from "vitest";

// The spec's open question 1 (Appendix B): does workerd's WebCrypto import an Ed25519 private key
// as a JWK? If it didn't, the signing key would need PKCS#8 plus a separate public key. Both
// Workers will sign audit checkpoints with @earshot/keys's signer, so it runs here, in workerd.

/** RFC 8032, section 7.1, TEST 1: a published test vector, not anyone's key. */
const RFC8032_TEST1 = {
  d: toBase64Url(fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")),
  x: toBase64Url(fromHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")),
  signatureOfEmpty:
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
};

const WID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HEAD = new Uint8Array(32).fill(0xab);

describe("Ed25519 audit signing in workerd", () => {
  it("imports a private JWK and signs RFC 8032's known answer", async () => {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", d: RFC8032_TEST1.d, x: RFC8032_TEST1.x },
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    expect(key.type).toBe("private");
    expect(key.extractable).toBe(false);
    const signature = await crypto.subtle.sign("Ed25519", key, new Uint8Array());
    expect(toHex(new Uint8Array(signature))).toBe(RFC8032_TEST1.signatureOfEmpty);
  });

  it("generates a key, exports it as a JWK, and loads it back as the signer", async () => {
    const generated = await generateAuditSigningKey(new Date("2026-11-20T00:00:00Z"));
    const state = await loadAuditSigningKey(
      { EARSHOT_AUDIT_SIGNING_KEY: generated.secret },
      { development: false },
    );
    expect(state.status).toBe("configured");
    if (!("signer" in state)) throw new Error("no signer");

    const signed = await signCheckpoint(state.signer, { workspaceId: WID, seq: 7, head: HEAD });
    expect(signed.signature.byteLength).toBe(64);
    const claims = { workspaceId: WID, seq: 7, head: HEAD, ts: signed.ts, kid: signed.kid };
    expect(
      await verifyCheckpoint([state.signer.publicKey], { ...claims, signature: signed.signature }),
    ).toEqual({ ok: true, key: state.signer.publicKey });
    expect(
      await verifyCheckpoint([state.signer.publicKey], {
        ...claims,
        seq: 8,
        signature: signed.signature,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a JWK whose x isn't its d's public half, by the probe signature", async () => {
    const a = await generateAuditSigningKey();
    const b = await generateAuditSigningKey();
    const d = (JSON.parse(a.secret) as { d: string }).d;
    const x = (JSON.parse(b.publicJwk) as { x: string }).x;

    // Unlike Node, workerd imports such a key without complaint; only its signatures fail.
    const imported = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", d, x },
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const probe = await crypto.subtle.sign("Ed25519", imported, new Uint8Array([1]));
    const wrongPublic = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    expect(await crypto.subtle.verify("Ed25519", wrongPublic, probe, new Uint8Array([1]))).toBe(
      false,
    );

    // So the loader's own probe is what refuses it.
    const state = await loadAuditSigningKey(
      { EARSHOT_AUDIT_SIGNING_KEY: JSON.stringify({ ...JSON.parse(a.secret), x }) },
      { development: false },
    );
    expect(state).toEqual({
      status: "invalid",
      message: expect.stringMatching(/isn't the public half/),
    });
  });

  it("verifies a signature made from the same JWK in another runtime", async () => {
    // The known answer above was computed by Node's WebCrypto as well (packages/keys's tests sign
    // the same way); checking it here with the public half alone closes the loop.
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: RFC8032_TEST1.x },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        fromHex(RFC8032_TEST1.signatureOfEmpty),
        new Uint8Array(),
      ),
    ).toBe(true);
  });

  it("loads the development key in development only", async () => {
    const dev = await loadAuditSigningKey({}, { development: true });
    expect(dev.status).toBe("development");
    expect("signer" in dev && dev.signer.kid).toBe(DEV_AUDIT_KID);
    expect(
      (
        await loadAuditSigningKey(
          { EARSHOT_AUDIT_SIGNING_KEY: DEV_AUDIT_SIGNING_KEY },
          { development: false },
        )
      ).status,
    ).toBe("invalid");
  });
});
