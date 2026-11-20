import { type ReviewInput, uuidv7 } from "@earshot/core";
import {
  appendEvents,
  rebuildProjections,
  schema,
  type TenantContext,
  withTenant,
} from "@earshot/db";
import { type EventDraft, NO_EVENTS } from "@earshot/events";
import {
  draft,
  ended,
  proposalV2,
  reviewV2,
  sealed,
  snoozed,
  started,
  usageRecorded,
  utterance,
} from "@earshot/events/testing";
import type { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MagicLinkMessage } from "@/lib/auth/email";
import type { Auth } from "@/lib/auth/server";
import { loadViewer, type Viewer } from "@/lib/auth/viewer-core";
import { repairUnsealedSessions, type SealSessions } from "@/lib/reviews/repair";
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

// The review route runs for real, behind the real withViewer and withViewerTenant, on PGlite with
// every migration: only the request scope and the route's wiring (environment, logger, clock) are
// the test's own. Sessions get their logs as SessionDO and the flush would have written them.
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
vi.mock("@/lib/reviews/deps", () => ({ reviewRouteDeps: () => scope.deps }));

const reviewsRoute = await import("@/app/api/sessions/[id]/reviews/route");
const { withViewerTenant } = await import("@/lib/auth/viewer");

const { auditCheckpoints, auditLog, proposals, sessionEvents, sessions } = schema;
const ORIGIN = "http://localhost:3000";
const START = Date.parse("2026-11-20T15:00:00.000Z");

let template: PGlite;
let db: TestDb;
let auth: Auth;
let outbox: MagicLinkMessage[];
let log: ReturnType<typeof memoryLogger>;
let deps: ReviewRouteDeps;
let clock: number;

beforeAll(async () => {
  template = await migratedTemplate();
});

