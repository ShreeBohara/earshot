import { revealCredential, schema, VaultOffError, VaultOpenError, withTenant } from "@earshot/db";
import {
  type FetchLike,
  generateMasterKey,
  loadVaultMasterKey,
  PROVIDER_KEY_HEADER,
} from "@earshot/keys/server";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq, like } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { MagicLinkMessage } from "@/lib/auth/email";
import type { Auth } from "@/lib/auth/server";
import { loadViewer, type Viewer } from "@/lib/auth/viewer-core";
import type { AppDb } from "@/lib/db/types";
import { MAX_KEY_LABEL_LENGTH } from "@/lib/keys/labels";
import { KEY_CHECK_LIMITS, type KeyRouteDeps } from "@/lib/keys/routes";
import {
  cloneDb,
  memoryLogger,
  migratedTemplate,
  signInByMagicLink,
  type TestDb,
  testAuth,
  withCookie,
} from "./support/harness";
import {
  consoleOutput,
  dumpEverything,
  echoingProvider,
  expectNoTrace,
  responseText,
  spyOnConsole,
} from "./support/leaks";

// The routes run for real, behind the real withViewer: only the request scope (cookies, headers)
// and the per-request wiring (getAuth, getDb, and the key routes' database, environment, logger,
// provider fetch, and clock) are swapped for the test's own.
const scope = vi.hoisted(() => ({
  cookie: "",
  auth: undefined as unknown,
  db: undefined as unknown,
  deps: undefined as unknown,
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    const pairs = new Map(
      scope.cookie
        .split("; ")
        .filter(Boolean)
        .map((pair) => pair.split("=") as [string, string]),
    );
    return { has: (name: string) => pairs.has(name) };
  },
  headers: async () => new Headers(scope.cookie ? { cookie: scope.cookie } : {}),
}));
vi.mock("@/lib/auth", () => ({ getAuth: async () => scope.auth }));
vi.mock("@/lib/db", () => ({ getDb: async () => scope.db }));
vi.mock("@/lib/keys/deps", () => ({ keyRouteDeps: async () => scope.deps }));

const validateRoute = await import("@/app/api/keys/validate/route");
const vaultRoute = await import("@/app/api/vault/credentials/route");

const { auditLog, credentials, rateLimit, session } = schema;

// Canaries. If any eight characters in a row of one surface anywhere a test can see, it leaked.
// The first is shaped like an OpenAI key, which the log redactor's patterns also catch. The
// second matches no pattern (Deepgram keys are 40 hex characters), so only the code's own care
// keeps it out of sight.
const KEY = "sk-proj-ROUTEScanaryQz7Xw2Lp9Rt4Mn8Bv6CxKs5Hg";
const PLAIN_KEY = "dgcafe5f3e9a7c1b4d8e2f6a0c3b5d7e9f1a2c4b6";
const SECOND_KEY = "sk-ant-api03-SECONDrouteCanaryHw3Jy1Uz7Io9Pq2";
const KEYS = [KEY, PLAIN_KEY, SECOND_KEY];

const ORIGIN = "http://localhost:3000";

let template: PGlite;
let db: TestDb;
let auth: Auth;
let outbox: MagicLinkMessage[];
let log: ReturnType<typeof memoryLogger>;
let consoleSpies: Mock[];
let provider: Mock<FetchLike>;
let masterKey: string;
let deps: KeyRouteDeps;
/** Every response a test received, as text, for the leak checks. */
let seen: string[];

beforeAll(async () => {
  template = await migratedTemplate();
  masterKey = generateMasterKey();
});

beforeEach(async () => {
  db = await cloneDb(template);
  outbox = [];
  log = memoryLogger();
  auth = testAuth({ db, outbox, log });
  consoleSpies = spyOnConsole();
  provider = echoingProvider(200);
  seen = [];
  deps = {
    db,
    env: {},
    log,
    fetch: (url, init) => provider(url, init),
    now: () => new Date(),
    rateLimit: true,
  };
  Object.assign(scope, { cookie: "", auth, db, deps });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.$client.close();
});

