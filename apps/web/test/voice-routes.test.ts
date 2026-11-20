import {
  DEV_SESSION_TICKET_SECRET,
  type EntityRef,
  MAX_MESSAGE_BYTES,
  MAX_SESSION_ENTITIES,
  parseClientMessage,
  type SessionProviders,
  uuidv7,
  verifyTicket,
} from "@earshot/core";
import { loadDemoCrm, schema, type TenantContext, withTenant } from "@earshot/db";
import { contacts as demoContacts, deals as demoDeals } from "@earshot/demo-crm";
import { type FetchLike, PROVIDER_ID_HEADER, PROVIDER_KEY_HEADER } from "@earshot/keys/server";
import type { PGlite } from "@electric-sql/pglite";
import { eq, like } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { MagicLinkMessage } from "@/lib/auth/email";
import type { Auth } from "@/lib/auth/server";
import { loadViewer, type Viewer } from "@/lib/auth/viewer-core";
import type { AppDb } from "@/lib/db/types";
import { utf8Length } from "@/lib/voice/entities";
import { estimateKeytermTokens, KEYTERM_LIMITS } from "@/lib/voice/keyterms";
import {
  sessionTicketRoute,
  VOICE_LIMITS,
  type VoiceRouteDeps,
  voiceTokenRoute,
} from "@/lib/voice/routes";
import type { SessionKeyterms } from "@/lib/voice/types";
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
  expectNoTrace,
  responseText,
  spyOnConsole,
} from "./support/leaks";

// The routes run for real, behind the real withViewer and withViewerTenant, on PGlite: only the
// request scope (cookies, headers) and the per-request wiring (getAuth, getDb, and the voice
// routes' environment, logger, provider fetch, and clock) are the test's own.
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
vi.mock("@/lib/voice/deps", () => ({ voiceRouteDeps: async () => scope.deps }));

const sessionsRoute = await import("@/app/api/sessions/route");
const ticketRoute = await import("@/app/api/sessions/[id]/ticket/route");
const tokenRoute = await import("@/app/api/voice/token/route");
const { withViewerTenant } = await import("@/lib/auth/viewer");

const { crmEntities, rateLimit, sessions, workspaceMembers } = schema;

// Canaries. Neither key matches a provider-key pattern, as AssemblyAI's and Deepgram's don't, so
// only the code's own care keeps them out of sight. Nor does the AssemblyAI credential; the
// Deepgram one is a JWT, as Deepgram's grants are.
const AAI_KEY = "aaiQz7Xw2Lp9Rt4Mn8Bv6CxKs5HgJy3UdW";
const DG_KEY = "dgKp4Rn8Vt2Lx6Qz9Wm3Bc7Hs5Jf1Ny8TgEuAo4Zr";
const KEYS = [AAI_KEY, DG_KEY];
const AAI_CREDENTIAL = "aaiTmpTok7Hq2Wz9Lr4Xv8Nc3Bp6Kd1Ys5Gm";
const DG_CREDENTIAL =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZy1ncmFudC1jYW5hcnkifQ.Rk9yVGVzdHNPbmx5Q2FuYXJ5U2lnbmF0dXJlWDdR";
const CREDENTIALS = [AAI_CREDENTIAL, DG_CREDENTIAL];

/** Generated for these tests only. */
const TICKET_SECRET = "tkVx9Qm2Lr7Hw4Zp8Nc6Bt1Kd5Jy3Fg0Ua7Se2Wq";
const EDGE_ORIGIN = "https://earshot-edge.example.workers.dev";
const ORIGIN = "http://localhost:3000";
const START = Date.parse("2026-11-15T19:15:00.000Z");

const PROVIDERS = {
  speechToText: { provider: "assemblyai", model: "universal-streaming-english" },
  llm: { provider: "anthropic", model: "claude-haiku-5-5" },
} satisfies SessionProviders;
const SESSION_BODY = { mode: "debrief", engine: "cascaded", providers: PROVIDERS };

let template: PGlite;
let db: TestDb;
let auth: Auth;
let outbox: MagicLinkMessage[];
let log: ReturnType<typeof memoryLogger>;
let consoleSpies: Mock[];
let provider: Mock<FetchLike>;
let deps: VoiceRouteDeps;
let clock: number;
/** Every response a test received: as received, and with its ticket and credential fields blanked. */
let seen: { raw: string; scrubbed: string }[];
/** Every ticket and credential the routes answered with. */
let tickets: string[];
let credentials: string[];

beforeAll(async () => {
  template = await migratedTemplate();
});

beforeEach(async () => {
  db = await cloneDb(template);
  outbox = [];
  log = memoryLogger();
  auth = testAuth({ db, outbox, log });
  consoleSpies = spyOnConsole();
  provider = fakeProvider(200);
  seen = [];
  tickets = [];
  credentials = [];
  clock = START;
  deps = {
    db,
    withViewerTenant,
    env: { EARSHOT_SESSION_TICKET_SECRET: TICKET_SECRET, EDGE_PUBLIC_URL: EDGE_ORIGIN },
    log,
    fetch: (url, init) => provider(url, init),
    now: () => new Date(clock),
    mode: "production",
    rateLimit: true,
  };
  Object.assign(scope, { cookie: "", auth, db, deps });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.$client.close();
});

/**
 * A provider that answers `status`, mints the canary credential when it succeeds, and quotes the
 * key it was sent, and the credential, in its body and its headers, as careless providers do.
 */
function fakeProvider(status: number, answer?: unknown): Mock<FetchLike> {
  return vi.fn<FetchLike>(async (url, init) => {
    const sent = Object.values(init.headers as Record<string, string>).join(" ");
    const credential = url.includes("assemblyai") ? AAI_CREDENTIAL : DG_CREDENTIAL;
    const body = answer ?? {
      token: credential,
      access_token: credential,
      expires_in: 30,
      echo: sent,
      error: { message: `Invalid key: ${sent}`, credential },
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "x-request-key": sent,
        "x-credential": credential,
        "www-authenticate": `Bearer error="invalid_token", error_description="${sent}"`,
      },
    });
  });
}

