import { fromJsonl, NO_EVENTS, ProjectionError, type SessionView } from "@earshot/events";
import {
  demoSessionId,
  demoSessionJsonl,
  draft,
  ended,
  proposal,
  proposalFlagged,
  proposalV2,
  readFixture,
  recapCreated,
  reopen,
  review,
  reviewV2,
  SESSION_ID,
  sealed,
  snoozed,
  started,
  tsFor,
  turnWitnessed,
  utterance,
  uuid,
} from "@earshot/events/testing";
import type { PGlite } from "@electric-sql/pglite";
import { asc, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { appendEvents, PgEventStore, UnknownSessionError } from "../src/event-store";
import { rebuildProjections } from "../src/projections";
import {
  crmEntities,
  proposals,
  sessionEvents,
  sessions,
  syncJobs,
  utterances,
} from "../src/schema";
import { withTenant } from "../src/tenant";
import { A, B, cloneDb, migratedDb } from "./db";
import { createTenant } from "./tenants";

type Db = Awaited<ReturnType<typeof migratedDb>>["db"];

/** The demo's targets: Acme Corp's deal, and Acme Corp itself. */
const DEMO_DEAL = "01a0f831-afe8-7fff-84cf-71639949085b";
const DEMO_COMPANY = "01a0f831-ac00-75a0-a2b2-cb79eb1835bf";

const snapshot = JSON.parse(readFixture("demo-session.projections.json"));

let template: PGlite;
const opened: PGlite[] = [];

// A has the demo session, with every event appended and the CRM records its proposals target,
// plus SESSION_ID with no events. B has a session of its own.
beforeAll(async () => {
  const { client, db } = await migratedDb();
  await createTenant(db, A, [demoSessionId, SESSION_ID]);
  await createTenant(db, B, [uuid(0xbbbb)]);
  await db.insert(crmEntities).values([
    { id: DEMO_DEAL, workspaceId: A.workspaceId, kind: "deal", externalId: "d1", name: "Acme" },
    {
      id: DEMO_COMPANY,
      workspaceId: A.workspaceId,
      kind: "company",
      externalId: "c1",
      name: "Acme",
    },
  ]);
  const drafts = fromJsonl(demoSessionJsonl).map(({ sessionId: _, ...event }) => event);
  await new PgEventStore(db, A).append(demoSessionId, NO_EVENTS, drafts);
  template = client;
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((client) => client.close()));
});

afterAll(async () => {
  await template.close();
});

async function fresh(): Promise<Db> {
  const copy = await cloneDb(template);
  opened.push(copy.client);
  return copy.db;
}

const rebuild = (db: Db, sessionId: string, tenant = A) =>
  withTenant(db, tenant, (tx) => rebuildProjections(tx, sessionId));

/** Every projection row of a session, read as the owner. */
async function rowsOf(db: Db, sessionId: string) {
  return {
    session: await db.select().from(sessions).where(eq(sessions.id, sessionId)),
    utterances: await db
      .select()
      .from(utterances)
      .where(eq(utterances.sessionId, sessionId))
      .orderBy(asc(utterances.seq)),
    proposals: await db
      .select()
      .from(proposals)
      .where(eq(proposals.sessionId, sessionId))
      .orderBy(asc(proposals.seq)),
  };
}

/**
 * The rows, as A reads them, turned back into the projections' shapes: columns renamed,
 * timestamps as ISO strings, the risk flags decoded, the latest review from its `review` column
 * with its seq and time, and `status`, `durationMs`, `lastSeq`, and `lastEventAt` derived from
 * the session's row and its last event. Since migration 0014 the tables hold every field of the
 * projections, so the rows read back as the replay exactly.
 */
