// Signing the audit chain's checkpoints (docs/adr/0033). Postgres chains every audit_log row
// with SHA-256; a Worker signs the chain's head with Ed25519 once per review request, so an
// export can prove later that nobody without this key edited, deleted, or reordered a row.
//
// The private key is a Worker secret, EARSHOT_AUDIT_SIGNING_KEY: a private JWK
// ({"kty":"OKP","crv":"Ed25519","d":…,"x":…,"kid":…}), on both Workers. It's imported as a
// non-extractable WebCrypto key, and nothing here ever returns, logs, or throws its value: errors
// name the variable only. Development uses a committed key, refused anywhere else, as the
// session ticket's development secret is. `/api/audit/keys` serves the public halves: the active
// key and the retired ones listed in EARSHOT_AUDIT_RETIRED_KEYS.

// ArrayBuffer-backed bytes: WebCrypto rejects views over a SharedArrayBuffer.
type Bytes = Uint8Array<ArrayBuffer>;

/** The Worker secret holding the private signing key. */
export const AUDIT_SIGNING_KEY_ENV = "EARSHOT_AUDIT_SIGNING_KEY";
/** The public variable listing rotated-out public keys (a JSON array of public JWKs). */
export const AUDIT_RETIRED_KEYS_ENV = "EARSHOT_AUDIT_RETIRED_KEYS";

/** The only algorithm: Ed25519, as WebCrypto names it. */
export const AUDIT_SIGNING_ALG = "Ed25519";

/**
 * The development key's id. Its private half is committed below, so anyone can sign with it: a
 * checkpoint it signed proves nothing, and `loadAuditSigningKey` refuses it outside development.
 */
export const DEV_AUDIT_KID = "audit-development";

/**
 * The development-only signing key, for `next dev`, `wrangler dev`, and tests, so a fresh clone
 * signs checkpoints with no setup. Public on purpose; never accepted outside development.
 */
export const DEV_AUDIT_SIGNING_KEY = JSON.stringify({
  kty: "OKP",
  crv: "Ed25519",
  d: "0pfICY3uZdWwKWpRw7Bad0pKBgeG6pwaLJ6aJLByukw",
  x: "nUcmyW3nIkJwBDLwcrjjGoh0BeaNfV6zifT2u4vcMyA",
  kid: DEV_AUDIT_KID,
});
const DEV_AUDIT_X = "nUcmyW3nIkJwBDLwcrjjGoh0BeaNfV6zifT2u4vcMyA";

/**
 * Whether a public key is the development key, by its reserved id or by its public half's
 * decoded bytes, never its text: base64url has more than one spelling of the same 32 bytes (the
 * last character's unused bits), so a string comparison would let a re-spelled copy of this
 * publicly known key pass as a deployment's. A verifier counts its signatures as unsigned by
 * default: anyone can make them, under any kid.
 */
export function isDevelopmentAuditKey(key: { readonly kid: string; readonly x: string }): boolean {
  if (key.kid === DEV_AUDIT_KID) return true;
  let bytes: Bytes;
  try {
    bytes = fromBase64Url(key.x);
  } catch {
    return false;
  }
  return sameBytes(bytes, fromBase64Url(DEV_AUDIT_X));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A key id: letters, digits, `.`, `_`, and `-`, at most 64 characters, starting alphanumeric. */
const KID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 32 bytes as base64url without padding: an Ed25519 public key (`x`) or seed (`d`). */
const KEY_32 = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_32 = /^[0-9a-f]{64}$/;
/** The checkpoint's time: ISO 8601 in UTC with milliseconds, as `Date.toISOString` writes it. */
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const encoder = new TextEncoder();

/** UTF-8 bytes on a plain ArrayBuffer. Workers' types widen `encode()` to ArrayBufferLike. */
function utf8(text: string): Bytes {
  return encoder.encode(text) as Bytes;
}

/** `value` without trailing `=`, scanned by hand rather than with a regex on its input. */
function stripPadding(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 61) end--;
  return value.slice(0, end);
}

/** Base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return stripPadding(btoa(binary).replaceAll("+", "-").replaceAll("/", "_"));
}

/** Decodes base64url (padding optional). Throws a TypeError on anything else. */
export function fromBase64Url(value: string): Bytes {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new TypeError("not base64url");
  const base64 = stripPadding(value).replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)) as Bytes;
}