/** Signs a user in for real and makes them the requests' viewer. */
async function signIn(email: string): Promise<Viewer> {
  const { cookie } = await signInByMagicLink(auth, outbox, email);
  scope.cookie = cookie;
  const viewer = await loadViewer({ auth, db, headers: withCookie(cookie) });
  if (!viewer) throw new Error("sign-in produced no viewer");
  return viewer;
}

const tenantOf = (viewer: Viewer): TenantContext => ({
  userId: viewer.user.id,
  workspaceId: viewer.workspaceId,
});

/** Loads the demo CRM into the viewer's workspace, every row updated at the same moment. */
async function loadDemo(viewer: Viewer): Promise<void> {
  await withTenant(db, tenantOf(viewer), (tx) => loadDemoCrm(tx));
  await db
    .update(crmEntities)
    .set({ updatedAt: new Date("2026-11-01T00:00:00.000Z") })
    .where(eq(crmEntities.workspaceId, viewer.workspaceId));
}

async function demoEntityId(externalId: string): Promise<string> {
  const [row] = await db
    .select({ id: crmEntities.id })
    .from(crmEntities)
    .where(eq(crmEntities.externalId, `demo:${externalId}`));
  if (!row) throw new Error(`no demo row ${externalId}`);
  return row.id;
}

type RequestOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  key?: string | null;
  provider?: string | null;
  url?: string;
};

function post(path: string, options: RequestOptions = {}): Request {
  const headers = new Headers({ "content-type": "application/json", ...options.headers });
  if (options.key) headers.set(PROVIDER_KEY_HEADER, options.key);
  if (options.provider) headers.set(PROVIDER_ID_HEADER, options.provider);
  return new Request(options.url ?? `${ORIGIN}${path}`, {
    method: "POST",
    headers,
    ...(options.body === undefined
      ? {}
      : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }),
  });
}

type Result = { status: number; body: Record<string, unknown>; response: Response };

/**
 * Records a response for the leak checks, with its `ticket` and `credential` fields blanked in
 * the scrubbed copy, so that what's left must hold no secret at all. Every response is no-store.
 */
async function record(pending: Promise<Response>): Promise<Result> {
  const response = await pending;
  const raw = await responseText(response);
  const body = (await response.clone().json()) as Record<string, unknown>;
  const blanked = { ...body };
  if (typeof body.ticket === "string") {
    tickets.push(body.ticket);
    blanked.ticket = "[ticket]";
  }
  if (typeof body.credential === "string") {
    credentials.push(body.credential);
    blanked.credential = "[credential]";
  }
  const headers = JSON.stringify([...response.headers]);
  seen.push({ raw, scrubbed: `${response.status}\n${headers}\n${JSON.stringify(blanked)}` });
  expect(response.headers.get("cache-control"), "every response is no-store").toBe("no-store");
  return { status: response.status, body, response };
}

const createSession = (options: RequestOptions = {}) =>
  record(sessionsRoute.POST(post("/api/sessions", { body: SESSION_BODY, ...options }), undefined));

const freshTicket = (id: string, options: RequestOptions = {}) =>
  record(
    ticketRoute.POST(post(`/api/sessions/${id}/ticket`, options), {
      params: Promise.resolve({ id }),
    }),
  );

const mint = (sessionId: string, options: RequestOptions = {}) =>
  record(
    tokenRoute.POST(
      post("/api/voice/token", {
        provider: "assemblyai",
        key: AAI_KEY,
        body: { sessionId },
        ...options,
      }),
      undefined,
    ),
  );

/** A session of the viewer's, created through the route. */
async function newSession(options: RequestOptions = {}): Promise<string> {
  const created = await createSession(options);
  expect(created.status).toBe(201);
  return created.body.sessionId as string;
}

/** The `start` frame a client would send with these entities. */
function startFrame(entities: unknown, providers: SessionProviders = PROVIDERS): string {
  return JSON.stringify({
    t: "start",
    msgId: uuidv7(),
    mode: "debrief",
    engine: "cascaded",
    providers,
    startedAt: new Date(START).toISOString(),
    entities,
  });
}

/** Everything observable outside the database: log lines and console calls. */
const logged = () => [...log.lines, consoleOutput(consoleSpies)].join("\n");

async function counters(prefix: string) {
  return db
    .select({ key: rateLimit.key, count: rateLimit.count })
    .from(rateLimit)
    .where(like(rateLimit.key, `${prefix}%`))
    .orderBy(rateLimit.key);
}

async function sessionRows() {
  return db.select().from(sessions).orderBy(sessions.startedAt);
}

