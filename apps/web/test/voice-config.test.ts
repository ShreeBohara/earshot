import {
  DEV_SESSION_TICKET_SECRET,
  MAX_TICKET_LIFETIME_SECONDS,
  ticketFromSubprotocols,
  ticketSubprotocol,
  verifyTicket,
} from "@earshot/core";
import type { FetchLike } from "@earshot/keys/server";
import { describe, expect, it, vi } from "vitest";
import { requestLogger } from "@/lib/log";
import { readSessionConfig, SessionConfigError } from "@/lib/voice/config";
import { MINT_REQUESTS, mintCredential } from "@/lib/voice/mint";
import { issueTicket, sessionSocketUrl } from "@/lib/voice/tickets";
import { memoryLogger } from "./support/harness";

const SECRET = "cfgVx9Qm2Lr7Hw4Zp8Nc6Bt1Kd5Jy3Fg0Ua7Se2Wq";
const EDGE = "https://earshot-edge.example.workers.dev";
const NOW = new Date("2026-11-15T19:15:00.000Z");

describe("readSessionConfig", () => {
  it("runs with no configuration in development, on the development-only secret and the local edge Worker", () => {
    expect(readSessionConfig({}, "development")).toEqual({
      ticketSecret: DEV_SESSION_TICKET_SECRET,
      edgeOrigin: "ws://localhost:8787",
    });
    expect(readSessionConfig({ EDGE_DEV_URL: "http://localhost:9000" }, "development")).toEqual({
      ticketSecret: DEV_SESSION_TICKET_SECRET,
      edgeOrigin: "ws://localhost:9000",
    });
    // EDGE_PUBLIC_URL wins over EDGE_DEV_URL wherever it's set.
    expect(
      readSessionConfig(
        { EDGE_PUBLIC_URL: EDGE, EDGE_DEV_URL: "http://localhost:9000" },
        "development",
      ).edgeOrigin,
    ).toBe("wss://earshot-edge.example.workers.dev");
  });

  it("requires both values outside development", () => {
    expect(() => readSessionConfig({ EDGE_PUBLIC_URL: EDGE }, "production")).toThrow(
      /EARSHOT_SESSION_TICKET_SECRET is not set/,
    );
    expect(() =>
      readSessionConfig(
        { EARSHOT_SESSION_TICKET_SECRET: SECRET, EDGE_DEV_URL: EDGE },
        "production",
      ),
    ).toThrow(/EDGE_PUBLIC_URL is not set/);
    expect(
      readSessionConfig(
        { EARSHOT_SESSION_TICKET_SECRET: ` ${SECRET}\n`, EDGE_PUBLIC_URL: EDGE },
        "production",
      ),
    ).toEqual({ ticketSecret: SECRET, edgeOrigin: "wss://earshot-edge.example.workers.dev" });
  });

  it("refuses the development-only secret outside development, however it's padded", () => {
    for (const secret of [DEV_SESSION_TICKET_SECRET, `  ${DEV_SESSION_TICKET_SECRET}\n`]) {
      expect(() =>
        readSessionConfig(
          { EARSHOT_SESSION_TICKET_SECRET: secret, EDGE_PUBLIC_URL: EDGE },
          "production",
        ),
      ).toThrow(/development-only value/);
    }
  });

  it("refuses a secret shorter than 32 bytes, in any mode", () => {
    for (const mode of ["development", "production"] as const) {
      expect(() =>
        readSessionConfig(
          { EARSHOT_SESSION_TICKET_SECRET: "x".repeat(31), EDGE_PUBLIC_URL: EDGE },
          mode,
        ),
      ).toThrow(/at least 32 bytes/);
    }
    // Bytes, not characters: 11 three-byte characters are 33 bytes.
    expect(
      readSessionConfig(
        { EARSHOT_SESSION_TICKET_SECRET: "鍵".repeat(11), EDGE_PUBLIC_URL: EDGE },
        "production",
      ).ticketSecret,
    ).toBe("鍵".repeat(11));
  });

  it("turns the edge URL into a WebSocket origin, and refuses anything but an https origin outside localhost", () => {
    const origin = (url: string, mode: "development" | "production" = "production") =>
      readSessionConfig({ EARSHOT_SESSION_TICKET_SECRET: SECRET, EDGE_PUBLIC_URL: url }, mode)
        .edgeOrigin;
    expect(origin("https://edge.example")).toBe("wss://edge.example");
    expect(origin("https://edge.example/")).toBe("wss://edge.example");
    expect(origin("wss://edge.example:8443")).toBe("wss://edge.example:8443");
    expect(origin("http://localhost:8788")).toBe("ws://localhost:8788");
    expect(origin("http://127.0.0.1:8788")).toBe("ws://127.0.0.1:8788");
    expect(origin("http://edge.example", "development")).toBe("ws://edge.example");

    const refused: Array<[string, RegExp]> = [
      ["http://edge.example", /must use https outside development/],
      ["ws://edge.example", /must use https outside development/],
      ["ftp://edge.example", /must use https/],
      ["edge.example", /must be an absolute URL/],
      ["https://edge.example/v1", /must be an origin/],
      ["https://edge.example/?x=1", /must be an origin/],
      ["https://edge.example/#x", /must be an origin/],
      ["https://user:pass@edge.example", /must be an origin/],
    ];
    for (const [url, message] of refused) {
      expect(() => origin(url), url).toThrow(SessionConfigError);
      expect(() => origin(url), url).toThrow(message);
    }
  });

  it("never quotes a value in its errors", () => {
    const values = [
      { EARSHOT_SESSION_TICKET_SECRET: "tiny-secret-value", EDGE_PUBLIC_URL: EDGE },
      {
        EARSHOT_SESSION_TICKET_SECRET: SECRET,
        EDGE_PUBLIC_URL: "https://secret-host.example/path",
      },
    ];
    for (const env of values) {
      try {
        readSessionConfig(env, "production");
        throw new Error("expected a SessionConfigError");
      } catch (error) {
        expect(error).toBeInstanceOf(SessionConfigError);
        const { message } = error as Error;
        expect(message).not.toContain("tiny-secret-value");
        expect(message).not.toContain("secret-host");
      }
    }
  });
});

