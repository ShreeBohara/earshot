// The mirror's history in the inbox (Phase 5 spec WP12), for real on PGlite with every migration,
// behind the real withViewer and withViewerTenant: the loader's base and current for an update's
// fields and its re-link offers, the 3-way card and the re-link card they make, "accept all" and the
// writers' rule leaving both out, the demo controls' server actions, and the review route's check
// of a record offered at review time.
import { uuidv7 } from "@earshot/core";
import {
  addDemoRecord,
  appendEvents,
  importSessionLog,
  loadDemoCrm,
  moveDemoField,
  rebuildProjections,
  schema,
  type TenantContext,
  withTenant,
} from "@earshot/db";
import { checkReview, type EventDraft, NO_EVENTS, type ProposalView } from "@earshot/events";
import {
  draft,
  ended,
  proposalV2,
  readFixture,
  sealed,
  started,
  utterance,
} from "@earshot/events/testing";
import { tierOf } from "@earshot/understanding/tiers";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MagicLinkMessage } from "@/lib/auth/email";
import type { Auth } from "@/lib/auth/server";
import { loadViewer, type Viewer } from "@/lib/auth/viewer-core";
import { batchPlan, batchReviews } from "@/lib/inbox/batch";
import { cardModel } from "@/lib/inbox/card";
import { keepCrmDiff, threeWayFields } from "@/lib/inbox/crm";
import { canAddMatching, simulatedField } from "@/lib/inbox/demo";
import { loadInbox } from "@/lib/inbox/load";
import { decisionReview } from "@/lib/inbox/review";
import { agoWords } from "@/lib/inbox/time";
import type { InboxData, InboxProposal } from "@/lib/inbox/types";
import { relinkLine, threeWayLine } from "@/lib/inbox/voice";
import type { SealRepairDeps, SealSessions } from "@/lib/reviews/repair";
import type { ReviewRouteDeps } from "@/lib/reviews/routes";
import { CRM_CHANGED, ENTITIES, QUOTES, UPDATE } from "../components/inbox/fixtures";
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
  reviews: undefined as unknown,
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
vi.mock("@/lib/reviews/deps", () => ({
  sealRepairDeps: () => scope.repair,
  reviewRouteDeps: () => scope.reviews,
}));

const { withViewerTenant } = await import("@/lib/auth/viewer");
const { addMatchingRecordAction, simulateCrmChangeAction } = await import(
  "@/app/actions/inbox-demo"
);
const reviewsRoute = await import("@/app/api/sessions/[id]/reviews/route");

const { crmEntities, crmEntityChanges, proposals, sessions } = schema;
const ORIGIN = "http://localhost:3000";
const NOW = new Date("2026-11-20T15:00:00.000Z");
/** When the demo control moved the CRM's value: two hours before the inbox loads. */
const MOVED_AT = new Date("2026-11-20T13:00:00.000Z");

let template: PGlite;
let db: TestDb;
let auth: Auth;
let outbox: MagicLinkMessage[];

beforeAll(async () => {
  template = await migratedTemplate();
});

beforeEach(async () => {
  db = await cloneDb(template);
  outbox = [];
  auth = testAuth({ db, outbox, log: memoryLogger() });
  const repair: SealRepairDeps = {
    withViewerTenant,
    sealSessions: vi.fn<SealSessions>(async () => ({ ok: true, sessions: {} })),
    now: () => NOW,
    log: memoryLogger(),
  };
  const reviews: ReviewRouteDeps = {
    withViewerTenant,
    env: {},
    log: memoryLogger(),
    now: () => NOW,
    mode: "development",
  };
  Object.assign(scope, { cookie: "", auth, db, repair, reviews });
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

function load(viewer: Viewer): Promise<InboxData> {
  return withTenant(db, tenantOf(viewer), (tx) =>
    loadInbox(tx, { userId: viewer.user.id, workspaceId: viewer.workspaceId }, { now: NOW }),
  );
}

/** The demo CRM and the Acme Dynamics sample debrief, as Settings → Data loads them. */
async function withAcmeSample(viewer: Viewer): Promise<void> {
  await withTenant(db, tenantOf(viewer), async (tx) => {
    await loadDemoCrm(tx);
    await importSessionLog(tx, readFixture("samples/acme-dynamics.jsonl"), {
      mapDemoIds: true,
      now: NOW,
    });
  });
}

function allProposals(data: InboxData): { proposal: InboxProposal; sessionId: string }[] {
  return data.sessions.flatMap((session) =>
    session.proposals.map((proposal) => ({ proposal, sessionId: session.sessionId })),
  );
}

function byType(data: InboxData, type: InboxProposal["type"]) {
  const found = allProposals(data).find((entry) => entry.proposal.type === type);
  if (!found) throw new Error(`no ${type} proposal`);
  return found;
}

/** The new-record proposal a debrief makes of "Atmo Systems", a company no record matches. */
function newRecordDebrief(mention = "Atmo Systems"): EventDraft[] {
  const evidence = {
    utteranceId: "00000000-0000-7000-8000-0000000007d1",
    span: [0, mention.length],
    audioMs: [1000, 1800],
    confidence: 0.92,
  };
  return [
    draft(1, started()),
    draft(2, utterance(1, `${mention} wants a pilot.`)),
    draft(
      3,
      proposalV2(
        1,
        {
          decision: "new",
          entityId: null,
          kind: "company",
          basis: null,
          p: 0.94,
          mention: { quote: mention, evidence },
          candidates: [{ entityId: null, p: 0.94 }],
        },
        { riskFlags: [{ kind: "new_entity", field: "target" }] },
      ),
    ),
    draft(4, ended()),
    draft(5, sealed()),
  ];
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
    await appendEvents(tx, sessionId, NO_EVENTS, events);
    await rebuildProjections(tx, sessionId);
  });
  return sessionId;
}

