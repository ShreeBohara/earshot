// Session tickets (Phase 3 spec §4.3): short-lived credentials the web app signs and the edge
// Worker checks before a browser may open a session socket.
//
//   payload = base64url(JSON.stringify({ v: 1, sid, uid, wid, jti, iat, exp, am?, sat? }))
//   ticket  = payload + "." + base64url(HMAC-SHA256(EARSHOT_SESSION_TICKET_SECRET, payload))
//
// Browsers can't set headers on a WebSocket, so the ticket travels as the subprotocol
// `earshot.ticket.<ticket>`, which also keeps it out of URLs and logs. Base64url characters and
// `.` are legal in a subprotocol token. Only WebCrypto and plain JavaScript are used, so this runs
// unchanged in Workers, Node, and browsers.
//
// A valid ticket proves the web app issued it, within the last minute, for this session, user,
// and workspace, and, from Phase 5, how and when the web session that asked for it signed in.
// Single use is SessionDO's job: it refuses a `jti` it has already seen.
import { z } from "zod";
import { base64urlDecode, base64urlEncode } from "./base64url";
import { SignInMethod } from "./contracts/events/proposal-reviewed";
import { SESSION_SUBPROTOCOL } from "./contracts/session-protocol";
import { uuidv7 } from "./uuidv7";

export const TICKET_VERSION = 1;
/** The longest a ticket may live, `exp - iat` (target). Signing and verifying both enforce it. */
export const MAX_TICKET_LIFETIME_SECONDS = 60;
/**
 * How far the verifier's clock may disagree with the signer's. Both are Workers on NTP-synced
 * clocks, usually in the same location, and `iat` is truncated to whole seconds, so 5 s absorbs
 * real drift while a ticket stays usable for at most 70 s in all.
 */
export const TICKET_CLOCK_SKEW_SECONDS = 5;
/**
 * Longer tickets are refused before any decoding. Valid claims make at most about 700: a uid that
 * JSON escapes in full, with the sign-in claims.
 */
export const MAX_TICKET_LENGTH = 1024;
/** `EARSHOT_SESSION_TICKET_SECRET` must be at least this many bytes of UTF-8. */
export const MIN_TICKET_SECRET_BYTES = 32;
/** The prefix of the subprotocol entry that carries the ticket. */
export const TICKET_SUBPROTOCOL_PREFIX = "earshot.ticket.";

/**
 * The ticket secret for zero-setup development only. With no `EARSHOT_SESSION_TICKET_SECRET` set,
 * the web app and the edge Worker both fall back to it in development, so tickets one signs the
 * other accepts, and a fresh clone runs without a `.dev.vars`. It's in the source, so anyone can
 * sign tickets with it: outside development, configuration must refuse it (`isDevTicketSecret`),
 * as the web app refuses its development-only Better Auth secret.
 */
export const DEV_SESSION_TICKET_SECRET =
  "earshot-development-only-session-ticket-secret-never-deploy-this";

/**
 * True if `secret` is the development-only ticket secret, ignoring surrounding whitespace, as an
 * environment file can leave it. Configuration outside development refuses it.
 */
export function isDevTicketSecret(secret: string | null | undefined): boolean {
  return secret?.trim() === DEV_SESSION_TICKET_SECRET;
}

const SIGNATURE_BYTES = 32; // HMAC-SHA256

const Seconds = z.int().nonnegative();

/**
 * What a ticket says. `iat`, `exp`, and `sat` are whole seconds since the Unix epoch. `am` and
 * `sat` are optional and come together (Phase 5): `SessionDO` records them on every review the
 * socket sends, as how and when the reviewer signed in. A ticket without them is still version
 * 1, and signs to exactly the bytes it always did.
 */
export const TicketClaims = z
  .strictObject({
    v: z.literal(TICKET_VERSION),
    /** The session; the edge checks it against the socket's URL. */
    sid: z.uuid(),
    /** The user and the workspace. `SessionDO` pins both on the first connection. */
    uid: z
      .string()
      .max(128)
      .regex(/^[\x21-\x7e]+$/),
    wid: z.uuid(),
    /** UUIDv7. `SessionDO` refuses one it has seen, so a ticket opens one socket. */
    jti: z.uuid(),
    iat: Seconds,
    exp: Seconds,
    /** How the web session that minted the ticket signed in. */
    am: SignInMethod.optional(),
    /** When that web session signed in: never after the ticket, give or take the clock skew. */
    sat: Seconds.optional(),
  })
  .refine((claims) => claims.exp > claims.iat, { path: ["exp"], message: "exp must be after iat" })
  .refine((claims) => (claims.am === undefined) === (claims.sat === undefined), {
    path: ["am"],
    message: "am and sat come together",
  })
  .refine(
    (claims) => claims.sat === undefined || claims.sat <= claims.iat + TICKET_CLOCK_SKEW_SECONDS,
    {
      path: ["sat"],
      message: "sat can't be after the ticket was issued",
    },
  );