describe("POST /api/sessions", () => {
  it("answers 401 to a signed-out request, and writes nothing", async () => {
    const result = await createSession();
    expect(result).toMatchObject({
      status: 401,
      body: { error: "unauthorized", message: "Sign in to continue." },
    });
    expect(await sessionRows()).toEqual([]);
    expect(await counters("session-create|")).toEqual([]);
  });

  it("writes the session in the viewer's workspace and answers 201 with a ticket the edge accepts", async () => {
    const viewer = await signIn("ana@acme.example");
    const result = await createSession();

    expect(result.status).toBe(201);
    expect(Object.keys(result.body).sort()).toEqual([
      "edgeUrl",
      "entities",
      "focusEntityId",
      "keyterms",
      "sessionId",
      "ticket",
      "ticketExpiresAt",
    ]);
    const sessionId = result.body.sessionId as string;
    expect(result.body.edgeUrl).toBe(
      `wss://earshot-edge.example.workers.dev/v1/sessions/${sessionId}/ws`,
    );
    // No CRM loaded yet, and no account open.
    expect(result.body.entities).toEqual([]);
    expect(result.body.focusEntityId).toBeNull();
    expect(result.body.keyterms).toEqual({ assemblyai: [], deepgram: [] });

    const [row] = await sessionRows();
    expect(row).toMatchObject({
      id: sessionId,
      workspaceId: viewer.workspaceId,
      userId: viewer.user.id,
      mode: "debrief",
      engine: "cascaded",
      providers: PROVIDERS,
      endedAt: null,
    });

    // The ticket verifies with core's verifyTicket and names this session, user, and workspace,
    // and how and when the viewer signed in (Phase 5): by magic link, at the sign-in session's
    // start, here after the test's clock, so claimed at the ticket's own time.
    const ticket = result.body.ticket as string;
    const verified = await verifyTicket(TICKET_SECRET, ticket, new Date(clock));
    expect(viewer.session.signInMethod).toBe("magic_link");
    expect(verified).toEqual({
      ok: true,
      claims: {
        v: 1,
        sid: sessionId,
        uid: viewer.user.id,
        wid: viewer.workspaceId,
        jti: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/),
        iat: START / 1000,
        exp: START / 1000 + 60,
        am: "magic_link",
        sat: Math.min(Math.floor(viewer.session.createdAt.getTime() / 1000), START / 1000),
      },
    });
    expect(result.body.ticketExpiresAt).toBe(new Date(START + 60_000).toISOString());
    expect(await verifyTicket(`${TICKET_SECRET}-other`, ticket, new Date(clock))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyTicket(TICKET_SECRET, ticket, new Date(START + 70_000))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(log.lines.join("\n")).toContain(
      'session created {"entities":0,"focus":false,"keyterms":{"assemblyai":0,"deepgram":0}}',
    );
  });

  it("hands back the demo CRM as entities that fit in `start`, and keyterms within each provider's limits", async () => {
    const viewer = await signIn("ana@acme.example");
    await loadDemo(viewer);
    const result = await createSession();

    const entities = result.body.entities as EntityRef[];
    // 60 companies, 150 contacts, and 40 deals: exactly the cap, in about 25 KB.
    expect(entities).toHaveLength(MAX_SESSION_ENTITIES);
    expect(new Set(entities.map((entity) => entity.id)).size).toBe(MAX_SESSION_ENTITIES);
    const frame = startFrame(entities);
    expect(parseClientMessage(frame).ok).toBe(true);
    expect(utf8Length(frame)).toBeLessThan(MAX_MESSAGE_BYTES);
    // Without a selected account, companies come first, and no account is open.
    expect(entities.slice(0, 60).every((entity) => entity.kind === "company")).toBe(true);
    expect(result.body.focusEntityId).toBeNull();

    // Each contact and deal names its company by the company's crm_entities id.
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    const danaLee = entities.find((entity) => entity.name === "Dana Lee");
    expect(danaLee?.parentId).toBe(await demoEntityId("co_011"));
    for (const entity of entities) {
      if (entity.kind === "company") expect(entity).not.toHaveProperty("parentId");
      else expect(byId.get(entity.parentId ?? "")?.kind, entity.name).toBe("company");
    }

    // Every company's name is a keyterm, the alphabetically last ones too (WP8): names before
    // aliases, where each company used to bring its aliases along and run out at "Summit Ridge".
    const keyterms = result.body.keyterms as SessionKeyterms;
    expectWithinLimits(keyterms);
    const companyNames = entities
      .filter((entity) => entity.kind === "company")
      .map((entity) => entity.name);
    expect(keyterms.assemblyai.slice(0, companyNames.length)).toEqual(companyNames);
    expect(keyterms.assemblyai).toContain("Willowbrook Pharma");
    expect(keyterms.assemblyai).toHaveLength(100);
  });

  it("ranks the selected account, its contacts, and its deals first, then the other companies", async () => {
    const viewer = await signIn("ana@acme.example");
    await loadDemo(viewer);
    const accountId = await demoEntityId("co_001");
    // The most recently updated company leads the rest.
    await db
      .update(crmEntities)
      .set({ updatedAt: new Date("2026-11-14T00:00:00.000Z") })
      .where(eq(crmEntities.externalId, "demo:co_042"));

    const result = await createSession({ body: { ...SESSION_BODY, selectedAccountId: accountId } });
    expect(result.status).toBe(201);

    const contactNames = demoContacts
      .filter((contact) => contact.companyId === "co_001")
      .map((contact) => `${contact.firstName} ${contact.lastName}`)
      .sort();
    const dealNames = demoDeals
      .filter((deal) => deal.companyId === "co_001")
      .map((deal) => deal.name)
      .sort();
    const entities = result.body.entities as EntityRef[];
    expect(entities[0]).toEqual({
      id: accountId,
      kind: "company",
      name: "Harborview Health",
      aliases: ["Harborview"],
    });
    // The selected account is the session's open account, and its family names it as parent.
    expect(result.body.focusEntityId).toBe(accountId);
    // The session's row keeps it too (migration 0014).
    const [created] = await sessionRows();
    expect(created?.focusEntityId).toBe(accountId);
    const related = entities.slice(1, 1 + contactNames.length + dealNames.length);
    expect(related.map((entity) => [entity.kind, entity.name])).toEqual([
      ...contactNames.map((name) => ["contact", name]),
      ...dealNames.map((name) => ["deal", name]),
    ]);
    expect(related.every((entity) => entity.parentId === accountId)).toBe(true);
    expect(entities[1 + related.length]).toMatchObject({
      kind: "company",
      name: "Redwood Robotics",
    });

    const keyterms = result.body.keyterms as SessionKeyterms;
    const expected = ["Harborview Health", "Harborview", ...contactNames, ...dealNames];
    expect(keyterms.assemblyai.slice(0, expected.length)).toEqual(expected);
    // Then every other company's name, the most recently updated first, before any alias.
    expect(keyterms.assemblyai.slice(expected.length, expected.length + 2)).toEqual([
      "Redwood Robotics",
      "Acme Dynamics",
    ]);
    expect(keyterms.deepgram.slice(0, expected.length)).toEqual(expected);
    expectWithinLimits(keyterms);
  });

  it("ignores a selected account that isn't a company in the workspace", async () => {
    const viewer = await signIn("ana@acme.example");
    await loadDemo(viewer);
    const plain = await createSession();
    for (const selectedAccountId of [uuidv7(), await demoEntityId("ct_001"), null]) {
      const result = await createSession({ body: { ...SESSION_BODY, selectedAccountId } });
      expect(result.status).toBe(201);
      expect(result.body.entities).toEqual(plain.body.entities);
      expect(result.body.keyterms).toEqual(plain.body.keyterms);
      expect(result.body.focusEntityId).toBeNull();
    }
  });

  it("budgets `start` by its size: long names fill 64 KiB well before 250 entities", async () => {
    const viewer = await signIn("ana@acme.example");
    const long = (n: number, tag: string) => `${tag} ${n} ${"x".repeat(180)}`;
    await withTenant(db, tenantOf(viewer), (tx) =>
      tx.insert(crmEntities).values(
        Array.from({ length: 300 }, (_, n) => ({
          workspaceId: viewer.workspaceId,
          kind: "company",
          externalId: `big-${n}`,
          name: long(n, "Company"),
          aliases: Array.from({ length: 20 }, (_, a) => long(a, `Alias ${n}`)),
        })),
      ),
    );

    const result = await createSession();
    const entities = result.body.entities as EntityRef[];
    expect(entities.length).toBeGreaterThan(0);
    expect(entities.length).toBeLessThan(MAX_SESSION_ENTITIES);
    for (const entity of entities) {
      expect(entity.name.length).toBeLessThanOrEqual(200);
      expect(entity.aliases.length).toBeLessThanOrEqual(20);
    }
    const frame = startFrame(entities);
    expect(utf8Length(frame)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    // One more entity wouldn't have fitted: the budget, not the count, stopped the list.
    expect(utf8Length(frame) + utf8Length(JSON.stringify(entities[0]))).toBeGreaterThan(
      MAX_MESSAGE_BYTES - 1024,
    );
    expect(parseClientMessage(frame)).toMatchObject({ ok: true });
    // The keyterms skip names past AssemblyAI's 50 characters, so these companies give it none.
    expect((result.body.keyterms as SessionKeyterms).assemblyai).toEqual([]);
  });

  it("leaves out CRM records the session socket would refuse", async () => {
    const viewer = await signIn("ana@acme.example");
    const keyShaped = `sk-proj-${"Q".repeat(40)}`;
    await withTenant(db, tenantOf(viewer), (tx) =>
      tx.insert(crmEntities).values([
        { workspaceId: viewer.workspaceId, kind: "company", externalId: "a", name: keyShaped },
        {
          workspaceId: viewer.workspaceId,
          kind: "company",
          externalId: "b",
          name: "Acme Corp",
          aliases: [keyShaped, "Acme", "ACME", " Acme Corp "],
        },
        {
          workspaceId: viewer.workspaceId,
          kind: "company",
          externalId: "c",
          name: "y".repeat(201),
        },
      ]),
    );
    const result = await createSession();
    expect(
      (result.body.entities as EntityRef[]).map(({ name, aliases }) => ({ name, aliases })),
    ).toEqual([{ name: "Acme Corp", aliases: ["Acme"] }]);
    expect(result.body.keyterms).toEqual({
      assemblyai: ["Acme Corp", "Acme"],
      deepgram: ["Acme Corp", "Acme"],
    });
    expect(parseClientMessage(startFrame(result.body.entities))).toMatchObject({ ok: true });
  });

  it("keeps each workspace's CRM to itself", async () => {
    const ana = await signIn("ana@acme.example");
    await loadDemo(ana);
    const bo = await signIn("bo@globex.example");
    const result = await createSession();
    expect(result.body.entities).toEqual([]);
    expect(result.body.keyterms).toEqual({ assemblyai: [], deepgram: [] });
    const rows = await sessionRows();
    expect(rows.map((row) => [row.workspaceId, row.userId])).toEqual([
      [bo.workspaceId, bo.user.id],
    ]);
  });

  it("refuses malformed bodies with 400, and stores nothing", async () => {
    await signIn("ana@acme.example");
    const withProviders = (providers: unknown) => ({ ...SESSION_BODY, providers });
    const bodies: unknown[] = [
      "not json",
      "[]",
      "null",
      {},
      { ...SESSION_BODY, mode: "conversation" },
      { ...SESSION_BODY, engine: "speech_to_speech" },
      { ...SESSION_BODY, extra: true },
      { ...SESSION_BODY, key: AAI_KEY },
      withProviders({ speechToText: PROVIDERS.speechToText }),
      withProviders({ ...PROVIDERS, speechToSpeech: PROVIDERS.llm }),
      withProviders({ ...PROVIDERS, llm: { provider: "anthropic" } }),
      withProviders({ ...PROVIDERS, llm: { provider: "Anthropic Inc", model: "claude" } }),
      withProviders({ ...PROVIDERS, llm: { provider: "anthropic", model: "a b" } }),
      withProviders({
        ...PROVIDERS,
        llm: { provider: "anthropic", model: `sk-ant-${"k".repeat(30)}` },
      }),
      // A key with no known shape, pasted into the wrong field, still looks like an opaque token.
      withProviders({ ...PROVIDERS, llm: { provider: "anthropic", model: DG_KEY } }),
      { ...SESSION_BODY, selectedAccountId: "not-a-uuid" },
      { ...SESSION_BODY, selectedAccountId: 7 },
      { ...SESSION_BODY, padding: "x".repeat(3000) },
    ];
    for (const body of bodies) {
      const result = await createSession({ body });
      expect(result, JSON.stringify(body).slice(0, 80)).toMatchObject({
        status: 400,
        body: { error: "invalid_request" },
      });
    }
    expect(await sessionRows()).toEqual([]);
    expectNoTrace(seen.map((s) => s.raw).join("\n"), KEYS, "a response");
  });

  it("refuses requests from other sites", async () => {
    await signIn("ana@acme.example");
    for (const site of ["cross-site", "same-site"]) {
      const result = await createSession({ headers: { "sec-fetch-site": site } });
      expect(result).toMatchObject({ status: 403, body: { error: "forbidden" } });
    }
    expect(await sessionRows()).toEqual([]);
    // Earshot's own pages, and clients that send no header, get through.
    expect((await createSession({ headers: { "sec-fetch-site": "same-origin" } })).status).toBe(
      201,
    );
    expect((await createSession()).status).toBe(201);
  });

  it("answers 429 past 20 new sessions in 10 minutes, with Retry-After", async () => {
    const viewer = await signIn("ana@acme.example");
    const { max, windowMs } = VOICE_LIMITS.sessionsPerUser;
    for (let i = 0; i < max; i++) expect((await createSession()).status).toBe(201);
    const limited = await createSession();

    expect(limited).toMatchObject({ status: 429, body: { error: "too_many_requests" } });
    expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.body.retryAfterSeconds).toBe(
      Number(limited.response.headers.get("retry-after")),
    );
    expect(await sessionRows()).toHaveLength(max);
    expect(log.lines.join("\n")).toContain(
      'session create refused: too many requests {"scope":"user"}',
    );
    expect(await counters("session-create|")).toEqual([
      { key: `session-create|user:${viewer.user.id}`, count: max + 1 },
    ]);

    clock += windowMs + 1000;
    expect((await createSession()).status).toBe(201);
  });

  it("fails closed outside development without a usable ticket secret or edge URL, and writes nothing", async () => {
    await signIn("ana@acme.example");
    const envs = [
      { env: { EDGE_PUBLIC_URL: EDGE_ORIGIN }, says: "EARSHOT_SESSION_TICKET_SECRET is not set" },
      {
        env: {
          EARSHOT_SESSION_TICKET_SECRET: ` ${DEV_SESSION_TICKET_SECRET}\n`,
          EDGE_PUBLIC_URL: EDGE_ORIGIN,
        },
        says: "EARSHOT_SESSION_TICKET_SECRET is the development-only value",
      },
      {
        env: { EARSHOT_SESSION_TICKET_SECRET: "short-secret", EDGE_PUBLIC_URL: EDGE_ORIGIN },
        says: "EARSHOT_SESSION_TICKET_SECRET must be at least 32 bytes",
      },
      { env: { EARSHOT_SESSION_TICKET_SECRET: TICKET_SECRET }, says: "EDGE_PUBLIC_URL is not set" },
      {
        env: {
          EARSHOT_SESSION_TICKET_SECRET: TICKET_SECRET,
          EDGE_PUBLIC_URL: "http://edge.example",
        },
        says: "EDGE_PUBLIC_URL must use https outside development",
      },
    ];
    for (const { env, says } of envs) {
      deps.env = env;
      const result = await createSession();
      expect(result).toMatchObject({ status: 500, body: { error: "server_error" } });
      expect(Object.keys(result.body).sort()).toEqual(["error", "message"]);
      expect(log.lines.join("\n")).toContain(`session routes unavailable: ${says}`);
    }
    expect(await sessionRows()).toEqual([]);
    expectNoTrace(logged(), [TICKET_SECRET], "the log or the console");
  });

  it("runs with no configuration under next dev, on the development-only secret and the local edge Worker", async () => {
    const viewer = await signIn("ana@acme.example");
    deps.mode = "development";
    deps.env = {};
    const result = await createSession();
    expect(result.status).toBe(201);
    const sessionId = result.body.sessionId as string;
    expect(result.body.edgeUrl).toBe(`ws://localhost:8787/v1/sessions/${sessionId}/ws`);
    const verified = await verifyTicket(
      DEV_SESSION_TICKET_SECRET,
      result.body.ticket as string,
      new Date(clock),
    );
    expect(verified).toMatchObject({ ok: true, claims: { sid: sessionId, uid: viewer.user.id } });

    deps.env = { EDGE_DEV_URL: "http://127.0.0.1:9787" };
    const elsewhere = await createSession();
    expect(elsewhere.body.edgeUrl).toBe(
      `ws://127.0.0.1:9787/v1/sessions/${elsewhere.body.sessionId}/ws`,
    );
  });

  it("answers 500 without detail when the database fails, and logs only the error's name and code", async () => {
    await signIn("ana@acme.example");
    const failure = Object.assign(new Error(`detail that must stay private ${AAI_KEY}`), {
      code: "XX000",
    });
    deps.withViewerTenant = async () => {
      throw failure;
    };
    const result = await createSession();
    expect(result).toMatchObject({ status: 500, body: { error: "server_error" } });
    expect(Object.keys(result.body).sort()).toEqual(["error", "message"]);
    deps.db = {
      insert: () => {
        throw failure;
      },
    } as unknown as AppDb;
    expect(await mint(uuidv7())).toMatchObject({ status: 500, body: { error: "server_error" } });
    expect(logged()).not.toContain("detail that must stay private");
    expectNoTrace(logged(), KEYS, "the log or the console");
    expect(log.lines.join("\n")).toContain(
      'session create failed {"error":{"name":"Error","code":"XX000"}}',
    );
    expect(log.lines.join("\n")).toContain(
      'voice token failed {"error":{"name":"Error","code":"XX000"}}',
    );
  });
});