/** A card's proposal as the writers fold it, for `checkReview`. */
function asView(proposal: InboxProposal): ProposalView {
  return { ...proposal, review: null } as ProposalView;
}

describe("the 3-way card and the re-link offer, pure", () => {
  it("says how long ago the CRM changed, with no time zone", () => {
    const now = new Date("2026-11-20T15:00:00.000Z");
    const ago = (iso: string) => agoWords(new Date(iso), now);
    expect(ago("2026-11-20T14:59:40.000Z")).toBe("just now");
    expect(ago("2026-11-20T15:00:30.000Z")).toBe("just now");
    expect(ago("2026-11-20T14:55:00.000Z")).toBe("5 min ago");
    expect(ago("2026-11-20T13:00:00.000Z")).toBe("2 h ago");
    expect(ago("2026-11-19T14:00:00.000Z")).toBe("1 day ago");
    expect(ago("2026-11-08T15:00:00.000Z")).toBe("12 days ago");
  });

  it("speaks each line the spec and the ADR give", () => {
    expect(relinkLine("Acme Robotics").text).toBe(
      "Acme Robotics was added to your CRM after you spoke. Is it this one?",
    );
    expect(threeWayLine("stage and amount").text).toBe(
      "The stage and amount changed in your CRM after you spoke. Keep yours or the CRM's?",
    );
  });

  it("shows a field three ways only when the CRM's value moved, and keeps the CRM's only what differs", () => {
    expect(threeWayFields(UPDATE, ENTITIES)).toEqual([]);
    expect(
      cardModel(UPDATE, ENTITIES, QUOTES, Date.parse("2026-11-20T15:00:00.000Z")).review,
    ).toBeNull();
    const [stage] = threeWayFields(CRM_CHANGED, ENTITIES);
    expect(stage).toEqual({
      field: "stage",
      base: "qualifiedtobuy",
      current: "presentationscheduled",
      proposed: "proposal",
      changedAt: "2026-11-20T13:00:00.000Z",
    });
    // A history that ends where it started isn't a change the card shows.
    const back = {
      ...CRM_CHANGED,
      crm: {
        moved: { stage: { base: "presentationscheduled", changedAt: "2026-11-20T13:00:00.000Z" } },
        relink: null,
      },
    };
    expect(threeWayFields(back, ENTITIES)).toEqual([]);
    // The CRM moved to exactly what the rep said: keeping the CRM's is keeping theirs.
    expect(keepCrmDiff([{ ...(stage as NonNullable<typeof stage>), current: "proposal" }])).toEqual(
      {},
    );
    const model = cardModel(CRM_CHANGED, ENTITIES, QUOTES, Date.parse("2026-11-20T15:00:00.000Z"));
    // Its amount didn't move, so it's still two values, before and after.
    expect(model.fields.find((field) => field.name === "amount")).toMatchObject({
      before: "$32,000",
      value: "$40,000",
      threeWay: null,
    });
  });
});

