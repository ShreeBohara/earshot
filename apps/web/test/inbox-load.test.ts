// The inbox's loader and GET /api/inbox (Phase 5 spec WP5 steps 1, 2, and 10), for real on
// PGlite with every migration, behind the real withViewer and withViewerTenant: the sample
// debriefs as Settings → Data loads them, other sessions as SessionDO and the flush write them.
import { uuidv7 } from "@earshot/core";
import {
  appendEvents,
  importSessionLog,
  loadDemoCrm,
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
  readFixture,
  reviewV2,
  sealed,
  snoozed,
  started,
  utterance,
} from "@earshot/events/testing";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MagicLinkMessage } from "@/lib/auth/email";
import type { Auth } from "@/lib/auth/server";
import { loadViewer, type Viewer } from "@/lib/auth/viewer-core";
import { cardOrder, inboxSections } from "@/lib/inbox/groups";
import { INBOX_PAGE_SIZE, loadInbox } from "@/lib/inbox/load";
import { parseOlderCursor } from "@/lib/inbox/pages";
import type { InboxData } from "@/lib/inbox/types";
import type { SealRepairDeps, SealSessions } from "@/lib/reviews/repair";
import {
  cloneDb,
  memoryLogger,
  migratedTemplate,
  signInByMagicLink,
  type TestDb,
  testAuth,
  withCookie,
} from "./support/harness";