const vaultOn = () => {
  deps.env = { EARSHOT_VAULT_MASTER_KEY: masterKey };
};
const vaultOff = () => {
  deps.env = {};
};

/** Signs a user in for real and makes them the requests' viewer. */
async function signIn(email: string): Promise<Viewer> {
  const { cookie } = await signInByMagicLink(auth, outbox, email);
  scope.cookie = cookie;
  const viewer = await loadViewer({ auth, db, headers: withCookie(cookie) });
  if (!viewer) throw new Error("sign-in produced no viewer");
  return viewer;
}

type RequestOptions = {
  key?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  url?: string;
};

function request(method: string, path: string, options: RequestOptions = {}): Request {
  const headers = new Headers({ "content-type": "application/json", ...options.headers });
  if (options.key) headers.set(PROVIDER_KEY_HEADER, options.key);
  return new Request(options.url ?? `${ORIGIN}${path}`, {
    method,
    headers,
    ...(options.body === undefined
      ? {}
      : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }),
  });
}

/** Calls a route and records what came back. Every response must be no-store. */
async function call(
  handler: (request: Request, context: unknown) => Promise<Response>,
  req: Request,
): Promise<{ status: number; body: Record<string, unknown>; response: Response }> {
  const response = await handler(req, undefined);
  seen.push(await responseText(response));
  expect(response.headers.get("cache-control"), "every response is no-store").toBe("no-store");
  return { status: response.status, body: await response.json(), response };
}

const validate = (options: RequestOptions = {}) =>
  call(
    validateRoute.POST,
    request("POST", "/api/keys/validate", {
      key: KEY,
      body: { provider: "openai" },
      ...options,
    }),
  );
const list = (options: RequestOptions = {}) =>
  call(vaultRoute.GET, request("GET", "/api/vault/credentials", options));
const store = (options: RequestOptions = {}) =>
  call(
    vaultRoute.PUT,
    request("PUT", "/api/vault/credentials", {
      key: KEY,
      body: { provider: "openai", label: "work" },
      ...options,
    }),
  );
const remove = (options: RequestOptions = {}) =>
  call(
    vaultRoute.DELETE,
    request("DELETE", "/api/vault/credentials", {
      body: { provider: "openai", label: "work" },
      ...options,
    }),
  );

/** Everything observable outside the database: responses, log lines, console calls. */
const observed = () => [...seen, ...log.lines, consoleOutput(consoleSpies)].join("\n");

/** Fails if any fragment of any canary reached a response, the log, the console, or a table. */
async function expectKeysNowhere(secrets: readonly string[] = KEYS) {
  expectNoTrace(observed(), secrets, "a response, the log, or the console");
  expectNoTrace(await dumpEverything(db.$client), secrets, "the database");
}

async function credentialRows() {
  return db.select().from(credentials).orderBy(credentials.id);
}

async function keyCheckCounters() {
  return db
    .select({ key: rateLimit.key, count: rateLimit.count })
    .from(rateLimit)
    .where(like(rateLimit.key, "key-check|%"))
    .orderBy(rateLimit.key);
}