describe("base and current: the 3-way card", () => {
  it("shows nothing three ways while the CRM hasn't moved: the sample debriefs as loaded", async () => {
    const viewer = await signIn("dana@earshot.example");
    await withAcmeSample(viewer);
    const data = await load(viewer);
    expect(allProposals(data).every(({ proposal }) => proposal.crm === undefined)).toBe(true);
    for (const { proposal } of allProposals(data)) {
      expect(cardModel(proposal, data.entities, data.quotes, NOW.getTime()).review).toBeNull();
    }
  });

  it("reads the stage when the rep spoke and now, and the card shows both beside what was said", async () => {
    const viewer = await signIn("dana@earshot.example");
    await withAcmeSample(viewer);
    const { proposal: before } = byType(await load(viewer), "deal_update");
    const dealId = before.target.entityId as string;
    // Simulated after the rep spoke: the deal moves from appointment scheduled to the next stage.
    const moved = await withTenant(db, tenantOf(viewer), (tx) =>
      moveDemoField(tx, { entityId: dealId, field: "stage", now: MOVED_AT }),
    );
    expect(moved).toMatchObject({ old: "appointmentscheduled", new: "qualifiedtobuy" });

    const data = await load(viewer);
    const { proposal } = byType(data, "deal_update");
    expect(proposal.crm).toEqual({
      moved: { stage: { base: "appointmentscheduled", changedAt: MOVED_AT.toISOString() } },
      relink: null,
    });
    expect(data.entities[dealId]?.values.stage).toBe("qualifiedtobuy");
    // Only the card whose record moved.
    expect(allProposals(data).filter(({ proposal: p }) => p.crm !== undefined)).toHaveLength(1);

    const model = cardModel(proposal, data.entities, data.quotes, NOW.getTime());
    expect(model.tier.tier).toBe("loud");
    expect(tierOf(proposal).tier).toBe("none");
    expect(model.review?.kind).toBe("crm_changed");
    expect(model.fields.find((field) => field.name === "stage")?.threeWay?.text).toBe(
      "Appointment scheduled when you spoke · Qualified to buy in the CRM now (changed 2 h ago) · you said proposal",
    );
    expect(model.firstPerson?.text).toBe(
      "The stage changed in your CRM after you spoke. Keep yours or the CRM's?",
    );
    expect(model.description).toBe(
      "Deal update, Acme Dynamics - Expansion, needs a check: The stage changed in your CRM after you spoke.",
    );

    // "Keep the CRM's": an edit setting the stage to the CRM's value now, and what was seen.
    expect(model.keepCrm).toEqual({
      editDiff: { stage: { before: "proposal", after: "qualifiedtobuy" } },
      words: "stage",
    });
    const kept = decisionReview({
      proposal,
      entities: data.entities,
      decision: "edited",
      editDiff: model.keepCrm?.editDiff ?? {},
      timing: { decisionMs: 900, handlingMs: 900 },
      input: "keyboard",
    });
    expect(kept.editDiff).toEqual({ stage: { before: "proposal", after: "qualifiedtobuy" } });
    expect(kept.seen?.tier).toBe("loud");
    expect(kept.seen?.fields.stage).toEqual({
      proposed: "proposal",
      base: "appointmentscheduled",
      current: "qualifiedtobuy",
    });
    expect(kept.seen?.relinked).toBeNull();
  });

  it("keeps the 3-way card out of accept all, which the writers' rule refuses too", async () => {
    const viewer = await signIn("dana@earshot.example");
    await withAcmeSample(viewer);
    const { proposal: before, sessionId } = byType(await load(viewer), "deal_update");
    await withTenant(db, tenantOf(viewer), (tx) =>
      moveDemoField(tx, {
        entityId: before.target.entityId as string,
        field: "stage",
        now: MOVED_AT,
      }),
    );
    const data = await load(viewer);
    const session = data.sessions.find((s) => s.sessionId === sessionId);
    const open = session?.proposals ?? [];
    const plan = batchPlan(sessionId, open, () => false, data.entities);
    const { proposal } = byType(data, "deal_update");
    expect(plan.stay).toContainEqual({ proposal, reason: "loud" });
    expect(plan.accept.map((p) => p.proposalId)).not.toContain(proposal.proposalId);
    // Were a page to send it in a batch anyway, the writers refuse it as marked.
    const { reviews } = batchReviews([proposal], {
      entities: data.entities,
      timing: { decisionMs: 0, handlingMs: 0 },
      input: "keyboard",
      surface: "inbox",
    });
    const [review] = reviews;
    if (!review) throw new Error("no batch review");
    const check = checkReview(
      [asView(proposal)],
      {
        ...review,
        syncEligibleAt: NOW.toISOString(),
        by: { userId: viewer.user.id, auth: null },
      },
      { tierOf, from: "client" },
    );
    expect(check).toMatchObject({ ok: false, reason: "marked" });
  });
});