const scope = vi.hoisted(() => ({
  cookie: "",
  auth: undefined as unknown,
  db: undefined as unknown,
  repair: undefined as unknown,
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
vi.mock("@/lib/auth", () => ({ getAuth: async () => scope.auth, log: memoryLogger() }));
vi.mock("@/lib/db", () => ({ getDb: async () => scope.db }));
vi.mock("@/lib/reviews/deps", () => ({ sealRepairDeps: () => scope.repair }));

const inboxRoute = await import("@/app/api/inbox/route");
const { withViewerTenant } = await import("@/lib/auth/viewer");
const { countForReview, readReviewCount } = await import("@/lib/inbox/count");

const { crmEntities, sessions } = schema;
const ORIGIN = "http://localhost:3000";
const NOW = new Date("2026-11-20T15:00:00.000Z");

let template: PGlite;
let db: TestDb;
let auth: Auth;
let outbox: MagicLinkMessage[];
let sealSessions: ReturnType<typeof vi.fn<SealSessions>>;

beforeAll(async () => {
  template = await migratedTemplate();
});

beforeEach(async () => {
  db = await cloneDb(template);
  outbox = [];
  auth = testAuth({ db, outbox, log: memoryLogger() });
  sealSessions = vi.fn<SealSessions>(async (ids) => ({
    ok: true,
    sessions: Object.fromEntries(ids.map((id) => [id, "gone" as const])),
  }));
  const repair: SealRepairDeps = {
    withViewerTenant,
    sealSessions,
    now: () => NOW,
    log: memoryLogger(),
  };
  Object.assign(scope, { cookie: "", auth, db, repair });
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

function load(viewer: Viewer, options: { before?: string | null; limit?: number } = {}) {
  return withTenant(db, tenantOf(viewer), (tx) =>
    loadInbox(
      tx,
      { userId: viewer.user.id, workspaceId: viewer.workspaceId },
      { now: NOW, ...options },
    ),
  );
}

/** One of `viewer`'s sessions, with `events` stored and projected, as the flush would. */
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

/**
 * A debrief with one proposal, started at `startedAt`, ended, and sealed unless `seal` is false,
 * then `after`; with ids no other debrief's share (proposal and utterance ids are global).
 */
function debrief(
  k: number,
  startedAt: string,
  options: { seal?: boolean; after?: EventDraft[] } = {},
): EventDraft[] {
  const events = [
    draft(1, started({ startedAt })),
    draft(2, utterance(1)),
    draft(3, proposalV2(1, {}, { riskFlags: [] })),
    draft(4, ended()),
    ...(options.seal === false ? [] : [draft(5, sealed())]),
    ...(options.after ?? []),
  ];
  return JSON.parse(
    JSON.stringify(events).replaceAll("00000000-0000-7000-8000-", `0000000${k}-0000-7000-8000-`),
  );
}

describe("the inbox's loader", () => {
  it("reads the sample debriefs newest first, with their words, records, accounts, and values", async () => {
    const viewer = await signIn("dana@earshot.example");
    await withTenant(db, tenantOf(viewer), async (tx) => {
      await loadDemoCrm(tx);
      await importSessionLog(tx, readFixture("samples/acme-dynamics.jsonl"), {
        mapDemoIds: true,
        now: NOW,
      });
      await importSessionLog(tx, readFixture("samples/pier-logistics.jsonl"), {
        mapDemoIds: true,
        now: NOW,
      });
    });
    const data = await load(viewer);
    expect(data.older).toBeNull();
    expect(data.loadedAt).toBe(NOW.toISOString());
    expect(data.sessions.map((session) => session.proposals.length)).toEqual([3, 4]);
    const [pier, acme] = data.sessions;
    expect(pier?.startedAt).toBe("2026-11-17T10:30:00.000Z");
    expect(pier?.sealedAt).toBe(NOW.toISOString());
    expect(acme?.proposals.map((proposal) => proposal.type)).toEqual([
      "contact",
      "deal_update",
      "task",
      "note",
    ]);

    // Every record a card names, by the workspace's own ids, with its account.
    const byName = (name: string) => Object.values(data.entities).find((e) => e.name === name);
    const pierCo = byName("Pier Logistics");
    const acmeCo = byName("Acme Dynamics");
    expect(pierCo).toMatchObject({ kind: "company", accountId: pierCo?.id });
    expect(byName("Dana Lee")).toMatchObject({
      kind: "contact",
      accountId: acmeCo?.id,
      values: { title: "General Manager", email: expect.any(String), phone: expect.any(String) },
    });
    // A question's candidates are named too, with their companies (Dana Li is at Akme Dynamics).
    expect(byName("Dana Li")?.accountId).toBe(byName("Akme Dynamics")?.id);
    expect(byName("Pier Logistics - Expansion")).toMatchObject({
      kind: "deal",
      accountId: pierCo?.id,
      values: { amount: 112_000, stage: "decisionmakerboughtin", closeDate: "2027-03-22" },
    });
    // The words each card quotes.
    const [, amount] = pier?.proposals ?? [];
    const field = amount?.fields.amount;
    expect(field && data.quotes[field.evidence.utteranceId]).toBe(
      "The expansion is worth one hundred twelve thousand, and they're ready to sign.",
    );

    // Each debrief's recap (Phase 5 WP10), with the words its sentences quote loaded.
    expect(acme?.recap).toMatchObject({ outcome: "created", dropped: 1, lens: { id: "meddic" } });
    expect(pier?.recap?.sentences.map((sentence) => sentence.kind)).toEqual([
      "headline",
      "next_step",
    ]);
    const headline = pier?.recap?.sentences[0]?.evidence[0];
    expect(headline && data.quotes[headline.utteranceId]).toBe(
      "The expansion is worth one hundred twelve thousand, and they're ready to sign.",
    );

    // Grouped: each debrief headed by its account, the question among Pier's cards.
    const sections = inboxSections(data.sessions, data.entities, NOW.getTime());
    expect(sections.review.map((group) => group.recap?.outcome)).toEqual(["created", "created"]);
    expect(sections.review.map((group) => group.accountId)).toEqual([pierCo?.id, acmeCo?.id]);
    expect(sections.review.every((group) => !group.byAccount)).toBe(true);
    expect(cardOrder(sections.review).map((group) => group.length)).toEqual([3, 4]);
    expect(sections.openCount).toBe(7);
  });

  it("pages older debriefs, and leaves out other members', empty ones, and unsealed ones' reviews", async () => {
    const viewer = await signIn("dana@earshot.example");
    const first = await sessionWithLog(viewer, debrief(1, "2026-11-18T10:00:00.000Z"));
    const second = await sessionWithLog(viewer, debrief(2, "2026-11-19T10:00:00.000Z"));
    const third = await sessionWithLog(viewer, debrief(3, "2026-11-20T10:00:00.000Z"));
    const empty = await sessionWithLog(viewer, [draft(1, started())]);
    const page1 = await load(viewer, { limit: 2 });
    expect(page1.sessions.map((session) => session.sessionId)).toEqual([third, second]);
    expect(page1.older).not.toBeNull();
    expect(parseOlderCursor(page1.older)).toEqual({
      startedAt: new Date("2026-11-19T10:00:00.000Z"),
      sessionId: second,
    });
    const page2 = await load(viewer, { limit: 2, before: page1.older });
    expect(page2.sessions.map((session) => session.sessionId)).toEqual([first]);
    expect(page2.older).toBeNull();
    expect(page1.sessions.concat(page2.sessions).map((s) => s.sessionId)).not.toContain(empty);
    expect(INBOX_PAGE_SIZE).toBe(20);
    // A cursor that isn't one reads the first page.
    expect(parseOlderCursor("not-a-cursor")).toBeNull();
    expect((await load(viewer, { before: "x_y" })).sessions).toHaveLength(3);

    // Another member's debrief, in the same workspace, isn't the viewer's to review.
    const other = await signIn("sam@earshot.example");
    await sessionWithLog(other, debrief(4, "2026-11-20T11:00:00.000Z"));
    expect((await load(viewer)).sessions).toHaveLength(3);
  });

  it("holds each proposal's latest review: its id, decision, record, and undo window", async () => {
    const viewer = await signIn("dana@earshot.example");
    const reviewId = uuidv7();
    const events = debrief(1, "2026-11-20T10:00:00.000Z", {
      after: [
        draft(6, reviewV2(1, "approved", { reviewId, syncEligibleAt: "2026-11-20T10:05:30.000Z" })),
      ],
    });
    const sessionId = await sessionWithLog(viewer, events);
    const [session] = (await load(viewer)).sessions;
    expect(session?.sessionId).toBe(sessionId);
    const [proposal] = session?.proposals ?? [];
    expect(proposal?.status).toBe("approved");
    expect(proposal?.review).toMatchObject({
      reviewId,
      decision: "approved",
      mode: "single",
      syncEligibleAt: "2026-11-20T10:05:30.000Z",
    });
    expect(proposal?.riskFlags).toEqual([]);
    const sections = inboxSections([session as InboxData["sessions"][number]], {}, NOW.getTime());
    expect(sections.reviewed).toHaveLength(1);
    expect(sections.review).toHaveLength(0);
  });
});

describe("GET /api/inbox", () => {
  function get(query = "", headers: Record<string, string> = {}): Promise<Response> {
    return inboxRoute.GET(new Request(`${ORIGIN}/api/inbox${query}`, { headers }), undefined);
  }

  it("answers 401 signed out, and 403 to another site", async () => {
    const signedOut = await get();
    expect(signedOut.status).toBe(401);
    await signIn("dana@earshot.example");
    const crossSite = await get("", { "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("cache-control")).toBe("no-store");
  });

  it("seals a debrief whose seal never came first, then reads it as reviewable", async () => {
    const viewer = await signIn("dana@earshot.example");
    // Ended long before NOW, never sealed, and its Durable Object holds nothing: the repair path.
    const stuck = await sessionWithLog(
      viewer,
      debrief(1, "2026-11-19T10:00:00.000Z", { seal: false }),
    );
    await db
      .update(sessions)
      .set({ endedAt: new Date("2026-11-19T10:02:00.000Z") })
      .where(eq(sessions.id, stuck));
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = (await response.json()) as InboxData;
    expect(sealSessions).toHaveBeenCalledWith([stuck]);
    expect(data.sessions[0]?.sessionId).toBe(stuck);
    expect(data.sessions[0]?.sealedAt).not.toBeNull();
    // "Load older" skips the repair path.
    sealSessions.mockClear();
    const older = await get(`?before=${encodeURIComponent(`2026-11-21T00:00:00.000Z_${stuck}`)}`);
    expect(older.status).toBe(200);
    expect(sealSessions).not.toHaveBeenCalled();
  });

  it("still reads the inbox when the edge Worker can't be asked", async () => {
    const viewer = await signIn("dana@earshot.example");
    await sessionWithLog(viewer, debrief(1, "2026-11-19T10:00:00.000Z", { seal: false }));
    sealSessions.mockRejectedValue(new Error("the EDGE service binding is missing"));
    const response = await get();
    expect(response.status).toBe(200);
    const data = (await response.json()) as InboxData;
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]?.sealedAt).toBeNull();
    expect(await db.select().from(crmEntities)).toHaveLength(0);
  });
});

describe("the inbox's count (Phase 5 WP6)", () => {
  it("counts what the inbox shows for review, in one query: the viewer's sealed debriefs' open cards", async () => {
    const viewer = await signIn("dana@earshot.example");
    const sealedOpen = await sessionWithLog(viewer, debrief(1, "2026-11-19T10:00:00.000Z"));
    // Decided, finishing, snoozed ahead: none of them waits for review.
    await sessionWithLog(
      viewer,
      debrief(2, "2026-11-19T11:00:00.000Z", { after: [draft(6, reviewV2(1, "approved"))] }),
    );
    await sessionWithLog(viewer, debrief(3, "2026-11-19T12:00:00.000Z", { seal: false }));
    await sessionWithLog(
      viewer,
      debrief(4, "2026-11-19T13:00:00.000Z", {
        after: [draft(6, snoozed(1, "2099-01-01T09:00:00.000Z"))],
      }),
    );
    // A snooze that has woken is back for review.
    const woken = await sessionWithLog(
      viewer,
      debrief(5, "2026-11-19T14:00:00.000Z", {
        after: [draft(6, snoozed(1, "2020-01-01T09:00:00.000Z"))],
      }),
    );
    const count = await withTenant(db, tenantOf(viewer), (tx) =>
      countForReview(tx, { userId: viewer.user.id, workspaceId: viewer.workspaceId }, NOW),
    );
    expect(count).toBe(2);

    // The same cards the inbox would show for review.
    const data = await load(viewer);
    const sections = inboxSections(data.sessions, data.entities, NOW.getTime());
    expect(sections.openCount).toBe(count);
    expect(sections.review.map((group) => group.sessionId).sort()).toEqual(
      [sealedOpen, woken].sort(),
    );

    // Another member's debriefs aren't the viewer's to review, nor counted.
    const other = await signIn("sam@earshot.example");
    await sessionWithLog(other, debrief(6, "2026-11-20T11:00:00.000Z"));
    expect(await readReviewCount(viewer)).toBe(2);
    expect(await readReviewCount(other)).toBe(1);
  });

  it("is null, not an error, when it can't be read", async () => {
    const viewer = await signIn("dana@earshot.example");
    await db.$client.close();
    expect(await readReviewCount(viewer)).toBeNull();
    // A fresh database for afterEach to close.
    db = await cloneDb(template);
  });
});