export type TicketClaims = z.infer<typeof TicketClaims>;

/**
 * Why a ticket was refused: not a ticket at all, signed with another key (or altered), a version
 * this reader doesn't know, a lifetime over the limit, issued in the future, or expired.
 */
export type TicketFailure =
  | "malformed"
  | "bad_signature"
  | "wrong_version"
  | "lifetime_too_long"
  | "not_yet_valid"
  | "expired";

export type TicketVerification =
  | { readonly ok: true; readonly claims: TicketClaims }
  | { readonly ok: false; readonly reason: TicketFailure };

/**
 * The ticket secret: the raw string, imported on every call, or a key from `importTicketKey`
 * that the caller imports once and keeps.
 */
export type TicketSecret = string | CryptoKey;

const utf8 = new TextEncoder();
// Both options spelled out: Workers' types require `ignoreBOM`.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Imports the ticket secret as an HMAC-SHA256 key for signing and verifying. */
export async function importTicketKey(secret: string): Promise<CryptoKey> {
  const bytes = utf8.encode(secret);
  if (bytes.byteLength < MIN_TICKET_SECRET_BYTES) {
    throw new RangeError(`the ticket secret must be at least ${MIN_TICKET_SECRET_BYTES} bytes`);
  }
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/**
 * Claims for a new ticket: a fresh `jti`, issued at `now`, living `ttlSeconds` (60 by default).
 * `signIn`, when given, is how and when the web session asking for it signed in (`am`, `sat`).
 */
export function ticketClaims(input: {
  sid: string;
  uid: string;
  wid: string;
  now: Date;
  ttlSeconds?: number;
  jti?: string;
  signIn?: { method: SignInMethod; at: Date };
}): TicketClaims {
  const ttl = input.ttlSeconds ?? MAX_TICKET_LIFETIME_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TICKET_LIFETIME_SECONDS) {
    throw new RangeError(`a ticket lives 1 to ${MAX_TICKET_LIFETIME_SECONDS} whole seconds`);
  }
  const iat = Math.floor(epochMs(input.now) / 1000);
  const claims: TicketClaims = {
    v: TICKET_VERSION,
    sid: input.sid,
    uid: input.uid,
    wid: input.wid,
    jti: input.jti ?? uuidv7(),
    iat,
    exp: iat + ttl,
  };
  if (!input.signIn) return claims;
  return {
    ...claims,
    am: input.signIn.method,
    sat: Math.floor(epochMs(input.signIn.at) / 1000),
  };
}

/** Signs claims into a ticket. Throws on claims that `verifyTicket` would refuse. */
export async function signTicket(secret: TicketSecret, claims: TicketClaims): Promise<string> {
  const parsed = TicketClaims.safeParse(claims);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "claims");
    throw new TypeError(`invalid ticket claims: ${fields.join(", ")}`);
  }
  const { v, sid, uid, wid, jti, iat, exp, am, sat } = parsed.data;
  if (exp - iat > MAX_TICKET_LIFETIME_SECONDS) {
    throw new RangeError(`a ticket lives at most ${MAX_TICKET_LIFETIME_SECONDS} s`);
  }
  const key = await keyFor(secret);
  // A fixed key order, so the same claims always make the same ticket. The sign-in claims come
  // last, and only when set, so a ticket without them is byte for byte what it was before them.
  const body =
    am === undefined
      ? { v, sid, uid, wid, jti, iat, exp }
      : { v, sid, uid, wid, jti, iat, exp, am, sat };
  const payload = base64urlEncode(utf8.encode(JSON.stringify(body)));
  const signature = await crypto.subtle.sign("HMAC", key, utf8.encode(payload));
  const ticket = `${payload}.${base64urlEncode(new Uint8Array(signature))}`;
  // Can't happen with valid claims (an ASCII uid of at most 128 characters), but a ticket the
  // verifier would refuse must never leave here.
  if (ticket.length > MAX_TICKET_LENGTH) throw new RangeError("the ticket is too long");
  return ticket;
}