describe("re-linking a new record at review time", () => {
  it("offers a matching record once it reaches the CRM after the rep spoke, loud, and out of accept all", async () => {
    const viewer = await signIn("dana@earshot.example");
    await withTenant(db, tenantOf(viewer), (tx) => loadDemoCrm(tx));
    const sessionId = await sessionWithLog(viewer, newRecordDebrief());
    const first = byType(await load(viewer), "task").proposal;
    expect(first.crm).toBeUndefined();
    expect(cardModel(first, {}, {}).review).toBeNull();

    const added = await withTenant(db, tenantOf(viewer), (tx) =>
      addDemoRecord(tx, {
        kind: "company",
        name: "Atmo Systems",
        newId: () => crypto.randomUUID(),
        now: MOVED_AT,
      }),
    );
    const data = await load(viewer);
    const { proposal } = byType(data, "task");
    expect(proposal.crm).toEqual({ moved: {}, relink: added?.entityId });
    expect(data.entities[added?.entityId as string]?.name).toBe("Atmo Systems");

    const model = cardModel(proposal, data.entities, data.quotes, NOW.getTime());
    expect(model.tier.tier).toBe("loud");
    expect(model.firstPerson?.text).toBe(
      "Atmo Systems was added to your CRM after you spoke. Is it this one?",
    );
    expect(model.chooser?.options.map((option) => [option.label, option.detail])).toEqual([
      ["Atmo Systems", "added after you spoke"],
      ["A new record", "94%"],
    ]);
    expect(model.acceptable).toBe("choose");
    expect(model.choosesRecord).toBe(true);
    const session = data.sessions.find((s) => s.sessionId === sessionId);
    expect(batchPlan(sessionId, session?.proposals ?? [], () => false, data.entities).stay).toEqual(
      [{ proposal, reason: "loud" }],
    );

    // Choosing it records the offer as seen, and the writers take the record it names.
    const chosen = decisionReview({
      proposal,
      entities: data.entities,
      decision: "approved",
      target: { entityId: added?.entityId ?? null },
      offered: [added?.entityId ?? null, null],
      timing: { decisionMs: 700, handlingMs: 700 },
      input: "keyboard",
    });
    expect(chosen.seen).toMatchObject({
      tier: "loud",
      relinked: added?.entityId,
      target: { entityId: null, offered: [added?.entityId, null] },
    });
    const response = await reviewsRoute.POST(
      new Request(`${ORIGIN}/api/sessions/${sessionId}/reviews`, {
        method: "POST",
        headers: { cookie: scope.cookie, "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ reviews: [chosen] }),
      }),
      { params: Promise.resolve({ id: sessionId }) },
    );
    expect(response.status).toBe(200);
    const [row] = await db
      .select({ review: proposals.review, status: proposals.status })
      .from(proposals)
      .where(eq(proposals.id, proposal.proposalId));
    expect(row?.status).toBe("approved");
    expect(row?.review).toMatchObject({ target: { entityId: added?.entityId } });
  });

  it("never offers a record that was in the CRM when the rep spoke, nor one that doesn't link", async () => {
    const viewer = await signIn("dana@earshot.example");
    await withTenant(db, tenantOf(viewer), (tx) => loadDemoCrm(tx));
    // "Pier Logistics" was loaded with the demo CRM, before the debrief: no arrival to date it.
    await sessionWithLog(viewer, newRecordDebrief("Pier Logistics"));
    // A record arrived since, but these words don't name it.
    await withTenant(db, tenantOf(viewer), (tx) =>
      addDemoRecord(tx, {
        kind: "company",
        name: "Zenyth Partners",
        newId: () => crypto.randomUUID(),
        now: MOVED_AT,
      }),
    );
    const data = await load(viewer);
    expect(allProposals(data).every(({ proposal }) => proposal.crm === undefined)).toBe(true);
  });

  it("refuses a review naming an offered record the workspace doesn't hold", async () => {
    const viewer = await signIn("dana@earshot.example");
    await withTenant(db, tenantOf(viewer), (tx) => loadDemoCrm(tx));
    const sessionId = await sessionWithLog(viewer, newRecordDebrief());
    const { proposal } = byType(await load(viewer), "task");
    const forged = uuidv7();
    const review = decisionReview({
      proposal: { ...proposal, crm: { moved: {}, relink: forged } },
      entities: {},
      decision: "approved",
      target: { entityId: forged },
      timing: { decisionMs: 700, handlingMs: 700 },
      input: "keyboard",
    });
    const response = await reviewsRoute.POST(
      new Request(`${ORIGIN}/api/sessions/${sessionId}/reviews`, {
        method: "POST",
        headers: { cookie: scope.cookie, "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ reviews: [review] }),
      }),
      { params: Promise.resolve({ id: sessionId }) },
    );
    expect(response.status).toBe(400);
    const [row] = await db
      .select({ status: proposals.status })
      .from(proposals)
      .where(eq(proposals.id, proposal.proposalId));
    expect(row?.status).toBe("proposed");
  });
});

describe("the demo controls", () => {
  it("offers Simulate a CRM change only on update cards whose record is a demo record", async () => {
    const viewer = await signIn("dana@earshot.example");
    await withAcmeSample(viewer);
    const data = await load(viewer);
    expect(data.demoCrm).toBe(true);
    const fields = allProposals(data).map(({ proposal }) => [
      proposal.type,
      simulatedField(proposal, data.entities),
    ]);
    expect(fields).toEqual([
      ["contact", "title"],
      ["deal_update", "stage"],
      ["task", null],
      ["note", null],
    ]);
    // The same card on a record that isn't a demo record gets none.
    const { proposal } = byType(data, "deal_update");
    const dealId = proposal.target.entityId as string;
    const notDemo = { ...data.entities, [dealId]: { ...data.entities[dealId], demo: false } };
    expect(simulatedField(proposal, notDemo as InboxData["entities"])).toBeNull();
  });

  it("moves the card's field and records its history through the server action, for the viewer's own card only", async () => {
    const viewer = await signIn("dana@earshot.example");
    await withAcmeSample(viewer);
    const { proposal, sessionId } = byType(await load(viewer), "deal_update");
    const dealId = proposal.target.entityId as string;

    // Another user, in their own workspace, can't reach it with its ids.
    await signIn("sam@earshot.example");
    expect(await simulateCrmChangeAction({ sessionId, proposalId: proposal.proposalId })).toEqual({
      status: "nothing",
      message: "That card has nothing in the demo CRM to change.",
    });
    expect(await db.select().from(crmEntityChanges)).toEqual([]);

    await signIn("dana@earshot.example");
    expect(
      await simulateCrmChangeAction({ sessionId, proposalId: proposal.proposalId }),
    ).toMatchObject({
      status: "done",
      message: "Changed the stage in the demo CRM to Qualified to buy.",
    });
    const [deal] = await db
      .select({ properties: crmEntities.properties })
      .from(crmEntities)
      .where(eq(crmEntities.id, dealId));
    expect(deal?.properties.stage).toBe("qualifiedtobuy");
    const history = await db.select().from(crmEntityChanges);
    expect(history).toMatchObject([
      { entityId: dealId, field: "stage", old: "appointmentscheduled", new: "qualifiedtobuy" },
    ]);
    expect(history[0]?.source).toBe("demo");
    // Malformed ids, and a card that isn't an update, change nothing.
    expect((await simulateCrmChangeAction({ sessionId: "x", proposalId: "y" })).status).toBe(
      "nothing",
    );
    const note = byType(await load(viewer), "note").proposal;
    expect((await simulateCrmChangeAction({ sessionId, proposalId: note.proposalId })).status).toBe(
      "nothing",
    );
    expect(await db.select().from(crmEntityChanges)).toHaveLength(1);
  });

  it("adds the record a new-record card heard, once, and only in a demo CRM", async () => {
    const viewer = await signIn("dana@earshot.example");
    const sessionId = await sessionWithLog(viewer, newRecordDebrief());
    let { proposal } = byType(await load(viewer), "task");
    // No demo CRM: no control, and the action adds nothing.
    expect(canAddMatching(proposal, (await load(viewer)).demoCrm === true)).toBe(false);
    expect(
      (await addMatchingRecordAction({ sessionId, proposalId: proposal.proposalId })).status,
    ).toBe("nothing");

    await withTenant(db, tenantOf(viewer), (tx) => loadDemoCrm(tx));
    const data = await load(viewer);
    proposal = byType(data, "task").proposal;
    expect(canAddMatching(proposal, data.demoCrm === true)).toBe(true);
    expect(await addMatchingRecordAction({ sessionId, proposalId: proposal.proposalId })).toEqual({
      status: "done",
      message: "Added Atmo Systems to the demo CRM.",
    });
    expect(await addMatchingRecordAction({ sessionId, proposalId: proposal.proposalId })).toEqual({
      status: "done",
      message: "Atmo Systems is already in the demo CRM.",
    });
    // Now it re-links, so the card offers the record instead of the control.
    const after = byType(await load(viewer), "task").proposal;
    expect(after.crm?.relink).toEqual(expect.any(String));
    expect(canAddMatching(after, true)).toBe(false);
  });
});