beforeEach(async () => {
  db = await cloneDb(template);
  outbox = [];
  log = memoryLogger();
  auth = testAuth({ db, outbox, log });
  clock = START;
  deps = { withViewerTenant, env: {}, log, now: () => new Date(clock), mode: "development" };
  Object.assign(scope, { cookie: "", auth, db, deps });
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

/** A debrief with two proposals, ended, and sealed unless `seal` is false. */
function debrief(seal = true): EventDraft[] {
  return [
    draft(1, started()),
    draft(2, utterance(1)),
    draft(3, proposalV2(1)),
    draft(4, proposalV2(2, {}, { riskFlags: [] })),
    draft(5, usageRecorded(1)),
    draft(6, ended()),
    ...(seal ? [draft(7, sealed())] : []),
  ];
}

/** The same events with ids no other session's share (proposal and utterance ids are global). */
function distinct(events: EventDraft[], k: number): EventDraft[] {
  return JSON.parse(
    JSON.stringify(events).replaceAll("00000000-0000-7000-8000-", `0000000${k}-0000-7000-8000-`),
  );
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

/** A review as the inbox sends it: the v2 payload without `by` and `syncEligibleAt`. */
function review(n: number, overrides: Record<string, unknown> = {}): ReviewInput {
  const payload = reviewV2(n, "approved", {
    reviewId: uuidv7(),
    surface: "inbox",
    ...overrides,
  }).payload;
  const { by: _by, syncEligibleAt: _sync, ...input } = payload;
  return input as unknown as ReviewInput;
}

function snooze(n: number, until: string | null = "2026-11-21T09:00:00.000Z") {
  const { by: _by, ...input } = snoozed(n, until, { snoozeId: uuidv7() }).payload;
  return input;
}

function post(
  sessionId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const request = new Request(`${ORIGIN}/api/sessions/${sessionId}/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return reviewsRoute.POST(request, { params: Promise.resolve({ id: sessionId }) });
}

async function answer(pending: Promise<Response>) {
  const response = await pending;
  expect(response.headers.get("cache-control"), "every answer is no-store").toBe("no-store");
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function eventsOf(sessionId: string) {
  return db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(asc(sessionEvents.seq));
}

describe("POST /api/sessions/:id/reviews", () => {
  it("answers 401 to a signed-out request", async () => {
    expect(await answer(post(uuidv7(), { reviews: [review(1)] }))).toMatchObject({
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("refuses another site's request, and a session that isn't the viewer's", async () => {
    const ana = await signIn("ana@acme.example");
    const anas = await sessionWithLog(ana, debrief());
    expect(
      await answer(post(anas, { reviews: [review(1)] }, { "sec-fetch-site": "cross-site" })),
    ).toMatchObject({ status: 403, body: { error: "forbidden" } });

    await signIn("bo@globex.example");
    for (const id of [anas, uuidv7(), "not-a-uuid"]) {
      expect(await answer(post(id, { reviews: [review(1)] }))).toMatchObject({
        status: 404,
        body: { error: "not_found" },
      });
    }
    expect(await eventsOf(anas)).toHaveLength(7);
  });

  it("answers 409 not_sealed for an ended session that isn't sealed, and writes nothing", async () => {
    const viewer = await signIn("ana@acme.example");
    const sessionId = await sessionWithLog(viewer, debrief(false));
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.endedAt).not.toBeNull();
    expect(await answer(post(sessionId, { reviews: [review(1)] }))).toMatchObject({
      status: 409,
      body: { error: "not_sealed" },
    });
    expect(await eventsOf(sessionId)).toHaveLength(6);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("writes reviews and snoozes after the seal, with the viewer's sign-in, a sync time, and audit rows", async () => {
    const viewer = await signIn("ana@acme.example");
    const sessionId = await sessionWithLog(viewer, debrief());
    const approval = review(1);
    const later = snooze(2);
    const result = await answer(post(sessionId, { reviews: [approval], snoozes: [later] }));
    expect(result).toEqual({
      status: 200,
      body: {
        sessionId,
        reviews: [{ id: approval.reviewId, seq: 7, recorded: "now" }],
        snoozes: [{ id: later.snoozeId, seq: 8, recorded: "now" }],
        lastSeq: 8,
      },
    });

    const events = await eventsOf(sessionId);
    expect(events.at(-2)?.payload).toEqual({
      ...approval,
      syncEligibleAt: new Date(START + 30_000).toISOString(),
      by: {
        userId: viewer.user.id,
        auth: { method: "magic_link", signedInAt: viewer.session.createdAt.toISOString() },
      },
    });
    expect(events.at(-1)?.payload).toMatchObject({
      snoozeId: later.snoozeId,
      by: { userId: viewer.user.id },
    });
    const rows = await db.select().from(proposals).orderBy(asc(proposals.seq));
    expect(rows.map((row) => [row.status, row.reviewId, row.reviewMode])).toEqual([
      ["approved", approval.reviewId, "single"],
      ["proposed", null, null],
    ]);
    const audit = await db.select().from(auditLog);
    expect(audit).toMatchObject([
      {
        actorUserId: viewer.user.id,
        action: "proposal.approved",
        detail: { sessionId, reviewId: approval.reviewId, surface: "inbox", seq: 7 },
      },
    ]);
    expect((await db.select().from(auditCheckpoints)).map((row) => row.request)).toEqual([
      "review",
    ]);
  });

  it("is idempotent: a resend is answered with the first seqs, and adds no event or audit row", async () => {
    const viewer = await signIn("ana@acme.example");
    const sessionId = await sessionWithLog(viewer, debrief());
    const body = { reviews: [review(1)], snoozes: [snooze(2)] };
    await answer(post(sessionId, body));
    const again = await answer(post(sessionId, body));
    expect(again).toMatchObject({
      status: 200,
      body: {
        reviews: [{ seq: 7, recorded: "before" }],
        snoozes: [{ seq: 8, recorded: "before" }],
      },
    });
    expect(await eventsOf(sessionId)).toHaveLength(9);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it("answers 409 stale for a card decided since it loaded, naming the item", async () => {
    const viewer = await signIn("ana@acme.example");
    const sessionId = await sessionWithLog(viewer, debrief());
    await answer(post(sessionId, { reviews: [review(1)] }));
    expect(
      await answer(
        post(sessionId, {
          reviews: [review(2), review(1, { decision: "rejected", syncEligibleAt: null })],
        }),
      ),
    ).toMatchObject({ status: 409, body: { error: "stale", item: { kind: "review", index: 1 } } });
    expect(await eventsOf(sessionId)).toHaveLength(8);
  });

  it("answers 400 for a request it can't take, quoting none of it", async () => {
    const viewer = await signIn("ana@acme.example");
    const sessionId = await sessionWithLog(viewer, debrief());
    const canary = "sk-ant-api03-reviewcanary0123456789abcdefghijklmnop";
    const bad = [
      "{not json",
      {},
      { reviews: [] },
      { reviews: Array.from({ length: 26 }, () => review(1)) },
      {
        reviews: [
          review(1, { decision: "edited", editDiff: { title: { before: "a", after: canary } } }),
        ],
      },
      { reviews: [review(1)], extra: true },
      { reviews: [review(9)] }, // no such proposal
      { reviews: [review(1, { mode: "batch", batchId: uuidv7() })] }, // marked: not for accept all
    ];
    for (const body of bad) {
      const result = await answer(post(sessionId, body));
      expect(result.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(result.body.error).toBe("invalid_request");
    }
    expect(JSON.stringify(log.lines)).not.toContain(canary);
    expect(await eventsOf(sessionId)).toHaveLength(7);
  });

  it("lets accept-all take what tierOf leaves unmarked: a lone self-correction, not the name note", async () => {
    const viewer = await signIn("ana@acme.example");
    const sessionId = await sessionWithLog(viewer, [
      draft(1, started()),
      draft(2, utterance(1)),
      // Linked by sound below 0.97: the name note alone, a marker all the same.
      draft(3, proposalV2(1)),
      // A flag, but no marker: the model took the rep's correction (spec §4.4's "none").
      draft(
        4,
        proposalV2(
          2,
          { basis: "exact", p: 0.99 },
          { riskFlags: [{ kind: "self_correction", field: "title" }] },
        ),
      ),
      draft(5, ended()),
      draft(6, sealed()),
    ]);
    const batchId = uuidv7();
    expect(
      await answer(post(sessionId, { reviews: [review(1, { mode: "batch", batchId })] })),
    ).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(
      await answer(post(sessionId, { reviews: [review(2, { mode: "batch", batchId })] })),
    ).toMatchObject({ status: 200, body: { reviews: [{ seq: 6, recorded: "now" }] } });
  });

  it("answers 413 for a body over 64 KiB", async () => {
    const viewer = await signIn("ana@acme.example");
    const sessionId = await sessionWithLog(viewer, debrief());
    const result = await answer(
      post(sessionId, { reviews: [review(1)] }, { "content-length": String(70_000) }),
    );
    expect(result).toMatchObject({ status: 413, body: { error: "too_large" } });
  });

  it("fails closed without a signing key outside development: 503 for reviews, snoozes still taken", async () => {
    const viewer = await signIn("ana@acme.example");
    const sessionId = await sessionWithLog(viewer, debrief());
    deps.mode = "production";
    expect(await answer(post(sessionId, { reviews: [review(1)] }))).toMatchObject({
      status: 503,
      body: { error: "audit_unavailable" },
    });
    expect(await eventsOf(sessionId)).toHaveLength(7);
    expect(await answer(post(sessionId, { snoozes: [snooze(1)] }))).toMatchObject({
      status: 200,
      body: { snoozes: [{ seq: 7, recorded: "now" }] },
    });
  });
});

describe("the repair path", () => {
  const repairDeps = (sealSessions: SealSessions) => ({
    withViewerTenant,
    sealSessions,
    now: () => new Date(clock),
    log,
  });

  it("seals what SessionDO no longer holds, a log that never ended included, and leaves the rest", async () => {
    const viewer = await signIn("ana@acme.example");
    const gone = await sessionWithLog(viewer, debrief(false));
    const neverEnded = await sessionWithLog(viewer, distinct(debrief(false).slice(0, 5), 2));
    const live = await sessionWithLog(viewer, distinct(debrief(false), 3));
    const sealedAlready = await sessionWithLog(viewer, distinct(debrief(true), 4));
    const asked: string[][] = [];
    const report = await repairUnsealedSessions(
      viewer,
      repairDeps(async (ids) => {
        asked.push(ids);
        return {
          ok: true,
          sessions: Object.fromEntries(ids.map((id) => [id, id === live ? "live" : "gone"])),
        };
      }),
    );
    expect(asked.flat().sort()).toEqual([gone, neverEnded, live].sort());
    expect(asked.flat()).not.toContain(sealedAlready);
    expect(report).toMatchObject({
      asked: 3,
      answers: { live: 1, gone: 2, sealing: 0, sealed: 0 },
      repaired: 2,
      unreachable: false,
    });
    expect((await eventsOf(gone)).at(-1)?.payload).toEqual({
      sealedAt: new Date(START).toISOString(),
      by: "web",
    });
    expect((await eventsOf(neverEnded)).slice(-2).map((event) => event.type)).toEqual([
      "session.ended",
      "session.sealed",
    ]);
    expect((await eventsOf(live)).at(-1)?.type).toBe("session.ended");
    // Sealed now, so the review route takes them.
    expect(await answer(post(gone, { reviews: [review(1)] }))).toMatchObject({ status: 200 });
  });

  it("asks about nothing recent, and skips the load when the edge Worker can't be reached", async () => {
    const viewer = await signIn("ana@acme.example");
    const sessionId = await sessionWithLog(viewer, debrief(false));
    // The debrief ended on 2026-11-10: ten minutes later, nothing is due yet.
    clock = Date.parse("2026-11-10T19:20:00.000Z");
    const none = await repairUnsealedSessions(
      viewer,
      repairDeps(async () => {
        throw new Error("should not be asked");
      }),
    );
    expect(none.asked).toBe(0);

    clock = START;
    const unreachable = await repairUnsealedSessions(
      viewer,
      repairDeps(async () => {
        throw new Error("the EDGE service binding is missing");
      }),
    );
    expect(unreachable).toMatchObject({ asked: 1, unreachable: true, repaired: 0 });
    expect((await eventsOf(sessionId)).at(-1)?.type).toBe("session.ended");
  });
});
