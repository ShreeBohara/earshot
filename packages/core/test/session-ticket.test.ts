import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEV_SESSION_TICKET_SECRET,
  importTicketKey,
  isDevTicketSecret,
  MAX_TICKET_LENGTH,
  MAX_TICKET_LIFETIME_SECONDS,
  MIN_TICKET_SECRET_BYTES,
  SESSION_SUBPROTOCOL,
  signTicket,
  TICKET_CLOCK_SKEW_SECONDS,
  type TicketClaims,
  ticketClaims,
  ticketFromSubprotocols,
  ticketSubprotocol,
  verifyTicket,
} from "../src";

const SECRET = "test-only-ticket-secret-0123456789abcdef"; // 40 bytes
const OTHER_SECRET = "another-test-ticket-secret-0123456789abcdef";
const NOW = new Date("2026-11-15T20:00:00.250Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const SESSION = { sid: "01a1c6e2-9320-7deb-a57a-ba62dc02df02", uid: "u_9fK2mQx7Lr" };
const WID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const JTI = "01a1e296-7487-71d5-82b8-8d5d5374ce05";

const claims = (overrides: Partial<TicketClaims> = {}): TicketClaims => ({
  ...ticketClaims({ ...SESSION, wid: WID, now: NOW, jti: JTI }),
  ...overrides,
});
const at = (seconds: number) => new Date(seconds * 1000);

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** Signs any payload, valid or not, the way `signTicket` would, to forge edge cases. */
async function forge(secret: string, payload: unknown): Promise<string> {
  const body = base64url(
    encoder.encode(typeof payload === "string" ? payload : JSON.stringify(payload)),
  );
  const key = await importTicketKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signTicket and verifyTicket", () => {
  it("round-trip the claims", async () => {
    const ticket = await signTicket(SECRET, claims());
    expect(await verifyTicket(SECRET, ticket, NOW)).toEqual({ ok: true, claims: claims() });
  });

  it("write the format of spec §4.3: base64url JSON, a dot, and a base64url HMAC", async () => {
    const ticket = await signTicket(SECRET, claims());
    const [payload, signature, ...rest] = ticket.split(".");
    expect(rest).toEqual([]);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, unpadded
    const json = new TextDecoder().decode(
      Uint8Array.from(atob((payload ?? "").replaceAll("-", "+").replaceAll("_", "/")), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(Object.keys(JSON.parse(json))).toEqual(["v", "sid", "uid", "wid", "jti", "iat", "exp"]);
    expect(await forge(SECRET, JSON.parse(json))).toBe(ticket);
  });

  it("make the same ticket from the same claims, in any key order", async () => {
    const reversed = Object.fromEntries(Object.entries(claims()).reverse()) as TicketClaims;
    expect(await signTicket(SECRET, reversed)).toBe(await signTicket(SECRET, claims()));
  });

  it("compare signatures with crypto.subtle.verify, which is constant-time", async () => {
    const verify = vi.spyOn(crypto.subtle, "verify");
    await verifyTicket(SECRET, await signTicket(SECRET, claims()), NOW);
    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.calls[0]?.[0]).toBe("HMAC");
  });

  it("accept a key imported once, interchangeably with the raw secret", async () => {
    const key = await importTicketKey(SECRET);
    const ticket = await signTicket(key, claims());
    expect(ticket).toBe(await signTicket(SECRET, claims()));
    expect((await verifyTicket(SECRET, ticket, NOW)).ok).toBe(true);
    expect((await verifyTicket(key, ticket, NOW)).ok).toBe(true);
  });
});

describe("verifyTicket refuses", () => {
  it("a tampered payload", async () => {
    const ticket = await signTicket(SECRET, claims());
    const [, signature] = ticket.split(".");
    const otherPayload = (await signTicket(SECRET, claims({ uid: "u_attacker" }))).split(".")[0];
    expect(await verifyTicket(SECRET, `${otherPayload}.${signature}`, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("a tampered signature", async () => {
    const ticket = await signTicket(SECRET, claims());
    const i = ticket.indexOf(".") + 5;
    const flipped = `${ticket.slice(0, i)}${ticket[i] === "A" ? "B" : "A"}${ticket.slice(i + 1)}`;
    expect(await verifyTicket(SECRET, flipped, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("a ticket signed with another secret", async () => {
    const ticket = await signTicket(OTHER_SECRET, claims());
    expect(await verifyTicket(SECRET, ticket, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("an expired ticket, once the skew allowance runs out", async () => {
    const ticket = await signTicket(SECRET, claims());
    const { exp } = claims();
    expect((await verifyTicket(SECRET, ticket, at(exp - 0.001))).ok).toBe(true);
    expect(
      (await verifyTicket(SECRET, ticket, at(exp + TICKET_CLOCK_SKEW_SECONDS - 0.001))).ok,
    ).toBe(true);
    expect(await verifyTicket(SECRET, ticket, at(exp + TICKET_CLOCK_SKEW_SECONDS))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await verifyTicket(SECRET, ticket, at(exp + 3600))).toMatchObject({ reason: "expired" });
  });

  it("a ticket from the future, beyond the skew allowance", async () => {
    const ticket = await signTicket(SECRET, claims());
    const { iat } = claims();
    expect((await verifyTicket(SECRET, ticket, at(iat - TICKET_CLOCK_SKEW_SECONDS))).ok).toBe(true);
    expect(await verifyTicket(SECRET, ticket, at(iat - TICKET_CLOCK_SKEW_SECONDS - 0.001))).toEqual(
      {
        ok: false,
        reason: "not_yet_valid",
      },
    );
  });

  it("nothing within the skew allowance, whichever clock runs ahead", async () => {
    const ticket = await signTicket(SECRET, claims());
    const { iat, exp } = claims();
    const skew = TICKET_CLOCK_SKEW_SECONDS - 1;
    expect((await verifyTicket(SECRET, ticket, at(iat - skew))).ok).toBe(true); // verifier behind
    expect((await verifyTicket(SECRET, ticket, at(exp + skew))).ok).toBe(true); // verifier ahead
    expect(TICKET_CLOCK_SKEW_SECONDS).toBe(5);
  });

  it("a version it doesn't know, signed with the right secret", async () => {
    const v2 = await forge(SECRET, { ...claims(), v: 2 });
    expect(await verifyTicket(SECRET, v2, NOW)).toEqual({ ok: false, reason: "wrong_version" });
    const { v: _, ...unversioned } = claims();
    expect(await verifyTicket(SECRET, await forge(SECRET, unversioned), NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("a lifetime over 60 seconds, even when the signature is good", async () => {
    const { iat } = claims();
    const tooLong = await forge(SECRET, claims({ exp: iat + MAX_TICKET_LIFETIME_SECONDS + 1 }));
    expect(await verifyTicket(SECRET, tooLong, NOW)).toEqual({
      ok: false,
      reason: "lifetime_too_long",
    });
    const justRight = await forge(SECRET, claims({ exp: iat + MAX_TICKET_LIFETIME_SECONDS }));
    expect((await verifyTicket(SECRET, justRight, NOW)).ok).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["no dot", "abcdef"],
    ["three parts", "abc.def.ghi"],
    ["an empty payload", ".abcdef"],
    ["an empty signature", "abcdef."],
    ["standard base64 characters", "ab+c.de/f"],
    ["padding", "abcd.ef=="],
    ["a signature of the wrong length", `abcd.${"A".repeat(42)}`],
    ["non-ASCII", "abcdé.fghij"],
    ["a ticket over the length limit", `${"A".repeat(MAX_TICKET_LENGTH - 43)}.${"A".repeat(43)}`],
  ])("a malformed ticket: %s", async (_, ticket) => {
    expect(await verifyTicket(SECRET, ticket, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("a signature with a non-canonical last character, so a ticket has one spelling", async () => {
    const ticket = await signTicket(SECRET, claims());
    const last = ticket.at(-1) ?? "";
    // 43 characters carry 258 bits for 256: the last character's two low bits must be zero.
    const sibling = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".charAt(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(last) + 1,
    );
    expect(await verifyTicket(SECRET, `${ticket.slice(0, -1)}${sibling}`, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it.each([
    ["not JSON", "{v:1"],
    ["a JSON array", [1, 2, 3]],
    ["an extra claim", { ...claims(), admin: true }],
    ["a session id that isn't a UUID", { ...claims(), sid: "session-1" }],
    ["an expiry before issue", { ...claims(), exp: NOW_S - 1 }],
    ["fractional seconds", { ...claims(), iat: NOW_S + 0.5 }],
    ["a uid with a space", { ...claims(), uid: "u 1" }],
  ])("a correctly signed payload with %s, as malformed", async (_, payload) => {
    expect(await verifyTicket(SECRET, await forge(SECRET, payload), NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("secrets and claims", () => {
  it("refuse a secret shorter than 32 bytes, as a configuration error", async () => {
    const short = "s".repeat(31);
    await expect(importTicketKey(short)).rejects.toBeInstanceOf(RangeError);
    await expect(signTicket(short, claims())).rejects.toBeInstanceOf(RangeError);
    const ticket = await signTicket(SECRET, claims());
    await expect(verifyTicket(short, ticket, NOW)).rejects.toBeInstanceOf(RangeError);
  });

  it("refuse a key that isn't HMAC", async () => {
    const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
    ]);
    await expect(signTicket(aes, claims())).rejects.toBeInstanceOf(TypeError);
  });

  it("never sign claims the verifier would refuse", async () => {
    const { iat } = claims();
    await expect(signTicket(SECRET, claims({ exp: iat + 61 }))).rejects.toBeInstanceOf(RangeError);
    await expect(signTicket(SECRET, claims({ exp: iat }))).rejects.toThrow(/exp/);
    await expect(signTicket(SECRET, claims({ sid: "nope" }))).rejects.toThrow(/sid/);
    await expect(signTicket(SECRET, { ...claims(), v: 2 } as never)).rejects.toThrow(
      "invalid ticket claims: v",
    );
  });

  it("issue claims for now, living 60 seconds, with a fresh UUIDv7 jti", () => {
    const a = ticketClaims({ ...SESSION, wid: WID, now: NOW });
    const b = ticketClaims({ ...SESSION, wid: WID, now: NOW });
    expect(a).toMatchObject({ v: 1, ...SESSION, wid: WID, iat: NOW_S, exp: NOW_S + 60 });
    expect(a.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.jti).not.toBe(b.jti);
    expect(ticketClaims({ ...SESSION, wid: WID, now: NOW, ttlSeconds: 30 }).exp).toBe(NOW_S + 30);
    for (const ttlSeconds of [0, 61, 1.5]) {
      expect(() => ticketClaims({ ...SESSION, wid: WID, now: NOW, ttlSeconds })).toThrow(
        RangeError,
      );
    }
    expect(() => ticketClaims({ ...SESSION, wid: WID, now: new Date(Number.NaN) })).toThrow(
      TypeError,
    );
  });

  it("stay well under the length limit, whatever the claims", async () => {
    const longest = claims({ uid: "~".repeat(128), iat: 2 ** 52, exp: 2 ** 52 + 60 });
    expect((await signTicket(SECRET, longest)).length).toBeLessThan(MAX_TICKET_LENGTH / 2);
    await expect(signTicket(SECRET, claims({ uid: "~".repeat(129) }))).rejects.toThrow(/uid/);
  });
});

describe("the sign-in claims, am and sat (Phase 5)", () => {
  const signedIn = (overrides: Partial<TicketClaims> = {}) =>
    claims({ am: "passkey", sat: NOW_S - 3_600, ...overrides });

  it("round-trip, written last, after exp", async () => {
    const ticket = await signTicket(SECRET, signedIn());
    expect(await verifyTicket(SECRET, ticket, NOW)).toEqual({ ok: true, claims: signedIn() });
    const [payload] = ticket.split(".");
    const json = new TextDecoder().decode(
      Uint8Array.from(atob((payload ?? "").replaceAll("-", "+").replaceAll("_", "/")), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(Object.keys(JSON.parse(json))).toEqual([
      "v",
      "sid",
      "uid",
      "wid",
      "jti",
      "iat",
      "exp",
      "am",
      "sat",
    ]);
    expect(await forge(SECRET, JSON.parse(json))).toBe(ticket);
  });

  it("are optional: a ticket without them signs and verifies as it always did", async () => {
    const ticket = await signTicket(SECRET, claims());
    const verified = await verifyTicket(SECRET, ticket, NOW);
    expect(verified).toEqual({ ok: true, claims: claims() });
    expect(verified.ok && "am" in verified.claims).toBe(false);
    expect(ticket).not.toBe(await signTicket(SECRET, signedIn()));
  });

  it("take every sign-in method, and nothing else", async () => {
    for (const am of ["passkey", "magic_link", "github", "google", "unknown"] as const) {
      const ticket = await signTicket(SECRET, signedIn({ am }));
      expect((await verifyTicket(SECRET, ticket, NOW)).ok).toBe(true);
    }
    const password = await forge(SECRET, { ...signedIn(), am: "password" });
    expect(await verifyTicket(SECRET, password, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("come together, or not at all", async () => {
    const { sat: _, ...methodOnly } = signedIn();
    const { am: __, ...timeOnly } = signedIn();
    await expect(signTicket(SECRET, methodOnly as TicketClaims)).rejects.toThrow(
      "invalid ticket claims: am",
    );
    await expect(signTicket(SECRET, timeOnly as TicketClaims)).rejects.toThrow(/am/);
    for (const payload of [methodOnly, timeOnly]) {
      expect(await verifyTicket(SECRET, await forge(SECRET, payload), NOW)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("refuse a sign-in after the ticket, beyond the clock skew, as milliseconds would be", async () => {
    const { iat } = claims();
    const justInside = signedIn({ sat: iat + TICKET_CLOCK_SKEW_SECONDS });
    expect((await verifyTicket(SECRET, await signTicket(SECRET, justInside), NOW)).ok).toBe(true);
    for (const sat of [iat + TICKET_CLOCK_SKEW_SECONDS + 1, (iat - 3_600) * 1000]) {
      await expect(signTicket(SECRET, signedIn({ sat }))).rejects.toThrow(/sat/);
      const forged = await forge(SECRET, signedIn({ sat }));
      expect(await verifyTicket(SECRET, forged, NOW)).toEqual({ ok: false, reason: "malformed" });
    }
    await expect(signTicket(SECRET, signedIn({ sat: 1.5 }))).rejects.toThrow(/sat/);
  });

  it("are filled by ticketClaims from the web session's sign-in, in whole seconds", () => {
    const at = new Date(NOW.getTime() - 3_600_000 - 999);
    const filled = ticketClaims({
      ...SESSION,
      wid: WID,
      now: NOW,
      signIn: { method: "github", at },
    });
    expect(filled).toMatchObject({ am: "github", sat: NOW_S - 3_601 });
    expect(ticketClaims({ ...SESSION, wid: WID, now: NOW })).not.toHaveProperty("am");
  });

  it("keep the longest ticket under the length limit, with room to spare", async () => {
    // A uid JSON escapes in full doubles in the payload: the worst case there is.
    const longest = claims({
      uid: "\\".repeat(128),
      iat: 2 ** 52,
      exp: 2 ** 52 + 60,
      am: "magic_link",
      sat: 2 ** 52,
    });
    const length = (await signTicket(SECRET, longest)).length;
    expect(length).toBeGreaterThan(MAX_TICKET_LENGTH / 2);
    expect(length).toBeLessThan(MAX_TICKET_LENGTH * 0.75);
  });
});

describe("the development secret", () => {
  it("is long enough to sign with, and says what it is", async () => {
    const bytes = new TextEncoder().encode(DEV_SESSION_TICKET_SECRET).byteLength;
    expect(bytes).toBeGreaterThanOrEqual(MIN_TICKET_SECRET_BYTES);
    expect(DEV_SESSION_TICKET_SECRET).toMatch(/development-only/);
    const ticket = await signTicket(DEV_SESSION_TICKET_SECRET, claims());
    expect((await verifyTicket(DEV_SESSION_TICKET_SECRET, ticket, NOW)).ok).toBe(true);
  });

  it("is detected, even inside whitespace from an env file, and nothing else is", () => {
    expect(isDevTicketSecret(DEV_SESSION_TICKET_SECRET)).toBe(true);
    expect(isDevTicketSecret(`  ${DEV_SESSION_TICKET_SECRET}\n`)).toBe(true);
    for (const other of [SECRET, `${DEV_SESSION_TICKET_SECRET}-2`, "", null, undefined]) {
      expect(isDevTicketSecret(other)).toBe(false);
    }
  });
});

describe("the subprotocol token", () => {
  // RFC 6455 section 4.1 refers to RFC 2616 tokens: printable ASCII without separators. That is
  // RFC 7230's tchar set; browsers throw a SyntaxError on anything else.
  const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

  it("is a legal token for any valid claims", async () => {
    const uids = ["u_9fK2mQx7Lr", "~".repeat(128), "!#$%&'*+-.^_`|~\"(),/:;<=>?@[\\]{}"];
    for (const uid of uids) {
      const ticket = await signTicket(SECRET, claims({ uid }));
      expect(ticketSubprotocol(ticket)).toMatch(TOKEN);
      expect(ticketSubprotocol(ticket).startsWith("earshot.ticket.")).toBe(true);
    }
    expect(SESSION_SUBPROTOCOL).toMatch(TOKEN);
  });

  it("comes back out of a Sec-WebSocket-Protocol header and verifies", async () => {
    const ticket = await signTicket(SECRET, claims());
    const offered = [SESSION_SUBPROTOCOL, ticketSubprotocol(ticket)];
    const header = offered.join(", ");
    expect(ticketFromSubprotocols(header)).toBe(ticket);
    expect(ticketFromSubprotocols([...offered].reverse().join(","))).toBe(ticket);
    expect((await verifyTicket(SECRET, ticketFromSubprotocols(header) ?? "", NOW)).ok).toBe(true);
  });

  it("needs earshot.v1 and exactly one non-empty ticket", async () => {
    const ticket = await signTicket(SECRET, claims());
    for (const header of [
      ticketSubprotocol(ticket),
      `earshot.v2, ${ticketSubprotocol(ticket)}`,
      `earshot.v1, ${ticketSubprotocol(ticket)}, ${ticketSubprotocol(ticket)}`,
      "earshot.v1, earshot.ticket.",
      "earshot.v1",
      "",
      null,
      undefined,
    ]) {
      expect(ticketFromSubprotocols(header)).toBeUndefined();
    }
  });
});