function readProjections(db: Db, sessionId: string) {
  return withTenant(db, A, async (tx) => {
    const [session] = await tx.select().from(sessions).where(eq(sessions.id, sessionId));
    const [last] = await tx
      .select({ seq: sessionEvents.seq, ts: sessionEvents.ts })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(desc(sessionEvents.seq))
      .limit(1);
    const utteranceRows = await tx
      .select()
      .from(utterances)
      .where(eq(utterances.sessionId, sessionId))
      .orderBy(asc(utterances.seq));
    const proposalRows = await tx
      .select()
      .from(proposals)
      .where(eq(proposals.sessionId, sessionId))
      .orderBy(asc(proposals.seq));
    return {
      session:
        session && last
          ? {
              sessionId: session.id,
              status: session.endedAt ? "ended" : "active",
              mode: session.mode,
              engine: session.engine,
              providers: session.providers,
              startedAt: session.startedAt.toISOString(),
              endedAt: session.endedAt?.toISOString() ?? null,
              sealedAt: session.sealedAt?.toISOString() ?? null,
              durationMs: session.endedAt
                ? session.endedAt.getTime() - session.startedAt.getTime()
                : null,
              // Migration 0015 (Phase 5 WP10): the recap, whole, as the projection keeps it.
              recap: (session.recap as SessionView["recap"]) ?? null,
              costUsd: Number(session.costUsd),
              lastSeq: last.seq,
              lastEventAt: last.ts.toISOString(),
            }
          : null,
      utterances: utteranceRows.map((row) => ({
        utteranceId: row.id,
        seq: row.seq,
        ts: row.ts?.toISOString(),
        witness: row.witness,
        // Migration 0018 (Phase 5 WP13): how the words arrived.
        input: row.input,
        text: row.text,
        confidence: row.confidence,
        startMs: row.startedMs,
        endMs: row.endedMs,
        words: row.words,
      })),
      proposals: proposalRows.map((row) => ({
        proposalId: row.id,
        type: row.type,
        targetEntityId: row.targetEntityId,
        target: row.target,
        status: row.status,
        fields: row.fields,
        riskFlags: row.riskFlags.map((flag) => {
          const [kind, field] = flag.split(":");
          return field === undefined ? { kind } : { kind, field };
        }),
        conflicts: row.conflicts,
        supersedes: row.supersedes,
        supersededBy: row.supersededBy,
        snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
        // Migration 0018 (Phase 5 WP13): the follow-up questions, as the projection keeps them.
        followups: row.followups,
        seq: row.seq,
        ts: row.createdAt.toISOString(),
        review:
          row.reviewedSeq === null
            ? null
            : { ...row.review, seq: row.reviewedSeq, ts: row.reviewedAt?.toISOString() },
      })),
    };
  });
}