/**
 * Checks a ticket's signature, version, lifetime, and time window, allowing
 * `TICKET_CLOCK_SKEW_SECONDS` either way. The caller still checks `sid` against the URL, and
 * `SessionDO` checks the `jti` and the pinned user and workspace. Throws only for a bad secret,
 * which is a configuration error, not a bad ticket.
 */
export async function verifyTicket(
  secret: TicketSecret,
  ticket: string,
  now: Date,
): Promise<TicketVerification> {
  const nowSeconds = epochMs(now) / 1000;
  const parts = splitTicket(ticket);
  const signature = parts && base64urlDecode(parts.signature);
  if (!parts || signature?.byteLength !== SIGNATURE_BYTES) return refuse("malformed");

  // The signature first, so nothing unauthenticated gets parsed. `verify` compares in constant time.
  const key = await keyFor(secret);
  if (!(await crypto.subtle.verify("HMAC", key, signature, utf8.encode(parts.payload)))) {
    return refuse("bad_signature");
  }

  const body = decodePayload(parts.payload);
  if (body === undefined) return refuse("malformed");
  if (body.v !== undefined && body.v !== TICKET_VERSION) return refuse("wrong_version");
  const parsed = TicketClaims.safeParse(body);
  if (!parsed.success) return refuse("malformed");
  const claims = parsed.data;
  if (claims.exp - claims.iat > MAX_TICKET_LIFETIME_SECONDS) return refuse("lifetime_too_long");
  if (nowSeconds < claims.iat - TICKET_CLOCK_SKEW_SECONDS) return refuse("not_yet_valid");
  if (nowSeconds >= claims.exp + TICKET_CLOCK_SKEW_SECONDS) return refuse("expired");
  return { ok: true, claims };
}

/** The subprotocol entry that carries `ticket`: `earshot.ticket.<ticket>`. */
export function ticketSubprotocol(ticket: string): string {
  return `${TICKET_SUBPROTOCOL_PREFIX}${ticket}`;
}

/**
 * The ticket in a `Sec-WebSocket-Protocol` request header, which lists the offered subprotocols
 * separated by commas: `earshot.v1, earshot.ticket.<ticket>`. Undefined unless the header offers
 * `earshot.v1` and exactly one ticket. Answer the handshake with `earshot.v1` alone, never with
 * the ticket entry, so the ticket isn't echoed.
 */
export function ticketFromSubprotocols(header: string | null | undefined): string | undefined {
  const offered = (header ?? "").split(",").map((entry) => entry.trim());
  if (!offered.includes(SESSION_SUBPROTOCOL)) return undefined;
  const tickets = offered.filter((entry) => entry.startsWith(TICKET_SUBPROTOCOL_PREFIX));
  const ticket = tickets.length === 1 ? tickets[0]?.slice(TICKET_SUBPROTOCOL_PREFIX.length) : "";
  return ticket || undefined;
}

function refuse(reason: TicketFailure): TicketVerification {
  return { ok: false, reason };
}

function epochMs(date: Date): number {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new TypeError("expected a valid Date");
  return ms;
}

/**
 * The ticket secret as an HMAC key: imported from the string, or the key the caller imported. The
 * policy snapshot (policy-snapshot.ts) is signed with the same secret.
 */
export async function keyFor(secret: TicketSecret): Promise<CryptoKey> {
  if (typeof secret === "string") return importTicketKey(secret);
  if (secret.algorithm.name !== "HMAC") throw new TypeError("the ticket key must be an HMAC key");
  return secret;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function splitTicket(ticket: unknown): { payload: string; signature: string } | undefined {
  if (typeof ticket !== "string" || ticket.length > MAX_TICKET_LENGTH) return undefined;
  const [payload, signature, ...rest] = ticket.split(".");
  if (rest.length > 0 || !payload || !signature) return undefined;
  if (!BASE64URL.test(payload) || !BASE64URL.test(signature)) return undefined;
  return { payload, signature };
}

/** The payload's JSON object, or undefined if it isn't base64url of a UTF-8 JSON object. */
function decodePayload(payload: string): Record<string, unknown> | undefined {
  const bytes = base64urlDecode(payload);
  if (!bytes) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(strictUtf8.decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