describe("POST /api/sessions/:id/ticket", () => {
  it("answers 401 to a signed-out request", async () => {
    const result = await freshTicket(uuidv7());
    expect(result).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    expect(await counters("session-ticket|")).toEqual([]);
  });

  it("issues a fresh ticket for the viewer's open session, with its own jti", async () => {
    const viewer = await signIn("ana@acme.example");
    const created = await createSession();
    const sessionId = created.body.sessionId as string;
    clock += 30_000;

    const result = await freshTicket(sessionId);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      sessionId,
      ticket: expect.any(String),
      ticketExpiresAt: new Date(clock + 60_000).toISOString(),
      edgeUrl: `wss://earshot-edge.example.workers.dev/v1/sessions/${sessionId}/ws`,
    });
    const first = await verifyTicket(TICKET_SECRET, created.body.ticket as string, new Date(clock));
    const fresh = await verifyTicket(TICKET_SECRET, result.body.ticket as string, new Date(clock));
    expect(fresh).toMatchObject({
      ok: true,
      claims: { sid: sessionId, uid: viewer.user.id, wid: viewer.workspaceId, iat: clock / 1000 },
    });
    if (!first.ok || !fresh.ok) throw new Error("both tickets should verify");
    expect(fresh.claims.jti).not.toBe(first.claims.jti);

    // An upper-case id names the same session; the answer uses the canonical form.
    const upper = await freshTicket(sessionId.toUpperCase());
    expect(upper.body.sessionId).toBe(sessionId);
  });

  it("answers 404 for a session that is someone else's, or doesn't exist", async () => {
    await signIn("ana@acme.example");
    const anas = await newSession();

    const bo = await signIn("bo@globex.example");
    for (const id of [anas, uuidv7(), "not-a-uuid"]) {
      expect(await freshTicket(id)).toMatchObject({ status: 404, body: { error: "not_found" } });
    }

    // Another member of Ana's workspace can see the row, but it still isn't theirs.
    const [anaRow] = await sessionRows();
    if (!anaRow) throw new Error("no session");
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: anaRow.workspaceId, userId: bo.user.id, role: "owner" });
    const boInAnas = { ...bo, workspaceId: anaRow.workspaceId };
    const asMember = await record(
      sessionTicketRoute(boInAnas, post(`/api/sessions/${anas}/ticket`), anas, deps),
    );
    expect(asMember).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(tickets).toHaveLength(1); // only Ana's own, from creating the session
  });

  it("still answers once the session has ended, until it's sealed, then 409", async () => {
    const viewer = await signIn("ana@acme.example");
    const sessionId = await newSession();
    await db
      .update(sessions)
      .set({ endedAt: new Date(clock) })
      .where(eq(sessions.id, sessionId));
    // SessionDO takes the tray's reviews until it seals, so a dropped socket may come back.
    const ended = await freshTicket(sessionId);
    expect(ended.status).toBe(200);
    expect(
      await verifyTicket(TICKET_SECRET, ended.body.ticket as string, new Date(clock)),
    ).toMatchObject({
      ok: true,
      claims: { sid: sessionId, am: viewer.session.signInMethod },
    });
    await db
      .update(sessions)
      .set({ sealedAt: new Date(clock) })
      .where(eq(sessions.id, sessionId));
    expect(await freshTicket(sessionId)).toMatchObject({
      status: 409,
      body: { error: "session_ended" },
    });
  });

  it("refuses requests from other sites", async () => {
    await signIn("ana@acme.example");
    const sessionId = await newSession();
    const result = await freshTicket(sessionId, { headers: { "sec-fetch-site": "cross-site" } });
    expect(result).toMatchObject({ status: 403, body: { error: "forbidden" } });
  });

  it("answers 429 past 120 tickets in 10 minutes", async () => {
    const viewer = await signIn("ana@acme.example");
    const sessionId = await newSession();
    const { max, windowMs } = VOICE_LIMITS.ticketsPerUser;
    for (let i = 0; i < max; i++) expect((await freshTicket(sessionId)).status).toBe(200);
    const limited = await freshTicket(sessionId);
    expect(limited).toMatchObject({ status: 429, body: { error: "too_many_requests" } });
    expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await counters("session-ticket|")).toEqual([
      { key: `session-ticket|user:${viewer.user.id}`, count: max + 1 },
    ]);
    clock += windowMs + 1000;
    expect((await freshTicket(sessionId)).status).toBe(200);
  });

  it("fails closed without its configuration", async () => {
    await signIn("ana@acme.example");
    const sessionId = await newSession();
    deps.env = { EDGE_PUBLIC_URL: EDGE_ORIGIN };
    expect(await freshTicket(sessionId)).toMatchObject({
      status: 500,
      body: { error: "server_error" },
    });
  });
});