describe("rebuildProjections", () => {
  it("writes rows that read back as the committed projection snapshot", async () => {
    const db = await fresh();
    expect(await rebuild(db, demoSessionId)).toEqual(snapshot);
    expect(await readProjections(db, demoSessionId)).toEqual(snapshot);
  });

  it("restores identical rows after they're deleted", async () => {
    const db = await fresh();
    await rebuild(db, demoSessionId);
    const before = await rowsOf(db, demoSessionId);

    await db.delete(utterances).where(eq(utterances.sessionId, demoSessionId));
    await db.delete(proposals).where(eq(proposals.sessionId, demoSessionId));
    await db
      .update(sessions)
      .set({ startedAt: new Date(), endedAt: null, costUsd: "0", providers: {} })
      .where(eq(sessions.id, demoSessionId));
    expect((await rowsOf(db, demoSessionId)).utterances).toEqual([]);

    await rebuild(db, demoSessionId);
    expect(await rowsOf(db, demoSessionId)).toEqual(before);
  });

  it("writes the same rows again, and removes rows the log doesn't produce", async () => {
    const db = await fresh();
    await rebuild(db, demoSessionId);
    const before = await rowsOf(db, demoSessionId);

    await db.insert(utterances).values({
      workspaceId: A.workspaceId,
      sessionId: demoSessionId,
      seq: 99,
      witness: "unbiased",
      text: "A stray row.",
      startedMs: 0,
      endedMs: 1,
    });
    await db.insert(proposals).values({
      workspaceId: A.workspaceId,
      sessionId: demoSessionId,
      type: "note",
      fields: {},
    });
    await rebuild(db, demoSessionId);
    expect(await rowsOf(db, demoSessionId)).toEqual(before);
  });

  it("updates proposals in place, so their sync jobs survive a rebuild", async () => {
    const db = await fresh();
    const { proposals: views } = await rebuild(db, demoSessionId);
    const approved = views.find((view) => view.status === "approved")?.proposalId ?? "";
    await db.insert(syncJobs).values({
      workspaceId: A.workspaceId,
      proposalId: approved,
      reviewId: uuid(0x7e1),
      provider: "demo",
      idempotencyKey: "e".repeat(64),
      notBefore: new Date("2026-11-10T19:16:30Z"),
    });
    await rebuild(db, demoSessionId);
    expect(await db.select({ id: syncJobs.proposalId }).from(syncJobs)).toEqual([{ id: approved }]);
  });

  it("follows the log as it grows: reviews, word timings, and the end", async () => {
    const db = await fresh();
    const store = new PgEventStore(db, A);
    const withEmptyWords = utterance(2);
    withEmptyWords.payload.words = [];
    await store.append(SESSION_ID, NO_EVENTS, [
      draft(1, started()),
      draft(2, utterance(1)),
      draft(3, withEmptyWords),
      draft(4, proposal(1)),
    ]);
    const first = await rebuild(db, SESSION_ID);
    expect(first.session).toMatchObject({ status: "active", endedAt: null });
    const [created] = (await rowsOf(db, SESSION_ID)).proposals;
    expect(created).toMatchObject({ status: "proposed", seq: 3, reviewedSeq: null });
    expect((await rowsOf(db, SESSION_ID)).utterances.map((row) => row.words)).toEqual([null, []]);

    await store.append(SESSION_ID, 3, [draft(5, review(1, "approved")), draft(6, ended())]);
    await rebuild(db, SESSION_ID);
    const { session, proposals: [reviewed] = [] } = await rowsOf(db, SESSION_ID);
    expect(reviewed).toMatchObject({
      status: "approved",
      reviewedSeq: 4,
      reviewedAt: new Date("2026-11-10T19:15:05.000Z"),
      updatedAt: new Date("2026-11-10T19:15:05.000Z"),
      createdAt: created?.createdAt,
    });
    expect(session).toMatchObject([
      { endedAt: new Date("2026-11-10T19:15:40.000Z"), costUsd: "0.0040" },
    ]);
  });

  it("holds every offset and reviewer time the contracts accept, up to the largest safe integer", async () => {
    const db = await fresh();
    const big = Number.MAX_SAFE_INTEGER;
    const late = utterance(1);
    late.payload.startMs = big - 800;
    late.payload.endMs = big;
    await new PgEventStore(db, A).append(SESSION_ID, NO_EVENTS, [
      draft(1, started()),
      draft(2, late),
      draft(3, proposal(1)),
      draft(4, review(1, "approved", { reviewerMs: big })),
    ]);
    await rebuild(db, SESSION_ID);
    const rows = await rowsOf(db, SESSION_ID);
    expect(rows.utterances.map((row) => [row.startedMs, row.endedMs])).toEqual([[big - 800, big]]);
    expect(rows.proposals.map((row) => row.reviewerMs)).toEqual([big]);
  });

  it("won't take over another session's proposal that has the same id", async () => {
    const db = await fresh();
    const { proposals: views } = await rebuild(db, demoSessionId);
    const copied = proposal(1);
    copied.payload.proposalId = views[0]?.proposalId;
    await new PgEventStore(db, A).append(SESSION_ID, NO_EVENTS, [
      draft(1, started()),
      draft(2, copied),
    ]);
    const before = await rowsOf(db, demoSessionId);
    await expect(rebuild(db, SESSION_ID)).rejects.toThrow(
      `proposal ${views[0]?.proposalId} belongs to another session`,
    );
    expect(await rowsOf(db, demoSessionId)).toEqual(before);
  });

  it("leaves out a target that isn't in the workspace's CRM mirror", async () => {
    const db = await fresh();
    await db.delete(crmEntities).where(eq(crmEntities.id, DEMO_DEAL));
    const unmirrored = proposal(1);
    unmirrored.payload.targetEntityId = "hubspot:deal:42";
    const store = new PgEventStore(db, A);
    await store.append(SESSION_ID, NO_EVENTS, [draft(1, started()), draft(2, unmirrored)]);

    const { proposals: views } = await rebuild(db, demoSessionId);
    await rebuild(db, SESSION_ID);
    const targets = async (sessionId: string) =>
      (await rowsOf(db, sessionId)).proposals.map((row) => row.targetEntityId);
    expect(await targets(demoSessionId)).toEqual(
      views.map((view) => (view.targetEntityId === DEMO_DEAL ? null : view.targetEntityId)),
    );
    expect(await targets(SESSION_ID)).toEqual([null]);
  });

  it("clears the rows of a session that has no events, and leaves its session row alone", async () => {
    const db = await fresh();
    const [row] = (await rowsOf(db, SESSION_ID)).session;
    await db.insert(utterances).values({
      workspaceId: A.workspaceId,
      sessionId: SESSION_ID,
      seq: 0,
      witness: "biased",
      text: "No event says this.",
      startedMs: 0,
      endedMs: 1,
    });
    expect(await rebuild(db, SESSION_ID)).toEqual({ session: null, utterances: [], proposals: [] });
    expect(await rowsOf(db, SESSION_ID)).toEqual({ session: [row], utterances: [], proposals: [] });
  });

  it("appends and rebuilds in one transaction, which a log replay refuses rolls back", async () => {
    const db = await fresh();
    await withTenant(db, A, async (tx) => {
      await appendEvents(tx, SESSION_ID, NO_EVENTS, [draft(1, started()), draft(2, utterance(1))]);
      await rebuildProjections(tx, SESSION_ID);
    });
    expect((await rowsOf(db, SESSION_ID)).utterances).toHaveLength(1);

    // A review of a proposal that doesn't exist: the store takes it, the projection refuses it.
    const failing = withTenant(db, A, async (tx) => {
      await appendEvents(tx, SESSION_ID, 1, [draft(3, review(7, "approved"))]);
      await rebuildProjections(tx, SESSION_ID);
    });
    await expect(failing).rejects.toBeInstanceOf(ProjectionError);
    expect(await new PgEventStore(db, A).read(SESSION_ID)).toHaveLength(2);
  });
});