describe("POST /api/keys/validate", () => {
  it("answers 401 to a signed-out request, without asking the provider", async () => {
    const result = await validate();
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "unauthorized", message: "Sign in to continue." });
    expect(provider).not.toHaveBeenCalled();
    expect(await keyCheckCounters()).toEqual([]);
  });

  it("checks the key with its provider and answers with fixed codes and the last four characters", async () => {
    await signIn("ana@acme.example");

    expect((await validate()).body).toEqual({ ok: true, provider: "openai", last4: "s5Hg" });
    expect(provider).toHaveBeenCalledWith("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { authorization: `Bearer ${KEY}` },
      signal: expect.any(AbortSignal),
    });

    provider = echoingProvider(401);
    const rejected = await validate({ key: PLAIN_KEY, body: { provider: "deepgram" } });
    expect(rejected).toMatchObject({
      status: 200,
      body: { ok: false, provider: "deepgram", last4: "c4b6", reason: "rejected" },
    });

    // The provider quoted each key in its body and headers; none of it got out.
    await expectKeysNowhere();
  });

  it("writes nothing: no table holds the key afterwards, and credentials don't change", async () => {
    await signIn("ana@acme.example");
    const credentialsBefore = await credentialRows();
    expectNoTrace(await dumpEverything(db.$client), KEYS, "the database");

    for (const status of [200, 401, 429, 500]) {
      provider = echoingProvider(status);
      await validate();
      await validate({ key: PLAIN_KEY, body: { provider: "deepgram" } });
    }

    expect(await credentialRows()).toEqual(credentialsBefore);
    await expectKeysNowhere();
  });

  it("refuses a key in the body or the URL instead of the header", async () => {
    await signIn("ana@acme.example");
    const inBody = await validate({ key: null, body: { provider: "openai", key: KEY } });
    const inUrl = await validate({ key: null, url: `${ORIGIN}/api/keys/validate?key=${KEY}` });
    for (const result of [inBody, inUrl]) {
      expect(result).toMatchObject({
        status: 400,
        body: { ok: false, provider: "openai", reason: "missing_key" },
      });
    }
    expect(provider).not.toHaveBeenCalled();
    expectNoTrace([...seen, ...log.lines].join("\n"), KEYS, "a response or the log");
  });

  it("refuses requests from other sites", async () => {
    await signIn("ana@acme.example");
    for (const site of ["cross-site", "same-site"]) {
      const result = await validate({ headers: { "sec-fetch-site": site } });
      expect(result).toMatchObject({ status: 403, body: { error: "forbidden" } });
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it("answers 429 past the per-user limit, with Retry-After, and stops asking the provider", async () => {
    await signIn("ana@acme.example");
    const { max } = KEY_CHECK_LIMITS.perUser;

    for (let i = 0; i < max; i++) expect((await validate()).status).toBe(200);
    const limited = await validate();

    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: "too_many_requests" });
    expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.body.retryAfterSeconds).toBe(
      Number(limited.response.headers.get("retry-after")),
    );
    expect(provider).toHaveBeenCalledTimes(max);
    expect(log.lines.join("\n")).toContain('key check refused: too many requests {"scope":"user"}');

    // Once the window has passed, checks go through again.
    const later = Date.now() + KEY_CHECK_LIMITS.perUser.windowMs + 1000;
    deps.now = () => new Date(later);
    expect((await validate()).status).toBe(200);
  });

  it("answers 429 past the per-IP limit, whoever is signed in", async () => {
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    const perUser = KEY_CHECK_LIMITS.perUser.max;
    const users = Math.ceil(KEY_CHECK_LIMITS.perIp.max / perUser);

    for (let u = 0; u < users; u++) {
      await signIn(`rep${u}@acme.example`);
      for (let i = 0; i < perUser; i++) expect((await validate({ headers: ip })).status).toBe(200);
    }
    await signIn("late@acme.example");
    const limited = await validate({ headers: ip });
    expect(limited).toMatchObject({ status: 429, body: { error: "too_many_requests" } });
    expect(log.lines.join("\n")).toContain('key check refused: too many requests {"scope":"ip"}');

    // The same user from another address is fine.
    expect((await validate({ headers: { "cf-connecting-ip": "198.51.100.7" } })).status).toBe(200);

    // The counters key on the user id and the address: no key, no email.
    const counters = await keyCheckCounters();
    expect(counters.map((c) => c.key)).toEqual(
      expect.arrayContaining(["key-check|ip:203.0.113.9", "key-check|ip:198.51.100.7"]),
    );
    expect(JSON.stringify(counters)).not.toContain("acme.example");
  });
});