/**
 * Whether `value` is 32 bytes in canonical base64url: 43 characters, no padding, and the last
 * character's unused bits zero, so it's the one spelling `toBase64Url` writes for those bytes.
 * Every key Earshot reads (the signing secret's `d` and `x`, retired keys, keys in a file) must
 * pass, so one key can't be listed under two spellings.
 */
export function isCanonicalKey32(value: string): boolean {
  if (!KEY_32.test(value)) return false;
  try {
    return toBase64Url(fromBase64Url(value)) === value;
  } catch {
    return false;
  }
}

/** Lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Decodes even-length hex, either case. Throws a TypeError on anything else. */
export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new TypeError("not hex");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** A public signing key, as `/api/audit/keys` serves it and as exports carry it. */
export interface AuditPublicKey {
  readonly kid: string;
  readonly alg: typeof AUDIT_SIGNING_ALG;
  /** The public key: 32 bytes, base64url without padding (a JWK's `x`). */
  readonly x: string;
  readonly status: "active" | "retired";
  /** For a retired key: when it stopped signing. A checkpoint it signed after this is refused. */
  readonly retiredAt?: string;
}

/** Signs checkpoints. Holds a non-extractable key; nothing on it reveals the private half. */
export interface AuditSigner {
  readonly kid: string;
  /** The public half, with `status: "active"`. */
  readonly publicKey: AuditPublicKey;
  /** True for the committed development key, whose signatures prove nothing. */
  readonly development: boolean;
  /** An Ed25519 signature (64 bytes) over `message`. */
  sign(message: Uint8Array): Promise<Bytes>;
}

/**
 * What a Worker can do about signing, from its environment. Only `configured` and `development`
 * can sign; with either of the others, writes that need a checkpoint fail closed (reviews answer
 * 503 `audit_unavailable`) and `/api/health` says which.
 */
export type AuditSigningState =
  | { readonly status: "configured"; readonly signer: AuditSigner }
  | { readonly status: "development"; readonly signer: AuditSigner }
  | { readonly status: "missing" }
  | {
      readonly status: "invalid";
      /** Why, naming the variable and never its value: safe to log. */
      readonly message: string;
    };

/** A configuration problem with the audit keys. The message names the variable, never a value. */
export class AuditKeyError extends Error {
  override readonly name = "AuditKeyError";
}

interface PrivateJwk {
  readonly d: string;
  readonly x: string;
  readonly kid: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks a private JWK's shape. Members other than kty, crv, d, x, and kid are ignored. Throws
 * AuditKeyError without quoting the value.
 */
function parsePrivateJwk(raw: string): PrivateJwk {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AuditKeyError(`${AUDIT_SIGNING_KEY_ENV} isn't JSON: it must be a private JWK.`);
  }
  if (!isRecord(value) || value.kty !== "OKP" || value.crv !== "Ed25519") {
    throw new AuditKeyError(
      `${AUDIT_SIGNING_KEY_ENV} must be an Ed25519 private JWK ({"kty":"OKP","crv":"Ed25519",…}).`,
    );
  }
  const { d, x, kid } = value;
  if (
    typeof d !== "string" ||
    !isCanonicalKey32(d) ||
    typeof x !== "string" ||
    !isCanonicalKey32(x)
  ) {
    throw new AuditKeyError(
      `${AUDIT_SIGNING_KEY_ENV} must hold "d" and "x", each 32 bytes in canonical base64url.`,
    );
  }
  if (typeof kid !== "string" || !KID.test(kid)) {
    throw new AuditKeyError(
      `${AUDIT_SIGNING_KEY_ENV} needs a "kid" of letters, digits, ".", "_", or "-" (at most 64).`,
    );
  }
  return { d, x, kid };
}

const PROBE = utf8("earshot.audit.probe.v1");

async function importPublicKey(x: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x },
    { name: AUDIT_SIGNING_ALG },
    false,
    ["verify"],
  );
}

/**
 * Imports a private JWK into a signer. Proves `x` belongs to `d` by signing a probe and checking
 * it with `x`, so the public key served for verification is the one that signs.
 */