describe("flushing Phase 4 events: v2 proposals, witness flags, and downgrades", () => {
  /** A CRM record in A's mirror that v2 proposals link to: `uuid(6001)`, as the builders use. */
  const LINKED = uuid(6001);
  const downgrade = proposalFlagged(1, {
    target: {
      decision: "ask",
      candidates: [
        { entityId: uuid(6003), p: 0.55 },
        { entityId: LINKED, p: 0.35 },
        { entityId: null, p: 0.1 },
      ],
    },
  });

  /** One flush, as `SessionDO`'s consumer runs it: append a batch and rebuild, in one transaction. */
  const flush = (db: Db, expectedLastSeq: number, batch: Parameters<typeof appendEvents>[3]) =>
    withTenant(db, A, async (tx) => {
      await appendEvents(tx, SESSION_ID, expectedLastSeq, batch);
      return rebuildProjections(tx, SESSION_ID);
    });

  async function withLinkedEntity(): Promise<Db> {
    const db = await fresh();
    await db.insert(crmEntities).values({
      id: LINKED,
      workspaceId: A.workspaceId,
      kind: "company",
      externalId: "c-akme",
      name: "Acme Dynamics",
    });
    return db;
  }

  it("writes each v2 target, its entity id, and its target flags", async () => {
    const db = await withLinkedEntity();
    const asked = { decision: "ask", entityId: null, basis: null, p: 0.48 };
    const projections = await flush(db, NO_EVENTS, [
      draft(1, started()),
      draft(2, utterance(1)),
      draft(3, proposalV2(1)),
      draft(4, proposalV2(2, asked)),
    ]);
    const rows = (await rowsOf(db, SESSION_ID)).proposals;
    expect(rows.map((row) => [row.targetEntityId, row.riskFlags, row.conflicts])).toEqual([
      [LINKED, ["link_uncertain:target"], []],
      [null, ["link_uncertain:target"], []],
    ]);
    expect(rows.map((row) => row.target)).toEqual([
      proposalV2(1).payload.target,
      { ...(proposalV2(1).payload.target as object), ...asked },
    ]);
    expect((await readProjections(db, SESSION_ID)).proposals).toEqual(projections.proposals);
  });

  it("downgrades a linked target in a later flush, with the witness's flag and conflict", async () => {
    const db = await withLinkedEntity();
    await flush(db, NO_EVENTS, [
      draft(1, started()),
      draft(2, utterance(1)),
      draft(3, proposalV2(1)),
    ]);
    const projections = await flush(db, 2, [
      draft(4, utterance(2, "Met Dana Li at Atmo.", "unbiased")),
      draft(5, downgrade),
      draft(6, turnWitnessed(1)),
    ]);

    const [row] = (await rowsOf(db, SESSION_ID)).proposals;
    expect(row).toMatchObject({
      targetEntityId: null,
      target: {
        decision: "ask",
        entityId: null,
        candidates: [
          { entityId: LINKED, p: 0.35 },
          { entityId: uuid(6003), p: 0.55 },
          { entityId: null, p: 0.1 },
        ],
      },
      riskFlags: ["link_uncertain:target", "witness_conflict:target"],
      conflicts: [proposalFlagged(1).payload.conflict],
      status: "proposed",
    });
    const witnesses = (await rowsOf(db, SESSION_ID)).utterances.map((u) => u.witness);
    expect(witnesses).toEqual(["biased", "unbiased"]);
    expect((await readProjections(db, SESSION_ID)).proposals).toEqual(projections.proposals);
  });

  it("fills a pre-Phase 4 row's empty target from the log, upcasting v1", async () => {
    const db = await fresh();
    await rebuild(db, demoSessionId);
    // Migration 0012 leaves `target` null on the rows it finds, until the next rebuild.
    await db.update(proposals).set({ target: null }).where(eq(proposals.sessionId, demoSessionId));
    await rebuild(db, demoSessionId);
    const rows = (await rowsOf(db, demoSessionId)).proposals;
    expect(rows.map((row) => (row.target as { decision: string } | null)?.decision)).toEqual([
      "new",
      "linked",
      "linked",
      "linked",
      "linked",
    ]);
    expect(await readProjections(db, demoSessionId)).toEqual(snapshot);
  });

  it("rolls back a flush whose downgrade doesn't list the target it replaces", async () => {
    const db = await withLinkedEntity();
    await flush(db, NO_EVENTS, [
      draft(1, started()),
      draft(2, utterance(1)),
      draft(3, proposalV2(1)),
    ]);
    const unlisted = proposalFlagged(1, {
      target: { decision: "ask", candidates: [{ entityId: uuid(6003), p: 0.6 }] },
    });
    await expect(flush(db, 2, [draft(4, unlisted)])).rejects.toBeInstanceOf(ProjectionError);
    expect(await new PgEventStore(db, A).read(SESSION_ID)).toHaveLength(3);
    expect((await rowsOf(db, SESSION_ID)).proposals.map((row) => row.targetEntityId)).toEqual([
      LINKED,
    ]);
  });
});