describe("issueTicket", () => {
  const input = {
    sessionId: "6f1d2c3b-4a5e-4f60-8a7b-000000000042",
    userId: "IiHAYqZeoqRVJKnPKlhiKA1ExUTrVh2N",
    workspaceId: "6f1d2c3b-4a5e-4f60-8a7b-000000000007",
    now: NOW,
  };

  it("signs a 60-second ticket for this session, user, and workspace that core's verifyTicket accepts", async () => {
    const { ticket, expiresAt } = await issueTicket(SECRET, input);
    expect(expiresAt).toEqual(new Date(NOW.getTime() + MAX_TICKET_LIFETIME_SECONDS * 1000));
    const verified = await verifyTicket(SECRET, ticket, NOW);
    expect(verified).toMatchObject({
      ok: true,
      claims: { v: 1, sid: input.sessionId, uid: input.userId, wid: input.workspaceId },
    });
    // It rides in the subprotocol, and comes back out whole.
    expect(ticketFromSubprotocols(`earshot.v1, ${ticketSubprotocol(ticket)}`)).toBe(ticket);
  });

  it("gives every ticket its own jti", async () => {
    const a = await verifyTicket(SECRET, (await issueTicket(SECRET, input)).ticket, NOW);
    const b = await verifyTicket(SECRET, (await issueTicket(SECRET, input)).ticket, NOW);
    if (!a.ok || !b.ok) throw new Error("both tickets should verify");
    expect(a.claims.jti).not.toBe(b.claims.jti);
  });

  it("puts the session in the socket's URL, and the ticket nowhere in it", async () => {
    expect(sessionSocketUrl("wss://edge.example", input.sessionId)).toBe(
      `wss://edge.example/v1/sessions/${input.sessionId}/ws`,
    );
  });
});