describe("POST /api/voice/token", () => {
  it("answers 401 to a signed-out request, without asking the provider", async () => {
    const result = await mint(uuidv7());
    expect(result).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    expect(provider).not.toHaveBeenCalled();
    expect(await counters("voice-token|")).toEqual([]);
  });

  it("mints an AssemblyAI token with the key from the header, and answers with the credential alone", async () => {
    await signIn("ana@acme.example");
    const sessionId = await newSession();

    const result = await mint(sessionId);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      provider: "assemblyai",
      credential: AAI_CREDENTIAL,
      expiresAt: new Date(START + 60_000).toISOString(),
      url: "wss://streaming.assemblyai.com",
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith("https://token.assemblyai.com/v1/token", {
      method: "POST",
      headers: {
        authorization: AAI_KEY,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        product: "streaming",
        expires_in_seconds: 60,
        max_session_duration_seconds: 1800,
      }),
      signal: expect.any(AbortSignal),
    });
    expect(log.lines.join("\n")).toContain(
      'voice token minted {"provider":"assemblyai","status":200}',
    );
    expectNoTrace(logged(), [AAI_CREDENTIAL, AAI_KEY], "the log or the console");
  });

  it("mints a Deepgram grant", async () => {
    await signIn("ana@acme.example");
    const sessionId = await newSession();

    const result = await mint(sessionId, { provider: "deepgram", key: DG_KEY });
    expect(result.body).toEqual({
      provider: "deepgram",
      credential: DG_CREDENTIAL,
      expiresAt: new Date(START + 30_000).toISOString(),
      url: "wss://api.deepgram.com",
    });
    expect(provider).toHaveBeenCalledWith("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: {
        authorization: `Token ${DG_KEY}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ ttl_seconds: 30 }),
      signal: expect.any(AbortSignal),
    });
  });

  it("answers the provider's failures with fixed codes, and nothing the provider sent", async () => {
    await signIn("ana@acme.example");
    const sessionId = await newSession();
    const cases: Array<[Mock<FetchLike>, number, string]> = [
      [fakeProvider(401), 422, "rejected"],
      [fakeProvider(403), 422, "rejected"],
      [fakeProvider(429), 503, "rate_limited"],
      [fakeProvider(500), 502, "upstream_error"],
      [fakeProvider(200, { error: "no token here" }), 502, "upstream_error"],
      [fakeProvider(200, { token: `${AAI_KEY}-as-a-token` }), 502, "upstream_error"],
      [fakeProvider(200, { token: "has spaces in it" }), 502, "upstream_error"],
      [
        vi.fn<FetchLike>(async () => {
          throw new DOMException(`timed out sending ${AAI_KEY}`, "TimeoutError");
        }),
        504,
        "unreachable",
      ],
    ];
    for (const [fake, status, error] of cases) {
      provider = fake;
      const result = await mint(sessionId);
      expect(result, error).toMatchObject({ status, body: { error } });
      expect(Object.keys(result.body).sort()).toEqual(["error", "message"]);
    }
    expect(log.lines.join("\n")).toContain(
      'voice token not minted {"provider":"assemblyai","reason":"rejected","status":401}',
    );
    expectNoTrace(seen.map((s) => s.raw).join("\n"), [...KEYS, ...CREDENTIALS], "a response");
    expectNoTrace(logged(), [...KEYS, ...CREDENTIALS], "the log or the console");
  });

  it("takes the key only from the header, and refuses a key in the body or the URL", async () => {
    await signIn("ana@acme.example");
    const sessionId = await newSession();
    const attempts: Array<[RequestOptions, string]> = [
      [{ key: null, body: { sessionId, key: AAI_KEY } }, "missing_key"],
      [{ key: null, url: `${ORIGIN}/api/voice/token?key=${AAI_KEY}` }, "missing_key"],
      [{ body: { sessionId, key: DG_KEY } }, "invalid_request"],
      [{ url: `${ORIGIN}/api/voice/token?sessionId=${sessionId}` }, "invalid_request"],
      [{ key: `${AAI_KEY} ${AAI_KEY}` }, "invalid_request"],
      [{ key: "k".repeat(513) }, "invalid_request"],
      [{ body: "not json" }, "invalid_request"],
      [{ body: { sessionId: "not-a-uuid" } }, "invalid_request"],
      [{ body: {} }, "invalid_request"],
      [{ provider: null }, "unknown_provider"],
      [{ provider: "openai" }, "unknown_provider"],
      [{ provider: "anthropic" }, "unknown_provider"],
    ];
    for (const [options, error] of attempts) {
      const result = await mint(sessionId, options);
      expect(result, JSON.stringify(options).slice(0, 80)).toMatchObject({
        status: 400,
        body: { error },
      });
    }
    expect(provider).not.toHaveBeenCalled();
    expect(await counters("voice-token|")).toEqual([]);
    expectNoTrace([...seen.map((s) => s.raw), logged()].join("\n"), KEYS, "a response or the log");
  });

  it("mints only for the viewer's own open session", async () => {
    await signIn("ana@acme.example");
    const anas = await newSession();
    const bo = await signIn("bo@globex.example");
    for (const sessionId of [anas, uuidv7()]) {
      expect(await mint(sessionId)).toMatchObject({ status: 404, body: { error: "not_found" } });
    }

    const [anaRow] = await sessionRows();
    if (!anaRow) throw new Error("no session");
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: anaRow.workspaceId, userId: bo.user.id, role: "owner" });
    const boInAnas = { ...bo, workspaceId: anaRow.workspaceId };
    const request = post("/api/voice/token", {
      provider: "assemblyai",
      key: AAI_KEY,
      body: { sessionId: anas },
    });
    expect(await record(voiceTokenRoute(boInAnas, request, deps))).toMatchObject({
      status: 404,
      body: { error: "not_found" },
    });

    const bos = await newSession();
    await db
      .update(sessions)
      .set({ endedAt: new Date(clock) })
      .where(eq(sessions.id, bos));
    expect(await mint(bos)).toMatchObject({ status: 409, body: { error: "session_ended" } });
    expect(provider).not.toHaveBeenCalled();
  });

  it("refuses requests from other sites", async () => {
    await signIn("ana@acme.example");
    const sessionId = await newSession();
    for (const site of ["cross-site", "same-site"]) {
      const result = await mint(sessionId, { headers: { "sec-fetch-site": site } });
      expect(result).toMatchObject({ status: 403, body: { error: "forbidden" } });
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it("answers 429 past 60 mints per user, on a counter apart from key checks", async () => {
    const viewer = await signIn("ana@acme.example");
    const sessionId = await newSession();
    const { max, windowMs } = VOICE_LIMITS.tokensPerUser;
    for (let i = 0; i < max; i++) expect((await mint(sessionId)).status).toBe(200);
    const limited = await mint(sessionId);

    expect(limited).toMatchObject({ status: 429, body: { error: "too_many_requests" } });
    expect(limited.body.retryAfterSeconds).toBe(
      Number(limited.response.headers.get("retry-after")),
    );
    expect(provider).toHaveBeenCalledTimes(max);
    expect(log.lines.join("\n")).toContain(
      'voice token refused: too many requests {"scope":"user"}',
    );
    expect(await counters("voice-token|")).toEqual([
      { key: `voice-token|user:${viewer.user.id}`, count: max + 1 },
    ]);
    expect(await counters("key-check|")).toEqual([]);

    clock += windowMs + 1000;
    expect((await mint(sessionId)).status).toBe(200);
  });

  it("answers 429 past 120 mints per IP, whoever is signed in", async () => {
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    const perUser = VOICE_LIMITS.tokensPerUser.max;
    const users = Math.ceil(VOICE_LIMITS.tokensPerIp.max / perUser);
    for (let u = 0; u < users; u++) {
      await signIn(`rep${u}@acme.example`);
      const sessionId = await newSession();
      for (let i = 0; i < perUser; i++) {
        expect((await mint(sessionId, { headers: ip })).status).toBe(200);
      }
    }
    await signIn("late@acme.example");
    const sessionId = await newSession();
    const limited = await mint(sessionId, { headers: ip });
    expect(limited).toMatchObject({ status: 429, body: { error: "too_many_requests" } });
    expect(log.lines.join("\n")).toContain('voice token refused: too many requests {"scope":"ip"}');

    // The same user from another address is fine.
    expect(
      (await mint(sessionId, { headers: { "cf-connecting-ip": "198.51.100.7" } })).status,
    ).toBe(200);
    // The counters key on user ids and addresses: no key, no email.
    const keys = (await counters("voice-token|")).map((counter) => counter.key);
    expect(keys).toEqual(
      expect.arrayContaining(["voice-token|ip:203.0.113.9", "voice-token|ip:198.51.100.7"]),
    );
    expect(JSON.stringify(keys)).not.toContain("acme.example");
    expectNoTrace(JSON.stringify(keys), KEYS, "the rate-limit counters");
  });
});

describe("the gate: keys, credentials, and tickets go only where they belong", () => {
  /** Sessions, tickets, and mints of every kind, against providers that quote every secret. */
  async function everything(): Promise<void> {
    const sessionId = await newSession();
    await freshTicket(sessionId);
    for (const status of [200, 401, 429, 503]) {
      provider = fakeProvider(status);
      await mint(sessionId);
      await mint(sessionId, { provider: "deepgram", key: DG_KEY });
    }
    provider = fakeProvider(200);
    await mint(sessionId, { key: null, body: { sessionId, key: AAI_KEY } });
    await mint(sessionId, { key: null, url: `${ORIGIN}/api/voice/token?key=${DG_KEY}` });
    await mint(sessionId, { body: { sessionId, key: DG_KEY } });
    await mint(sessionId, { provider: "openai", key: DG_KEY });
    await mint(uuidv7(), { provider: "deepgram", key: DG_KEY });
    await createSession({
      body: {
        ...SESSION_BODY,
        providers: { ...PROVIDERS, llm: { provider: "groq", model: AAI_KEY } },
      },
    });
    await createSession({ body: { ...SESSION_BODY, key: DG_KEY } });
    await freshTicket(sessionId);
    await mint(sessionId, { provider: "deepgram", key: DG_KEY });
    // Over for good: ended and sealed, so both routes refuse (an ended session that isn't sealed
    // still gets tickets, for the tray's reviews).
    await db
      .update(sessions)
      .set({ endedAt: new Date(clock), sealedAt: new Date(clock) })
      .where(eq(sessions.id, sessionId));
    await mint(sessionId);
    await freshTicket(sessionId);
  }

  it("no key reaches a response, a log line, a console call, or a table; credentials and tickets reach only their own fields", async () => {
    const viewer = await signIn("ana@acme.example");
    await loadDemo(viewer);
    deps.rateLimit = false;

    await everything();

    // What was issued, and where it went.
    expect(credentials.sort()).toEqual([AAI_CREDENTIAL, DG_CREDENTIAL, DG_CREDENTIAL].sort());
    expect(tickets).toHaveLength(3);
    const issued = [...CREDENTIALS, ...tickets];

    expectNoTrace(seen.map((s) => s.raw).join("\n"), KEYS, "a response");
    expectNoTrace(seen.map((s) => s.scrubbed).join("\n"), [...KEYS, ...issued], "a response");
    expectNoTrace(logged(), [...KEYS, ...issued], "the log or the console");
    expectNoTrace(await dumpEverything(db.$client), [...KEYS, ...issued], "the database");
  });

  it("holds with the rate limits on, too", async () => {
    await signIn("ana@acme.example");
    await everything();
    expectNoTrace(seen.map((s) => s.scrubbed).join("\n"), [...KEYS, ...CREDENTIALS, ...tickets]);
    expectNoTrace(logged(), [...KEYS, ...CREDENTIALS, ...tickets], "the log or the console");
    expectNoTrace(
      await dumpEverything(db.$client),
      [...KEYS, ...CREDENTIALS, ...tickets],
      "the database",
    );
  });
});

/** Keyterms within each provider's limits, and no term twice, ignoring case. */
function expectWithinLimits(keyterms: SessionKeyterms): void {
  const { assemblyai, deepgram } = KEYTERM_LIMITS;
  expect(keyterms.assemblyai.length).toBeGreaterThan(0);
  expect(keyterms.assemblyai.length).toBeLessThanOrEqual(assemblyai.maxTerms);
  for (const term of keyterms.assemblyai) {
    expect(term.length).toBeLessThanOrEqual(assemblyai.maxTermChars);
  }
  expect(keyterms.deepgram.length).toBeLessThanOrEqual(deepgram.maxTerms);
  const tokens = keyterms.deepgram.reduce((sum, term) => sum + estimateKeytermTokens(term), 0);
  expect(tokens).toBeLessThanOrEqual(deepgram.maxTokens);
  for (const list of [keyterms.assemblyai, keyterms.deepgram]) {
    expect(new Set(list.map((term) => term.toLowerCase())).size).toBe(list.length);
  }
}