async function importSigner(jwk: PrivateJwk, development: boolean): Promise<AuditSigner> {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x },
      { name: AUDIT_SIGNING_ALG },
      false,
      ["sign"],
    );
    publicKey = await importPublicKey(jwk.x);
  } catch {
    throw new AuditKeyError(`${AUDIT_SIGNING_KEY_ENV} isn't a usable Ed25519 key.`);
  }
  const probe = await crypto.subtle.sign(AUDIT_SIGNING_ALG, privateKey, PROBE);
  if (!(await crypto.subtle.verify(AUDIT_SIGNING_ALG, publicKey, probe, PROBE))) {
    throw new AuditKeyError(
      `${AUDIT_SIGNING_KEY_ENV}'s "x" isn't the public half of its "d": regenerate the key.`,
    );
  }
  return {
    kid: jwk.kid,
    publicKey: { kid: jwk.kid, alg: AUDIT_SIGNING_ALG, x: jwk.x, status: "active" },
    development,
    sign: async (message) =>
      new Uint8Array(await crypto.subtle.sign(AUDIT_SIGNING_ALG, privateKey, message as Bytes)),
  };
}

/**
 * The deployment's signing state, from `EARSHOT_AUDIT_SIGNING_KEY`:
 *
 * - set and valid: `configured`;
 * - unset in development: `development`, signing with the committed development key;
 * - unset anywhere else: `missing`;
 * - set but malformed, not an Ed25519 key, with an `x` that isn't `d`'s, or the development key
 *   outside development: `invalid`, with a message that names the variable and never quotes it.
 *
 * Never throws for a bad value: callers report the state (`/api/health`) and fail closed.
 * `development` is the caller's call, made as it makes it for the ticket secret: `next dev` in the
 * web app, `DEPLOY_ENV=development` in the edge Worker.
 */
export async function loadAuditSigningKey(
  env: { readonly EARSHOT_AUDIT_SIGNING_KEY?: string | undefined },
  { development }: { readonly development: boolean },
): Promise<AuditSigningState> {
  const raw = env.EARSHOT_AUDIT_SIGNING_KEY?.trim();
  try {
    if (!raw) {
      if (!development) return { status: "missing" };
      return {
        status: "development",
        signer: await importSigner(parsePrivateJwk(DEV_AUDIT_SIGNING_KEY), true),
      };
    }
    const jwk = parsePrivateJwk(raw);
    const isDev = isDevelopmentAuditKey(jwk);
    if (isDev && !development) {
      throw new AuditKeyError(
        `${AUDIT_SIGNING_KEY_ENV} is the development-only key, which anyone can sign with; generate a new one (pnpm --filter @earshot/keys audit-key:new).`,
      );
    }
    const signer = await importSigner(jwk, isDev);
    return isDev ? { status: "development", signer } : { status: "configured", signer };
  } catch (error) {
    return {
      status: "invalid",
      message:
        error instanceof AuditKeyError
          ? error.message
          : `${AUDIT_SIGNING_KEY_ENV} isn't a usable signing key.`,
    };
  }
}

/**
 * The values a redacting logger must scrub for this secret: the whole value as set, and its `d`
 * on its own, which would survive JSON escaping if the value were ever logged inside JSON.
 */
export function auditKeySecretValues(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [];
  const values = [value];
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed) && typeof parsed.d === "string" && parsed.d.length >= 8) {
      values.push(parsed.d);
    }
  } catch {
    // Not JSON: the whole value is still scrubbed.
  }
  return values;
}

/**
 * The retired public keys from `EARSHOT_AUDIT_RETIRED_KEYS`: a JSON array of public JWKs, each
 * `{"kty":"OKP","crv":"Ed25519","x":…,"kid":…}` with an optional `retiredAt` (an ISO time, when
 * the key stopped signing). Unset or empty means none. Throws AuditKeyError, naming the variable
 * and never quoting it, for anything else, and above all for an entry holding a private key
 * (`d`): this variable is public, and a private key in it must never be served.
 */