describe("the vault while it's off", () => {
  it("lists nothing and says so", async () => {
    await signIn("ana@acme.example");
    expect((await list()).body).toEqual({ vaultAvailable: false, credentials: [] });
  });

  it("refuses to store a key with 409 before any other work, and the database never sees it", async () => {
    await signIn("ana@acme.example");
    const result = await store();

    expect(result).toMatchObject({ status: 409, body: { error: "vault_off" } });
    expect(provider).not.toHaveBeenCalled();
    expect(await keyCheckCounters()).toEqual([]);
    expect(await credentialRows()).toEqual([]);
    await expectKeysNowhere();
  });

  it("still lists and removes keys stored while it was on", async () => {
    await signIn("ana@acme.example");
    vaultOn();
    expect((await store()).status).toBe(200);
    vaultOff();

    const listed = await list();
    expect(listed.body).toEqual({
      vaultAvailable: false,
      credentials: [
        {
          provider: "openai",
          label: "work",
          last4: "s5Hg",
          validatedAt: expect.any(String),
          createdAt: expect.any(String),
        },
      ],
    });

    expect((await remove()).body).toEqual({ ok: true, deleted: true });
    expect((await list()).body).toEqual({ vaultAvailable: false, credentials: [] });
    expect(await credentialRows()).toEqual([]);
  });
});