describe("flushing the recap (Phase 5 WP10)", () => {
  it("stores the session's recap in sessions.recap, null until it comes, whole once it does", async () => {
    const db = await fresh();
    const flush = (expectedLastSeq: number, batch: Parameters<typeof appendEvents>[3]) =>
      withTenant(db, A, async (tx) => {
        await appendEvents(tx, SESSION_ID, expectedLastSeq, batch);
        return rebuildProjections(tx, SESSION_ID);
      });
    await flush(NO_EVENTS, [draft(1, started()), draft(2, utterance(1)), draft(3, ended())]);
    expect((await rowsOf(db, SESSION_ID)).session[0]?.recap).toBeNull();

    const projections = await flush(2, [draft(4, recapCreated()), draft(5, sealed())]);
    const [row] = (await rowsOf(db, SESSION_ID)).session;
    expect(row?.recap).toMatchObject({
      outcome: "created",
      reason: null,
      dropped: 1,
      // draft(4) is seq 3, with draft 4's time.
      seq: 3,
      ts: tsFor(4),
      sentences: [{ kind: "headline" }, { kind: "next_step", weakSupport: true }],
    });
    expect((await readProjections(db, SESSION_ID)).session).toEqual(projections.session);
  });

  it("refuses a log with a second recap, writing nothing", async () => {
    const db = await fresh();
    await expect(
      withTenant(db, A, async (tx) => {
        await appendEvents(tx, SESSION_ID, NO_EVENTS, [
          draft(1, started()),
          draft(2, ended()),
          draft(3, recapCreated()),
          draft(4, recapCreated()),
        ]);
        return rebuildProjections(tx, SESSION_ID);
      }),
    ).rejects.toThrow(/already has its recap/);
    expect((await rowsOf(db, SESSION_ID)).session[0]?.recap ?? null).toBeNull();
  });
});