export function parseRetiredAuditKeys(raw: string | undefined): AuditPublicKey[] {
  const value = raw?.trim();
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AuditKeyError(`${AUDIT_RETIRED_KEYS_ENV} isn't JSON: it must be an array of JWKs.`);
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const keys: AuditPublicKey[] = [];
  for (const entry of entries) {
    if (isRecord(entry) && "d" in entry) {
      throw new AuditKeyError(
        `${AUDIT_RETIRED_KEYS_ENV} holds a private key ("d"). It must list public keys only: remove it, and treat that key as exposed.`,
      );
    }
    if (
      !isRecord(entry) ||
      entry.kty !== "OKP" ||
      entry.crv !== "Ed25519" ||
      typeof entry.x !== "string" ||
      !isCanonicalKey32(entry.x) ||
      typeof entry.kid !== "string" ||
      !KID.test(entry.kid)
    ) {
      throw new AuditKeyError(
        `${AUDIT_RETIRED_KEYS_ENV} must list Ed25519 public JWKs, each with "x" and "kid".`,
      );
    }
    let retiredAt: string | undefined;
    if (entry.retiredAt !== undefined) {
      const ms = typeof entry.retiredAt === "string" ? Date.parse(entry.retiredAt) : Number.NaN;
      if (Number.isNaN(ms)) {
        throw new AuditKeyError(
          `${AUDIT_RETIRED_KEYS_ENV}: "retiredAt" must be an ISO time, such as 2026-12-01T09:00:00Z.`,
        );
      }
      retiredAt = new Date(ms).toISOString();
    }
    if (keys.some((key) => key.kid === entry.kid)) {
      throw new AuditKeyError(`${AUDIT_RETIRED_KEYS_ENV} lists one kid twice.`);
    }
    keys.push({
      kid: entry.kid,
      alg: AUDIT_SIGNING_ALG,
      x: entry.x,
      status: "retired",
      ...(retiredAt ? { retiredAt } : {}),
    });
  }
  return keys;
}

/**
 * Whether a value is a well-formed public key as `/api/audit/keys` serves it: a kid of the allowed
 * characters, `alg` Ed25519, a 32-byte `x`, a status, and an optional ISO `retiredAt`. Verifiers
 * check keys they read from a file with this before trusting or printing anything in them.
 */
export function isAuditPublicKey(value: unknown): value is AuditPublicKey {
  return (
    isRecord(value) &&
    typeof value.kid === "string" &&
    KID.test(value.kid) &&
    value.alg === AUDIT_SIGNING_ALG &&
    typeof value.x === "string" &&
    isCanonicalKey32(value.x) &&
    (value.status === "active" || value.status === "retired") &&
    (value.retiredAt === undefined ||
      (typeof value.retiredAt === "string" && !Number.isNaN(Date.parse(value.retiredAt)))) &&
    !("d" in value)
  );
}

/**
 * Every public key a verifier may need: the active key, if this Worker can sign, then the retired
 * ones. Throws AuditKeyError if a retired key reuses the active key's id.
 */
export function auditPublicKeys(
  state: AuditSigningState,
  retired: readonly AuditPublicKey[],
): AuditPublicKey[] {
  const active = "signer" in state ? [state.signer.publicKey] : [];
  for (const key of active) {
    if (retired.some((old) => old.kid === key.kid)) {
      throw new AuditKeyError(
        `${AUDIT_RETIRED_KEYS_ENV} lists the active key's kid; give each key its own kid.`,
      );
    }
  }
  return [...active, ...retired];
}

/** What a checkpoint signs: the chain's head in one workspace, at one time, under one key. */
export interface CheckpointClaims {
  readonly workspaceId: string;
  /** The head's `chain_seq`. */
  readonly seq: number;
  /** The head's `entry_hash`: 32 bytes, or 64 lowercase hex characters. */
  readonly head: Uint8Array | string;
  /** When it was signed, as `Date.toISOString` writes it. */
  readonly ts: string;
  readonly kid: string;
}

function headHex(head: Uint8Array | string): string {
  if (typeof head === "string") {
    if (!HEX_32.test(head)) throw new TypeError("checkpoint head must be 64 lowercase hex digits");
    return head;
  }
  if (head.byteLength !== 32) throw new TypeError("checkpoint head must be 32 bytes");
  return toHex(head);
}

/**
 * The exact text a checkpoint signs, as UTF-8: `{"v":1,"wid":…,"seq":…,"head":…,"ts":…,"kid":…}`,
 * members in this order, no spaces. Every part is checked first, so the text is unambiguous and
 * any verifier can rebuild it from a checkpoint's columns. Throws a TypeError on a bad part.
 */
