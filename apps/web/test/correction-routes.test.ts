import { readFileSync } from "node:fs";
import { type ReviewInput, uuidv7 } from "@earshot/core";
import {
  appendEvents,
  importSessionLog,
  loadDemoCrm,
  rebuildProjections,
  schema,
  type TenantContext,
  withTenant,
} from "@earshot/db";
import { CORRECTION_LIMITS, type EventDraft, NO_EVENTS } from "@earshot/events";
import {
  draft,
  ended,
  followupAsked,
  proposalV2,
  readFixture,
  reviewV2,
  sealed,
  started,
  utterance,
  utteranceV3,
} from "@earshot/events/testing";
import type { PGlite } from "@electric-sql/pglite";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MagicLinkMessage } from "@/lib/auth/email";
import type { Auth } from "@/lib/auth/server";
import { loadViewer, type Viewer } from "@/lib/auth/viewer-core";
import {
  CORRECTION_REQUEST_LIMIT,
  type CorrectionRouteDeps,
  hasUnstorableText,
} from "@/lib/reviews/corrections";
import type { ReviewRouteDeps } from "@/lib/reviews/routes";
import {
  cloneDb,
  memoryLogger,
  migratedTemplate,
  signInByMagicLink,
  type TestDb,
  testAuth,
  withCookie,
} from "./support/harness";

