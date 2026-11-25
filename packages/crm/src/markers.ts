// The idempotency key and the write markers (Phase 6 spec §4.4, decisions 3 and 7; docs/adr/0040).
// The key names a sync job, one approval of one proposal; each of the job's writes carries a marker
// made from it, so a retried write finds its first try in the CRM instead of landing twice. A Retry
// is a new attempt under the same key, so it finds everything that landed before. WebCrypto only:
// they run in Workers, browsers, and Node alike.

const KEY_PREFIX = "earshot.sync.v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[0-9a-f]{64}$/;
/** RFC 4648's base32 alphabet, in lower case. */
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** What every marker starts with. */
export const MARKER_PREFIX = "es_";
/** How many base32 characters follow it: 100 bits of the digest. */
export const MARKER_CHARS = 20;

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** RFC 4648 base32, in lower case and without padding. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32.charAt((buffer >> bits) & 31);
    }
  }
  if (bits > 0) out += BASE32.charAt((buffer << (5 - bits)) & 31);
  return out;
}

/**
 * A sync job's idempotency key (decision 3): lowercase hex SHA-256 of `earshot.sync.v1:`, the
 * proposal's id, `:`, and the review's id, each lowercased first so the key doesn't depend on how
 * an id was spelled. Both ids are random UUIDs, so the key, which is unique across workspaces,
 * reveals nothing about another workspace's jobs.
 */
export async function idempotencyKey(proposalId: string, reviewId: string): Promise<string> {
  if (!UUID.test(proposalId)) throw new TypeError("proposalId must be a UUID");
  if (!UUID.test(reviewId)) throw new TypeError("reviewId must be a UUID");
  const input = `${KEY_PREFIX}${proposalId.toLowerCase()}:${reviewId.toLowerCase()}`;
  return hex(await sha256(input));
}

/**
 * The marker of the write at `index` in the job keyed `key` (decision 7): `es_` and the first 20
 * characters of the lowercase base32, without padding, of SHA-256 of the key, `:`, and the index.
 * Lower case letters and digits, so it's safe in any field or URL.
 */
export async function marker(key: string, index: number): Promise<string> {
  if (!KEY.test(key))
    throw new TypeError("key must be an idempotency key: 64 lowercase hex digits");
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("index must be a write's place in its plan: an integer, 0 or more");
  }
  return MARKER_PREFIX + base32(await sha256(`${key}:${index}`)).slice(0, MARKER_CHARS);
}

const MARKER = /^es_([a-z2-7]{20})$/;

/**
 * A record id a CRM lets the client choose (`client_id` idempotency, decision 7; Twenty's, if
 * creates take one): a UUID, version 8, made from the marker's 100 bits, so a retry's create
 * collides with its first try and a `get` by the same id finds it. The marker's bits fill the
 * custom bits in order (48, then 12, then 40 of the last 62), and the rest are zero.
 */
export function markerUuid(markerText: string): string {
  const match = MARKER.exec(markerText);
  if (!match) throw new TypeError("markerUuid takes a marker: es_ and 20 base32 characters");
  let bits = 0n;
  for (const char of match[1] as string) bits = (bits << 5n) | BigInt(BASE32.indexOf(char));
  const a = bits >> 52n;
  const b = (bits >> 40n) & 0xfffn;
  const c = bits & ((1n << 40n) - 1n);
  const value = (a << 80n) | (8n << 76n) | (b << 64n) | (2n << 62n) | (c << 22n);
  const hexText = value.toString(16).padStart(32, "0");
  return [
    hexText.slice(0, 8),
    hexText.slice(8, 12),
    hexText.slice(12, 16),
    hexText.slice(16, 20),
    hexText.slice(20),
  ].join("-");
}