export function checkpointMessage(claims: CheckpointClaims): string {
  const { workspaceId, seq, ts, kid } = claims;
  if (!UUID.test(workspaceId)) throw new TypeError("checkpoint workspace must be a lowercase UUID");
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new TypeError("checkpoint seq must be a positive integer");
  }
  if (!ISO_MS.test(ts) || new Date(ts).toISOString() !== ts) {
    throw new TypeError("checkpoint ts must be an ISO time in UTC with milliseconds");
  }
  if (!KID.test(kid)) throw new TypeError("checkpoint kid is malformed");
  return JSON.stringify({ v: 1, wid: workspaceId, seq, head: headHex(claims.head), ts, kid });
}

/** A signed checkpoint, ready to store. */
export interface SignedCheckpoint {
  readonly kid: string;
  readonly ts: string;
  /** The text that was signed. */
  readonly message: string;
  /** 64 bytes. */
  readonly signature: Bytes;
}

/** Signs the chain's head at `at` (default now). */
export async function signCheckpoint(
  signer: AuditSigner,
  head: { readonly workspaceId: string; readonly seq: number; readonly head: Uint8Array | string },
  at: Date = new Date(),
): Promise<SignedCheckpoint> {
  const ts = at.toISOString();
  const message = checkpointMessage({ ...head, ts, kid: signer.kid });
  return { kid: signer.kid, ts, message, signature: await signer.sign(utf8(message)) };
}

export type CheckpointVerdict =
  | { readonly ok: true; readonly key: AuditPublicKey }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "unknown_kid" | "bad_signature" | "signed_after_retirement";
    };

/**
 * Checks a checkpoint's signature with the key its `kid` names. A retired key's signature counts
 * only up to its `retiredAt`. `signature` is the 64 raw bytes, or base64url.
 */
export async function verifyCheckpoint(
  keys: readonly AuditPublicKey[],
  checkpoint: CheckpointClaims & { readonly signature: Uint8Array | string },
): Promise<CheckpointVerdict> {
  let message: string;
  let signature: Bytes;
  try {
    message = checkpointMessage(checkpoint);
    signature =
      typeof checkpoint.signature === "string"
        ? fromBase64Url(checkpoint.signature)
        : (new Uint8Array(checkpoint.signature) as Bytes);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (signature.byteLength !== 64) return { ok: false, reason: "malformed" };
  const key = keys.find((candidate) => candidate.kid === checkpoint.kid);
  if (!key) return { ok: false, reason: "unknown_kid" };
  let publicKey: CryptoKey;
  try {
    publicKey = await importPublicKey(key.x);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!(await crypto.subtle.verify(AUDIT_SIGNING_ALG, publicKey, signature, utf8(message)))) {
    return { ok: false, reason: "bad_signature" };
  }
  if (key.retiredAt !== undefined && Date.parse(checkpoint.ts) > Date.parse(key.retiredAt)) {
    return { ok: false, reason: "signed_after_retirement" };
  }
  return { ok: true, key };
}

/** A new signing key, for `audit-key:new`: the secret's value and its public JWK, both as JSON. */
export interface GeneratedAuditKey {
  readonly kid: string;
  /** For EARSHOT_AUDIT_SIGNING_KEY. Secret. */
  readonly secret: string;
  /** For EARSHOT_AUDIT_RETIRED_KEYS once the key is rotated out. Public. */
  readonly publicJwk: string;
}

/**
 * Generates a key named `audit-<date>-<4 hex>`, such as `audit-2026-11-20-a1b2`. The private
 * half exists only in the returned string; nothing is written anywhere.
 */
export async function generateAuditSigningKey(now: Date = new Date()): Promise<GeneratedAuditKey> {
  // A key pair for Ed25519, though not every runtime's types say so.
  const pair: unknown = await crypto.subtle.generateKey({ name: AUDIT_SIGNING_ALG }, true, [
    "sign",
    "verify",
  ]);
  if (typeof pair !== "object" || pair === null || !("privateKey" in pair)) {
    throw new Error("The runtime didn't generate an Ed25519 key pair.");
  }
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey as CryptoKey)) as {
    readonly d?: unknown;
    readonly x?: unknown;
  };
  if (typeof jwk.d !== "string" || typeof jwk.x !== "string") {
    throw new Error("The runtime exported an Ed25519 key without d or x.");
  }
  const suffix = toHex(crypto.getRandomValues(new Uint8Array(2)));
  const kid = `audit-${now.toISOString().slice(0, 10)}-${suffix}`;
  return {
    kid,
    secret: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x, kid }),
    publicJwk: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x, kid }),
  };
}