// The correction route (Phase 5 WP13) runs for real, behind the real withViewer and
// withViewerTenant, on PGlite with every migration, beside the real review route, which must refuse
// a proposal a correction replaced. Only the request scope and the routes' wiring are the test's.
const scope = vi.hoisted(() => ({
  cookie: "",
  auth: undefined as unknown,
  db: undefined as unknown,
  deps: undefined as unknown,
  reviewDeps: undefined as unknown,
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
vi.mock("@/lib/reviews/deps", () => ({
  correctionRouteDeps: () => scope.deps,
  reviewRouteDeps: () => scope.reviewDeps,
}));

const correctionsRoute = await import("@/app/api/sessions/[id]/corrections/route");
const reviewsRoute = await import("@/app/api/sessions/[id]/reviews/route");
const { withViewerTenant } = await import("@/lib/auth/viewer");

const { crmEntities, proposals, sessionEvents, sessions, utterances } = schema;
const ORIGIN = "http://localhost:3000";
const NOW = new Date("2026-11-20T15:00:00.000Z");
const FAKE_GROQ_KEY = `gsk_${"Z".repeat(40)}`;

let template: PGlite;
let db: TestDb;
let auth: Auth;
let outbox: MagicLinkMessage[];
let log: ReturnType<typeof memoryLogger>;

beforeAll(async () => {
  template = await migratedTemplate();
});

beforeEach(async () => {
  db = await cloneDb(template);
  outbox = [];
  log = memoryLogger();
  auth = testAuth({ db, outbox, log });
  const deps: CorrectionRouteDeps = {
    db,
    withViewerTenant,
    log,
    now: () => NOW,
    rateLimit: false,
  };
  const reviewDeps: ReviewRouteDeps = {
    withViewerTenant,
    env: {},
    log,
    now: () => NOW,
    mode: "development",
  };
  Object.assign(scope, { cookie: "", auth, db, deps, reviewDeps });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.$client.close();
});

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

/** A debrief with a task and a question about its due date, ended, sealed unless `seal` is false. */
function debrief(seal = true): EventDraft[] {
  return [
    draft(1, started()),
    draft(2, utterance(1, "Send the deck.")),
    draft(3, proposalV2(1)),
    draft(4, followupAsked(1, 1)),
    draft(5, ended()),
    ...(seal ? [draft(6, sealed())] : []),
  ];
}

/** One of `viewer`'s sessions, with `events` stored and projected as the flush would. */
async function sessionWithLog(viewer: Viewer, events: EventDraft[]): Promise<string> {
  const sessionId = uuidv7();
  await db.insert(sessions).values({
    id: sessionId,
    workspaceId: viewer.workspaceId,
    userId: viewer.user.id,
    mode: "debrief",
    engine: "cascaded",
  });
  await withTenant(db, tenantOf(viewer), async (tx) => {
    if (events.length > 0) await appendEvents(tx, sessionId, NO_EVENTS, events);
    await rebuildProjections(tx, sessionId);
  });
  return sessionId;
}

/** The demo CRM and the Acme Dynamics sample debrief (sealed by its import), as Settings → Data loads them. */
async function withAcmeSample(viewer: Viewer): Promise<string> {
  await withTenant(db, tenantOf(viewer), async (tx) => {
    await loadDemoCrm(tx);
    await importSessionLog(tx, readFixture("samples/acme-dynamics.jsonl"), {
      mapDemoIds: true,
      now: NOW,
    });
  });
  const [row] = await db.select({ id: sessions.id }).from(sessions);
  if (!row) throw new Error("no sample session");
  return row.id;
}

const post = (sessionId: string, body: unknown, headers: Record<string, string> = {}) =>
  correctionsRoute.POST(
    new Request(`${ORIGIN}/api/sessions/${sessionId}/corrections`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: sessionId }) },
  );

async function answer(pending: Promise<Response>) {
  const response = await pending;
  expect(response.headers.get("cache-control"), "every answer is no-store").toBe("no-store");
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A typed correction of proposal `uuid(3001)`'s due date, as the inbox sends it. */
function typed(text: string, overrides: Record<string, unknown> = {}) {
  return {
    t: "correct",
    correctionId: uuidv7(),
    proposalId: "00000000-0000-7000-8000-000000000bb9",
    field: "dueDate",
    said: { input: "typed", text },
    timeZone: "America/Chicago",
    ...overrides,
  };
}

async function eventsOf(sessionId: string) {
  return db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(asc(sessionEvents.seq));
}

describe("POST /api/sessions/:id/corrections", () => {
  it("answers 401 to a signed-out request", async () => {
    expect(await answer(post(uuidv7(), typed("Friday")))).toMatchObject({
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("refuses another site's request, another member's or workspace's session, and junk", async () => {
    const owner = await signIn("owner@example.com");
    const sessionId = await sessionWithLog(owner, debrief());
    expect(
      await answer(post(sessionId, typed("Friday"), { "sec-fetch-site": "cross-site" })),
    ).toMatchObject({ status: 403, body: { error: "forbidden" } });
    await signIn("someone-else@example.com");
    expect(await answer(post(sessionId, typed("Friday")))).toMatchObject({ status: 404 });
    expect(await answer(post("not-a-session", typed("Friday")))).toMatchObject({ status: 404 });
    expect(await eventsOf(sessionId)).toHaveLength(6);
  });

  it("answers 409 not_sealed until the seal reaches Postgres, writing nothing", async () => {
    const viewer = await signIn("rep@example.com");
    const sessionId = await sessionWithLog(viewer, debrief(false));
    expect(await answer(post(sessionId, typed("Friday")))).toMatchObject({
      status: 409,
      body: { error: "not_sealed" },
    });
    expect(await eventsOf(sessionId)).toHaveLength(5);
    void viewer;
  });

  it("writes typed words and the superseding proposal, answering the question it names", async () => {
    const viewer = await signIn("rep@example.com");
    const sessionId = await sessionWithLog(viewer, debrief());
    const body = typed("Make it Friday", {
      questionId: "00000000-0000-7000-8000-000000002329",
    });
    const written = await answer(post(sessionId, body));
    expect(written).toMatchObject({
      status: 200,
      body: { sessionId, outcome: "corrected", recorded: "now", lastSeq: 8 },
    });
    const proposalId = written.body.proposalId as string;
    const events = await eventsOf(sessionId);
    expect(events.slice(6).map((event) => [event.type, event.schemaVersion])).toEqual([
      ["utterance.final", 3],
      ["proposal.created", 2],
      ["followup.closed", 1],
    ]);
    // The call started 2026-11-10 in the builders' clock, a Tuesday in Chicago: Friday the 13th.
    expect(events[7]?.payload).toMatchObject({
      proposalId,
      supersedes: "00000000-0000-7000-8000-000000000bb9",
      fields: { dueDate: { value: "2026-11-13" } },
    });
    const rows = await withTenant(db, tenantOf(viewer), (tx) =>
      tx
        .select()
        .from(proposals)
        .where(eq(proposals.sessionId, sessionId))
        .orderBy(asc(proposals.seq)),
    );
    expect(rows.map((row) => [row.status, row.supersededBy])).toEqual([
      ["superseded", proposalId],
      ["proposed", null],
    ]);
    const [typedRow] = await withTenant(db, tenantOf(viewer), (tx) =>
      tx.select().from(utterances).where(eq(utterances.input, "typed")),
    );
    expect(typedRow).toMatchObject({ text: "Make it Friday", confidence: 1, words: null });
    // The log says what happened, and never the words.
    expect(JSON.stringify(log.lines)).not.toContain("Make it Friday");

    // A resend is answered with the first one's proposal, and writes nothing.
    expect(await answer(post(sessionId, body))).toMatchObject({
      status: 200,
      body: { proposalId, recorded: "before" },
    });
    expect(await eventsOf(sessionId)).toHaveLength(9);
  });

  it("leaves a superseded proposal refusing reviews in the review route, and more corrections", async () => {
    const viewer = await signIn("rep@example.com");
    const sessionId = await sessionWithLog(viewer, debrief());
    await answer(post(sessionId, typed("Friday")));
    const input = reviewV2(1, "approved", { reviewId: uuidv7(), surface: "inbox" }).payload;
    const { by: _by, syncEligibleAt: _sync, ...review } = input;
    const refused = await answer(
      reviewsRoute.POST(
        new Request(`${ORIGIN}/api/sessions/${sessionId}/reviews`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reviews: [review as unknown as ReviewInput] }),
        }),
        { params: Promise.resolve({ id: sessionId }) },
      ),
    );
    expect(refused).toMatchObject({ status: 409, body: { error: "stale" } });
    expect(await answer(post(sessionId, typed("Monday")))).toMatchObject({
      status: 409,
      body: { error: "stale" },
    });
  });

  it("answers 422 unreadable for words with no date, and writes nothing", async () => {
    const viewer = await signIn("rep@example.com");
    const sessionId = await sessionWithLog(viewer, debrief());
    const refused = await answer(post(sessionId, typed("whenever suits them")));
    expect(refused).toMatchObject({ status: 422, body: { error: "unreadable" } });
    // Nothing from the request comes back.
    expect(JSON.stringify(refused.body)).not.toContain("whenever");
    expect(await eventsOf(sessionId)).toHaveLength(6);
  });

  it("re-links a record over the workspace's mirror, from the session's focus account", async () => {
    const viewer = await signIn("rep@example.com");
    const sessionId = await withAcmeSample(viewer);
    const rows = await withTenant(db, tenantOf(viewer), (tx) =>
      tx.select().from(proposals).where(eq(proposals.sessionId, sessionId)),
    );
    const note = rows.find((row) => row.type === "note");
    const [pier] = await withTenant(db, tenantOf(viewer), (tx) =>
      tx
        .select({ id: crmEntities.id })
        .from(crmEntities)
        .where(and(eq(crmEntities.kind, "company"), eq(crmEntities.name, "Pier Logistics"))),
    );
    if (!note || !pier)
      throw new Error("the sample has no note, or the demo CRM no Pier Logistics");
    const written = await answer(
      post(sessionId, {
        t: "correct",
        correctionId: uuidv7(),
        proposalId: note.id,
        field: "target",
        said: { input: "typed", text: "No, it's Pier Logistics." },
      }),
    );
    expect(written.status).toBe(200);
    const [created] = await withTenant(db, tenantOf(viewer), (tx) =>
      tx
        .select()
        .from(proposals)
        .where(eq(proposals.id, written.body.proposalId as string)),
    );
    expect(created).toMatchObject({
      targetEntityId: pier.id,
      supersedes: note.id,
      target: { decision: "linked", entityId: pier.id, mention: { quote: "Pier Logistics" } },
    });
  });

  it("writes a dictation's words as speech, at the session's last audio time", async () => {
    const viewer = await signIn("rep@example.com");
    const sessionId = await sessionWithLog(viewer, debrief());
    const body = {
      ...typed(""),
      said: {
        input: "speech",
        utterances: [
          {
            text: "Friday.",
            confidence: 0.94,
            startMs: 200,
            endMs: 900,
            words: [{ w: "Friday.", startMs: 250, endMs: 850, confidence: 0.94 }],
          },
        ],
      },
    };
    expect((await answer(post(sessionId, body))).status).toBe(200);
    const events = await eventsOf(sessionId);
    // The session's last utterance ended at 1.8 s: the dictation is placed there.
    expect(events[6]?.payload).toMatchObject({
      input: "speech",
      startMs: 2000,
      endMs: 2700,
      words: [{ w: "Friday.", startMs: 2050, endMs: 2650 }],
    });
  });

  it("skips a question, answers a second skip, and refuses an answer to it afterwards", async () => {
    const viewer = await signIn("rep@example.com");
    const sessionId = await sessionWithLog(viewer, debrief());
    const skip = { t: "skip", questionId: "00000000-0000-7000-8000-000000002329" };
    expect(await answer(post(sessionId, skip))).toMatchObject({
      status: 200,
      body: { outcome: "skipped", proposalId: null, recorded: "now", lastSeq: 6 },
    });
    expect(await answer(post(sessionId, skip))).toMatchObject({
      status: 200,
      body: { recorded: "before" },
    });
    expect(
      await answer(post(sessionId, typed("Friday", { questionId: skip.questionId }))),
    ).toMatchObject({ status: 409, body: { error: "stale" } });
    void viewer;
  });

  it("refuses words shaped like a key, text jsonb can't store, and a body over 64 KiB", async () => {
    const viewer = await signIn("rep@example.com");
    const sessionId = await sessionWithLog(viewer, debrief());
    expect(await answer(post(sessionId, typed(`it's ${FAKE_GROQ_KEY}`)))).toMatchObject({
      status: 400,
      body: { error: "invalid_request" },
    });
    expect(await answer(post(sessionId, typed("Fri\u0000day")))).toMatchObject({ status: 400 });
    expect(await answer(post(sessionId, typed("   ")))).toMatchObject({ status: 400 });
    const big = JSON.stringify(typed("x".repeat(70_000)));
    expect(
      await answer(post(sessionId, big, { "content-length": String(big.length) })),
    ).toMatchObject({ status: 413 });
    expect(await eventsOf(sessionId)).toHaveLength(6);
    void viewer;
  });
});

describe("the correction limits (a security review's)", () => {
  it("counts each viewer's requests for a session in Postgres, and answers 429 past the window's limit", async () => {
    const viewer = await signIn("rep@example.com");
    const sessionId = await sessionWithLog(viewer, debrief());
    (scope.deps as CorrectionRouteDeps).rateLimit = true;
    for (let n = 0; n < CORRECTION_REQUEST_LIMIT.max; n += 1) {
      expect((await answer(post(sessionId, typed("whenever suits them")))).status).toBe(422);
    }
    const limited = await correctionsRoute.POST(
      new Request(`${ORIGIN}/api/sessions/${sessionId}/corrections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(typed("Friday")),
      }),
      { params: Promise.resolve({ id: sessionId }) },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await limited.json()).toMatchObject({ error: "too_many" });
    expect(await eventsOf(sessionId)).toHaveLength(6);
  });

  it("answers 429 too_many for a card corrected as many times as it can be, writing nothing", async () => {
    const viewer = await signIn("rep@example.com");
    const sessionId = await sessionWithLog(viewer, debrief());
    let proposalId = "00000000-0000-7000-8000-000000000bb9";
    for (let n = 0; n < CORRECTION_LIMITS.maxDepth; n += 1) {
      const written = await answer(
        post(sessionId, typed(`Send the deck v${n}`, { proposalId, field: "title" })),
      );
      expect(written.status).toBe(200);
      proposalId = written.body.proposalId as string;
    }
    const count = (await eventsOf(sessionId)).length;
    expect(
      await answer(post(sessionId, typed("Send the deck v5", { proposalId, field: "title" }))),
    ).toMatchObject({ status: 429, body: { error: "too_many" } });
    expect(await eventsOf(sessionId)).toHaveLength(count);
  });

  it("answers 429 too_many for typed words past the session's budget", async () => {
    const viewer = await signIn("rep@example.com");
    // Five typed corrections' words already in the log: 19,995 of the 20,000 characters.
    const typedWords = [10, 11, 12, 13, 14].map((n) =>
      draft(n, utteranceV3(n, "x".repeat(3_999), "typed")),
    );
    const events = [...debrief().slice(0, 5), ...typedWords, draft(6, sealed())];
    const sessionId = await sessionWithLog(viewer, events);
    expect(await answer(post(sessionId, typed("Friday")))).toMatchObject({
      status: 429,
      body: { error: "too_many" },
    });
    expect(await answer(post(sessionId, typed("Fri")))).toMatchObject({ status: 200 });
  });
});

describe("hasUnstorableText", () => {
  it("finds U+0000 and half of a surrogate pair, and passes a whole pair", () => {
    expect(hasUnstorableText("Friday")).toBe(false);
    expect(hasUnstorableText("Fri\u0000day")).toBe(true);
    expect(hasUnstorableText("\ud83d")).toBe(true);
    expect(hasUnstorableText("\ude00x")).toBe(true);
    expect(hasUnstorableText("ok 😀")).toBe(false);
  });
});

void readFileSync;