describe("flushing Phase 5 events: v2 reviews, reopens, snoozes, and the seal", () => {
  const flush = (db: Db, expectedLastSeq: number, batch: Parameters<typeof appendEvents>[3]) =>
    withTenant(db, A, async (tx) => {
      await appendEvents(tx, SESSION_ID, expectedLastSeq, batch);
      return rebuildProjections(tx, SESSION_ID);
    });
  const opening = [
    draft(1, started()),
    draft(2, utterance(1)),
    draft(3, proposal(1)),
    draft(4, reviewV2(1, "edited")),
  ];

  it("stores a v2 review's handling time, and a reopen as proposed with its own seq", async () => {
    const db = await fresh();
    await flush(db, NO_EVENTS, opening);
    expect((await rowsOf(db, SESSION_ID)).proposals).toMatchObject([
      {
        status: "edited",
        editDiff: { title: { before: "Send the deck", after: "Send the revised deck" } },
        reviewerMs: 1500,
        reviewedSeq: 3,
        // Migration 0014's columns: what the inbox and Phase 6 query by.
        reviewId: uuid(7001),
        reviewMode: "single",
        batchId: null,
        policyId: null,
        syncEligibleAt: new Date("2026-11-10T19:16:30.000Z"),
        review: { reviewId: uuid(7001), decision: "edited", surface: "inbox", input: "keyboard" },
      },
    ]);

    const undo = reopen(1, uuid(7001), { timing: { decisionMs: 400, handlingMs: 600 } });
    const projections = await flush(db, 3, [
      draft(5, undo),
      draft(6, snoozed(1)),
      draft(7, ended()),
      draft(8, sealed()),
    ]);
    expect((await rowsOf(db, SESSION_ID)).proposals).toMatchObject([
      {
        status: "proposed",
        editDiff: null,
        reviewerMs: 600,
        reviewedSeq: 4,
        reviewedAt: new Date(tsFor(5)),
        reviewId: undo.payload.reviewId,
        reviewMode: "single",
        syncEligibleAt: null,
        snoozedUntil: new Date("2026-11-11T14:00:00.000Z"),
        review: { decision: "reopened", undoes: uuid(7001), reason: "undo" },
      },
    ]);
    expect(projections.session?.sealedAt).toBe("2026-11-10T19:16:40.000Z");
    expect(projections.proposals[0]?.snoozedUntil).toBe("2026-11-11T14:00:00.000Z");
    expect((await rowsOf(db, SESSION_ID)).session).toMatchObject([
      { sealedAt: new Date("2026-11-10T19:16:40.000Z") },
    ]);
    expect((await readProjections(db, SESSION_ID)).session).toEqual(projections.session);
    expect((await readProjections(db, SESSION_ID)).proposals).toEqual(projections.proposals);
  });

  it("stores a batch's id, a policy's id, and a correction's supersedes as the new status", async () => {
    const db = await fresh();
    // The correction links to `uuid(6001)`, as the v2 builders do: put it in A's mirror.
    await db.insert(crmEntities).values({
      id: uuid(6001),
      workspaceId: A.workspaceId,
      kind: "company",
      externalId: "c-akme",
      name: "Acme Dynamics",
    });
    const policy = { id: uuid(8801), version: 3, rule: "notes" };
    const correction = proposalV2(9, {}, { supersedes: uuid(3003) });
    const projections = await flush(db, NO_EVENTS, [
      draft(1, started()),
      draft(2, utterance(1)),
      draft(3, proposal(1)),
      draft(4, proposal(2)),
      draft(5, proposal(3)),
      draft(6, reviewV2(1, "approved", { mode: "batch", batchId: uuid(8701) })),
      draft(
        7,
        reviewV2(2, "approved", {
          mode: "policy",
          policy,
          by: { userId: "u_9fK2mQx7Lr", auth: null },
          input: "none",
          surface: "session",
          timing: { decisionMs: 0, handlingMs: 0 },
        }),
      ),
      draft(8, correction),
    ]);
    const rows = (await rowsOf(db, SESSION_ID)).proposals;
    expect(rows.map((row) => [row.status, row.reviewMode, row.batchId, row.policyId])).toEqual([
      ["approved", "batch", uuid(8701), null],
      ["approved", "policy", null, uuid(8801)],
      ["superseded", null, null, null],
      ["proposed", null, null, null],
    ]);
    expect(rows.map((row) => [row.supersedes, row.supersededBy])).toEqual([
      [null, null],
      [null, null],
      [null, uuid(3009)],
      [uuid(3003), null],
    ]);
    expect((await readProjections(db, SESSION_ID)).proposals).toEqual(projections.proposals);
  });

  it("rolls back a flush whose reopen doesn't name the latest review", async () => {
    const db = await fresh();
    await flush(db, NO_EVENTS, opening);
    await expect(flush(db, 3, [draft(5, reopen(1, uuid(7999)))])).rejects.toBeInstanceOf(
      ProjectionError,
    );
    expect(await new PgEventStore(db, A).read(SESSION_ID)).toHaveLength(4);
    expect((await rowsOf(db, SESSION_ID)).proposals).toMatchObject([{ status: "edited" }]);
  });
});

describe("tenant isolation for projections", () => {
  it("won't let B rebuild A's projections", async () => {
    const db = await fresh();
    await rebuild(db, demoSessionId);
    const before = await rowsOf(db, demoSessionId);
    await expect(rebuild(db, demoSessionId, B)).rejects.toBeInstanceOf(UnknownSessionError);
    expect(await rowsOf(db, demoSessionId)).toEqual(before);
  });
});