describe("mintCredential", () => {
  const KEY = "mintKq8Rv3Lz6Wx1Np4Ty7Hs2Jd5Fg9Bc0";
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtaW50In0.c2lnbmF0dXJlLWZvci1taW50aW5n";
  const answering = (status: number, body: unknown) =>
    vi.fn<FetchLike>(async () => Response.json(body, { status }));
  const now = () => NOW;

  it("asks each provider for a short-lived credential, with the key as that provider expects it", async () => {
    const fetch = answering(200, { token: "opaqueToken123", access_token: JWT, expires_in: 30 });
    expect(await mintCredential("assemblyai", KEY, { fetch, now })).toEqual({
      ok: true,
      status: 200,
      credential: "opaqueToken123",
      expiresAt: new Date(NOW.getTime() + 60_000),
      url: "wss://streaming.assemblyai.com",
    });
    expect(await mintCredential("deepgram", KEY, { fetch, now })).toEqual({
      ok: true,
      status: 200,
      credential: JWT,
      expiresAt: new Date(NOW.getTime() + 30_000),
      url: "wss://api.deepgram.com",
    });
    const [[aaiUrl, aaiInit], [dgUrl, dgInit]] = fetch.mock.calls as [
      [string, RequestInit],
      [string, RequestInit],
    ];
    expect(aaiUrl).toBe(MINT_REQUESTS.assemblyai.url);
    expect(aaiInit).toMatchObject({ method: "POST", headers: { authorization: KEY } });
    expect(JSON.parse(aaiInit.body as string)).toEqual({
      expires_in_seconds: 60,
      max_session_duration_seconds: 1800,
    });
    expect(dgUrl).toBe("https://api.deepgram.com/v1/auth/grant");
    expect(dgInit).toMatchObject({ method: "POST", headers: { authorization: `Token ${KEY}` } });
    expect(JSON.parse(dgInit.body as string)).toEqual({ ttl_seconds: 30 });
  });

  it("takes a shorter life the provider states, and ignores a longer or nonsensical one", async () => {
    const expiry = async (lifetime: unknown) => {
      const result = await mintCredential("deepgram", KEY, {
        fetch: answering(200, { access_token: JWT, expires_in: lifetime }),
        now,
      });
      return result.ok ? (result.expiresAt.getTime() - NOW.getTime()) / 1000 : undefined;
    };
    expect(await expiry(10)).toBe(10);
    expect(await expiry(3600)).toBe(30);
    expect(await expiry(-5)).toBe(30);
    expect(await expiry("20")).toBe(30);
  });

  it("maps failures to the key routes' fixed codes", async () => {
    const cases: Array<[FetchLike, string, number | undefined]> = [
      [answering(401, {}), "rejected", 401],
      [answering(403, {}), "rejected", 403],
      [answering(429, {}), "rate_limited", 429],
      [answering(500, {}), "upstream_error", 500],
      [answering(404, {}), "upstream_error", 404],
      [answering(200, []), "upstream_error", 200],
      [answering(200, { token: 42 }), "upstream_error", 200],
      [answering(200, { token: "" }), "upstream_error", 200],
      [answering(200, { token: "a b" }), "upstream_error", 200],
      [answering(200, { token: "t".repeat(4097) }), "upstream_error", 200],
      [answering(200, { token: `prefix${KEY.slice(4, 12)}suffix` }), "upstream_error", 200],
      [async () => new Response("not json", { status: 200 }), "upstream_error", 200],
      [async () => new Response("x".repeat(20_000), { status: 200 }), "upstream_error", 200],
      [
        async () => {
          throw new TypeError(`fetch failed for ${KEY}`);
        },
        "unreachable",
        undefined,
      ],
    ];
    for (const [fetch, code, status] of cases) {
      const result = await mintCredential("assemblyai", KEY, { fetch, now });
      expect(result, code).toEqual(
        status === undefined ? { ok: false, code } : { ok: false, status, code },
      );
    }
  });

  it("gives up after the timeout, as unreachable", async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    expect(await mintCredential("deepgram", KEY, { fetch: hanging, now, timeoutMs: 20 })).toEqual({
      ok: false,
      code: "unreachable",
    });
  });

  it("never reads an error answer's body, only releases it", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    await mintCredential("assemblyai", KEY, {
      fetch: async () => new Response(body, { status: 401 }),
      now,
    });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("requestLogger", () => {
  it("redacts this request's own secrets from messages and details, on top of the app's", () => {
    const base = memoryLogger(["app-wide-secret-value"]);
    const log = requestLogger(base);
    const key = "0123456789abcdef0123456789abcdef"; // no known shape, like an AssemblyAI key
    const ticket = "eyJ2IjoxLCJzaWQiOiIwMWExYzZlMiJ9.c2lnbmF0dXJlLWJ5dGVzLWhlcmUtdGhpcw";
    log.addSecret(key);
    log.addSecret(` ${ticket} `);
    log.addSecret("");
    log.addSecret(undefined);

    log.info(`key ${key}`, { ticket, nested: [{ key }], app: "app-wide-secret-value" });
    log.warn("ticket", { error: Object.assign(new Error(ticket), { code: "E_TICKET" }) });
    log.error("plain");

    expect(base.lines).toEqual([
      'info key [REDACTED] {"ticket":"[REDACTED]","nested":[{"key":"[REDACTED]"}],"app":"[REDACTED]"}',
      'warn ticket {"error":{"name":"Error","code":"E_TICKET"}}',
      "error plain",
    ]);
  });

  it("keeps each request's secrets to that request", () => {
    const base = memoryLogger();
    const first = requestLogger(base);
    const second = requestLogger(base);
    first.addSecret("first-request-secret");
    second.info("first-request-secret");
    expect(base.lines).toEqual(["info first-request-secret"]);
  });
});