describe("the vault while it's on", () => {
  beforeEach(() => {
    vaultOn();
  });

  it("stores a validated key, lists only its last four characters, and never echoes it", async () => {
    const viewer = await signIn("ana@acme.example");
    const before = Date.now();

    const stored = await store();
    expect(stored.status).toBe(200);
    expect(stored.body).toEqual({
      ok: true,
      credential: {
        provider: "openai",
        label: "work",
        last4: "s5Hg",
        validatedAt: expect.any(String),
        createdAt: expect.any(String),
      },
    });
    const credential = stored.body.credential as { validatedAt: string };
    expect(Date.parse(credential.validatedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(provider).toHaveBeenCalledTimes(1);

    expect((await list()).body).toEqual({
      vaultAvailable: true,
      credentials: [stored.body.credential],
    });

    // Sealed: the plaintext is nowhere in the database, yet the vault opens it.
    await expectKeysNowhere();
    const master = await loadVaultMasterKey({ EARSHOT_VAULT_MASTER_KEY: masterKey });
    const revealed = await withTenant(
      db,
      { userId: viewer.user.id, workspaceId: viewer.workspaceId },
      (tx) => revealCredential(tx, master, { provider: "openai", label: "work" }),
    );
    expect(revealed).toBe(KEY);
    const [audit] = await db
      .select({ action: auditLog.action, detail: auditLog.detail })
      .from(auditLog)
      .where(like(auditLog.action, "credential.%"));
    expect(audit).toEqual({
      action: "credential.stored",
      detail: { provider: "openai", label: "work", last4: "s5Hg" },
    });
  });

  it("stores nothing when the provider rejects the key, and says why", async () => {
    await signIn("ana@acme.example");
    provider = echoingProvider(401);

    const result = await store({ key: PLAIN_KEY, body: { provider: "deepgram" } });

    expect(result).toEqual({
      status: 422,
      body: { ok: false, provider: "deepgram", last4: "c4b6", reason: "rejected" },
      response: expect.any(Response),
    });
    expect(await credentialRows()).toEqual([]);
    await expectKeysNowhere();
  });

  it("asks a session older than an hour to sign in again, and stores nothing", async () => {
    const viewer = await signIn("ana@acme.example");
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(session.id, viewer.session.id));

    const result = await store();

    expect(result).toMatchObject({ status: 403, body: { error: "reauth_required" } });
    expect(provider).not.toHaveBeenCalled();
    expect(await credentialRows()).toEqual([]);
    // Listing and removing don't need a fresh sign-in.
    expect((await list()).status).toBe(200);
    expect((await remove()).status).toBe(200);
  });

  it("keeps each workspace's keys to itself: B can't list or delete A's", async () => {
    await signIn("ana@acme.example");
    expect((await store()).status).toBe(200);

    await signIn("bo@globex.example");
    expect((await list()).body).toEqual({ vaultAvailable: true, credentials: [] });
    expect((await remove()).body).toEqual({ ok: true, deleted: false });

    const rows = await credentialRows();
    expect(rows).toHaveLength(1);
    await signIn("ana@acme.example");
    expect((await list()).body.credentials).toHaveLength(1);
  });

  it("removes a key, and records it", async () => {
    await signIn("ana@acme.example");
    await store();

    expect((await remove()).body).toEqual({ ok: true, deleted: true });
    expect((await remove()).body).toEqual({ ok: true, deleted: false });
    expect((await list()).body).toEqual({ vaultAvailable: true, credentials: [] });
    const actions = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(like(auditLog.action, "credential.%"));
    expect(actions.map((a) => a.action).sort()).toEqual([
      "credential.deleted",
      "credential.stored",
    ]);
  });

  it("takes the key only from the header, and refuses labels that hold a key", async () => {
    await signIn("ana@acme.example");
    const attempts = [
      { key: null, body: { provider: "openai", label: "work", key: KEY } },
      { key: null, url: `${ORIGIN}/api/vault/credentials?key=${KEY}` },
      { body: { provider: "openai", label: KEY } },
      { body: { provider: "openai", label: `mine ${KEY.slice(0, 30)}` } },
      { body: { provider: "openai", label: "sk-proj-abcdefghijklmnopqrstuvwxyz" } },
      { body: { provider: KEY } },
    ];
    const results = [];
    for (const attempt of attempts) results.push(await store(attempt));

    expect(results.map((r) => [r.status, r.body.error])).toEqual([
      [400, "missing_key"],
      [400, "missing_key"],
      [400, "invalid_label"],
      [400, "invalid_label"],
      [400, "invalid_label"],
      [400, "unknown_provider"],
    ]);
    expect(provider).not.toHaveBeenCalled();
    expect(await credentialRows()).toEqual([]);
    await expectKeysNowhere();
  });

  it("accepts labels up to the vault's limit, and no longer", async () => {
    await signIn("ana@acme.example");
    const longest = "x".repeat(MAX_KEY_LABEL_LENGTH);
    expect((await store({ body: { provider: "openai", label: longest } })).status).toBe(200);
    const tooLong = await store({ body: { provider: "openai", label: `${longest}x` } });
    expect(tooLong).toMatchObject({ status: 400, body: { error: "invalid_label" } });
    // Omitting the label uses the vault's default.
    const unlabeled = await store({ body: { provider: "openai" } });
    expect(unlabeled.body).toMatchObject({ ok: true, credential: { label: "default" } });
  });

  it("counts storing against the key-check limits, since it asks the provider too", async () => {
    await signIn("ana@acme.example");
    const { max } = KEY_CHECK_LIMITS.perUser;
    for (let i = 0; i < max - 1; i++) await validate();
    expect((await store()).status).toBe(200);
    expect((await store()).status).toBe(429);
    expect(provider).toHaveBeenCalledTimes(max);
  });
});

describe("errors, mapped", () => {
  it("fails closed with a malformed master key, without quoting it", async () => {
    await signIn("ana@acme.example");
    // Not base64 at all, and base64 of the wrong length.
    const malformed = ["%%QmFkS2V5%%notBase64%%7Hq2", btoa("twenty-one bytes long")];
    for (const value of malformed) {
      deps.env = { EARSHOT_VAULT_MASTER_KEY: value };
      for (const result of [await list(), await store()]) {
        expect(result).toMatchObject({
          status: 500,
          body: { error: "server_error", message: expect.any(String) },
        });
      }
    }
    expect(provider).not.toHaveBeenCalled();
    expect(await credentialRows()).toEqual([]);
    expect(log.lines.join("\n")).toContain(
      "vault unavailable: EARSHOT_VAULT_MASTER_KEY is set but isn't a usable master key",
    );
    expectNoTrace(observed(), malformed, "a response, the log, or the console");
  });

  it("maps vault errors: VaultOffError 409, TypeError 400, VaultOpenError and the rest 500 with no detail", async () => {
    await signIn("ana@acme.example");
    const detail = `detail that must stay private ${PLAIN_KEY}`;
    const cases: Array<[Error, number, string]> = [
      [new VaultOffError(), 409, "vault_off"],
      [new TypeError(detail), 400, "invalid_request"],
      [new VaultOpenError({ cause: new Error(detail) }), 500, "server_error"],
      [Object.assign(new Error(detail), { code: "XX000" }), 500, "server_error"],
    ];
    for (const [error, status, code] of cases) {
      deps.db = {
        transaction: async () => {
          throw error;
        },
      } as unknown as AppDb;
      const result = await remove();
      expect(result).toMatchObject({ status, body: { error: code } });
      expect(Object.keys(result.body).sort()).toEqual(["error", "message"]);
    }
    expect(observed()).not.toContain("detail that must stay private");
    expectNoTrace(observed(), [PLAIN_KEY], "a response, the log, or the console");
    // The log names each error by its class and code only.
    expect(log.lines.join("\n")).toContain(
      'vault remove failed {"error":{"name":"VaultOpenError"}}',
    );
    expect(log.lines.join("\n")).toContain('{"error":{"name":"Error","code":"XX000"}}');
  });

  it("refuses malformed bodies with 400", async () => {
    await signIn("ana@acme.example");
    for (const body of ["not json", "[]", "null", { label: "work" }, { provider: 7 }]) {
      const result = await remove({ body });
      expect(result).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    }
    const oversized = await remove({ body: { provider: "openai", label: "x".repeat(2000) } });
    expect(oversized).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  });
});

describe("the gate: no response or log ever contains a key, and the server stores one only when the vault is on", () => {
  /** Validation calls and vault operations, mixed, with a provider that quotes every key. */
  async function everything() {
    for (const status of [200, 401, 429, 503]) {
      provider = echoingProvider(status);
      await validate();
      await validate({ key: PLAIN_KEY, body: { provider: "deepgram" } });
      await validate({ key: null, body: { provider: "openai", key: KEY } });
    }
    provider = echoingProvider(200);
    await store();
    await store({ key: PLAIN_KEY, body: { provider: "deepgram", label: "transcripts" } });
    await store({ key: null, body: { provider: "openai", label: "work", key: KEY } });
    await store({ body: { provider: "openai", label: KEY } });
    await list();
    await store({ key: SECOND_KEY, body: { provider: "anthropic" } });
    await validate({ key: SECOND_KEY, body: { provider: "anthropic" } });
    await remove({ body: { provider: "deepgram", label: "transcripts" } });
    await list();
  }

  it("with the vault off, no key reaches the database, a response, the log, or the console", async () => {
    await signIn("ana@acme.example");
    deps.rateLimit = false;

    await everything();

    expect(await credentialRows()).toEqual([]);
    await expectKeysNowhere();
  });

  it("with the vault on, a stored key exists only as ciphertext", async () => {
    const viewer = await signIn("ana@acme.example");
    deps.rateLimit = false;
    vaultOn();

    await everything();

    await expectKeysNowhere();
    const rows = await credentialRows();
    expect(rows.map((row) => [row.provider, row.label, row.last4]).sort()).toEqual([
      ["anthropic", "default", SECOND_KEY.slice(-4)],
      ["openai", "work", KEY.slice(-4)],
    ]);
    const master = await loadVaultMasterKey({ EARSHOT_VAULT_MASTER_KEY: masterKey });
    const tenant = { userId: viewer.user.id, workspaceId: viewer.workspaceId };
    for (const [slot, secret] of [
      [{ provider: "openai", label: "work" }, KEY],
      [{ provider: "anthropic", label: "default" }, SECOND_KEY],
    ] as const) {
      expect(await withTenant(db, tenant, (tx) => revealCredential(tx, master, slot))).toBe(secret);
    }
    // The deleted slot left nothing behind.
    expect(
      await db
        .select()
        .from(credentials)
        .where(and(eq(credentials.provider, "deepgram"), eq(credentials.label, "transcripts"))),
    ).toEqual([]);
  });
});
