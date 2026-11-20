// Reviews in Postgres (Phase 5 WP3): the audit rows and checkpoint for review events, the web
// Worker's write after the seal, the repair path's seal, the sessions it asks about, and the
// sample-session importer. On PGlite with every migration and row-level security.
import { type EventDraft, fromJsonl, NO_EVENTS, toJsonl } from "@earshot/events";
import {
  draft,
  ended,
  proposalV2,
  readFixture,
  reviewV2,
  sealed,
  snoozed,
  started,
  usageRecorded,
  utterance,
  uuid,
} from "@earshot/events/testing";
import { type AuditSigner, loadAuditSigningKey } from "@earshot/keys/server";
import type { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadDemoCrm } from "../src/demo-crm";
import { appendEvents, PgEventStore, readEvents } from "../src/event-store";
import { importSessionLog } from "../src/import-session";
import { rebuildProjections } from "../src/projections";
import {
  AuditUnavailableError,
  eventSha256,
  type ReviewPayload,
  recordReviewAudit,
  reviewAuditAction,
  sealSessionLog,
  unsealedSessions,
  writeSessionReviews,
} from "../src/reviews";
import { auditCheckpoints, auditLog, crmEntities, proposals, sessions } from "../src/schema";
import { withTenant } from "../src/tenant";
import { A, B, cloneDb, migratedDb } from "./db";
import { createTenant } from "./tenants";

type Db = Awaited<ReturnType<typeof migratedDb>>["db"];

const S1 = uuid(0x5e01);
const S2 = uuid(0x5e02);
const S3 = uuid(0x5e03);
const SB = uuid(0x5eb0);
const NOW = new Date("2026-11-20T12:00:00.000Z");

let template: PGlite;
let signer: AuditSigner;
const opened: PGlite[] = [];

beforeAll(async () => {
  const signing = await loadAuditSigningKey({}, { development: true });
  if (signing.status !== "development") throw new Error("no development key");
  signer = signing.signer;
  const { client, db } = await migratedDb();
  await createTenant(db, A, [S1, S2, S3]);
  await createTenant(db, B, [SB]);
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

let ids = 0x9000;
const newId = () => {
  ids += 1;
  return uuid(ids);
};

/** A debrief with two proposals, ended; `seal` adds the seal. */
function debrief(seal: boolean): EventDraft[] {
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

/**
 * The same events with ids no other session's share: utterance and proposal ids are unique across
 * sessions, and the builders' ids are fixed.
 */
function distinct(events: EventDraft[], k: number): EventDraft[] {
  return JSON.parse(
    JSON.stringify(events).replaceAll("00000000-0000-7000-8000-", `0000000${k}-0000-7000-8000-`),
  );
}

async function seed(db: Db, sessionId: string, events: EventDraft[], tenant = A) {
  await withTenant(db, tenant, async (tx) => {
    await appendEvents(tx, sessionId, NO_EVENTS, events);
    await rebuildProjections(tx, sessionId);
  });
}

/** A review the inbox would send, completed as the route completes it. */
function inboxReview(n: number, overrides: Record<string, unknown> = {}): ReviewPayload {
  return reviewV2(n, "approved", { reviewId: newId(), ...overrides }).payload as ReviewPayload;
}

const write = (
  db: Db,
  sessionId: string,
  request: Parameters<typeof writeSessionReviews>[2],
  tenant = A,
  withSigner: AuditSigner | null = signer,
) =>
  withTenant(db, tenant, (tx) =>
    writeSessionReviews(tx, sessionId, request, { signer: withSigner, now: NOW, newId }),
  );

describe("audit rows for review events", () => {
  it("names each review's action, and a policy's approval as auto_approved", () => {
    expect(reviewAuditAction({ decision: "approved", mode: "single" })).toBe("proposal.approved");
    expect(reviewAuditAction({ decision: "approved", mode: "batch" })).toBe("proposal.approved");
    expect(reviewAuditAction({ decision: "approved", mode: "policy" })).toBe(
      "proposal.auto_approved",
    );
    expect(reviewAuditAction({ decision: "edited", mode: "single" })).toBe("proposal.edited");
    expect(reviewAuditAction({ decision: "rejected", mode: "batch" })).toBe("proposal.rejected");
    expect(reviewAuditAction({ decision: "reopened", mode: "system" })).toBe("proposal.reopened");
  });

  it("hashes the event's canonical JSONL line", async () => {
    const db = await fresh();
    await seed(db, S1, [...debrief(true), draft(8, reviewV2(1, "approved"))]);
    const events = await withTenant(db, A, (tx) => readEvents(tx, S1));
    const review = events.at(-1);
    if (!review) throw new Error("no review");
    const line = toJsonl([review]).slice(0, -1);
    const expected = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(line)),
    ).toString("hex");
    expect(await eventSha256(review)).toBe(expected);
  });

  it("records a row per review event and one checkpoint, and nothing for snoozes or other events", async () => {
    const db = await fresh();
    await seed(db, S1, debrief(true));
    const result = await withTenant(db, A, async (tx) => {
      const appended = await appendEvents(tx, S1, 6, [
        draft(8, reviewV2(1, "edited")),
        draft(9, snoozed(2)),
        draft(10, reviewV2(2, "rejected", { reviewId: uuid(7102) })),
      ]);
      return recordReviewAudit(tx, signer, appended, "review", NOW);
    });
    expect(result?.checkpoint).toMatchObject({ request: "review", seq: 2, kid: signer.kid });
    const rows = await db.select().from(auditLog).orderBy(asc(auditLog.chainSeq));
    expect(rows.map((row) => [row.action, row.subjectId, row.actorUserId])).toEqual([
      ["proposal.edited", uuid(3001), A.userId],
      ["proposal.rejected", uuid(3002), A.userId],
    ]);
    expect(rows[0]?.detail).toMatchObject({
      sessionId: S1,
      seq: 7,
      reviewId: uuid(7001),
      mode: "single",
      batchId: null,
      policy: null,
      undoes: null,
      auth: { method: "passkey", signedInAt: "2026-11-10T19:00:00.000Z" },
      surface: "inbox",
      input: "keyboard",
    });
    expect(await db.select().from(auditCheckpoints)).toHaveLength(1);
  });

  it("writes nothing for a batch without reviews, and refuses reviews without a signer", async () => {
    const db = await fresh();
    await seed(db, S1, debrief(true));
    const none = await withTenant(db, A, async (tx) => {
      const appended = await appendEvents(tx, S1, 6, [draft(8, snoozed(1))]);
      return recordReviewAudit(tx, null, appended, "flush");
    });
    expect(none).toBeNull();
    const refused = withTenant(db, A, async (tx) => {
      const appended = await appendEvents(tx, S1, 7, [draft(9, reviewV2(2, "rejected"))]);
      return recordReviewAudit(tx, null, appended, "flush");
    });
    await expect(refused).rejects.toBeInstanceOf(AuditUnavailableError);
    // The transaction rolled back: the review isn't stored either.
    expect(await new PgEventStore(db, A).read(S1)).toHaveLength(8);
    expect(await db.select().from(auditLog)).toEqual([]);
  });
});

describe("writeSessionReviews", () => {
  it("refuses a session that isn't sealed, even once it has ended, and writes nothing", async () => {
    const db = await fresh();
    await seed(db, S1, debrief(false));
    const [row] = await db.select().from(sessions).where(eq(sessions.id, S1));
    expect(row?.endedAt).not.toBeNull();
    expect(await write(db, S1, { reviews: [inboxReview(1)], snoozes: [] })).toEqual({
      ok: false,
      reason: "not_sealed",
    });
    expect(await new PgEventStore(db, A).read(S1)).toHaveLength(6);
  });

  it("appends reviews and snoozes after the seal, rebuilds, and writes the audit rows last", async () => {
    const db = await fresh();
    await seed(db, S1, debrief(true));
    const review = inboxReview(1);
    const snooze = snoozed(2, "2026-11-21T09:00:00.000Z", { snoozeId: newId() }).payload;
    const outcome = await write(db, S1, {
      reviews: [review],
      snoozes: [snooze as never],
    });
    expect(outcome).toMatchObject({
      ok: true,
      reviews: [{ id: review.reviewId, seq: 7, recorded: "now" }],
      snoozes: [{ id: snooze.snoozeId, seq: 8, recorded: "now" }],
      lastSeq: 8,
      checkpoint: { request: "review" },
    });
    const rows = await db.select().from(proposals).orderBy(asc(proposals.seq));
    expect(
      rows.map((row) => [row.status, row.reviewId, row.snoozedUntil?.toISOString() ?? null]),
    ).toEqual([
      ["approved", review.reviewId, null],
      ["proposed", null, "2026-11-21T09:00:00.000Z"],
    ]);
    const audit = await db.select().from(auditLog);
    expect(audit.map((row) => [row.action, row.subjectId])).toEqual([
      ["proposal.approved", uuid(3001)],
    ]);
  });

  it("is idempotent by review id and snooze id: a resend writes nothing more", async () => {
    const db = await fresh();
    await seed(db, S1, debrief(true));
    const review = inboxReview(1);
    const snooze = snoozed(2, null, { snoozeId: newId() }).payload as never;
    await write(db, S1, { reviews: [review], snoozes: [snooze] });
    const again = await write(db, S1, { reviews: [review], snoozes: [snooze] });
    expect(again).toMatchObject({
      ok: true,
      reviews: [{ seq: 7, recorded: "before" }],
      snoozes: [{ seq: 8, recorded: "before" }],
      lastSeq: 8,
      checkpoint: null,
    });
    expect(await new PgEventStore(db, A).read(S1)).toHaveLength(9);
    expect(await db.select().from(auditLog)).toHaveLength(1);
    expect(await db.select().from(auditCheckpoints)).toHaveLength(1);
    // A review id reused for another proposal is refused.
    const reused = await write(db, S1, {
      reviews: [inboxReview(2, { reviewId: review.reviewId })],
      snoozes: [],
    });
    expect(reused).toMatchObject({ ok: false, reason: "refused", refusal: "malformed" });
  });

  it("refuses one write id on two items in a request, even both new, and writes nothing", async () => {
    const db = await fresh();
    await seed(db, S1, debrief(true));
    const shared = newId();
    expect(
      await write(db, S1, {
        reviews: [],
        snoozes: [
          snoozed(1, null, { snoozeId: shared }).payload as never,
          snoozed(2, null, { snoozeId: shared }).payload as never,
        ],
      }),
    ).toMatchObject({
      ok: false,
      reason: "refused",
      kind: "snooze",
      index: 1,
      refusal: "malformed",
    });
    expect(
      await write(db, S1, {
        reviews: [inboxReview(1, { reviewId: shared })],
        snoozes: [snoozed(2, null, { snoozeId: shared }).payload as never],
      }),
    ).toMatchObject({
      ok: false,
      reason: "refused",
      kind: "snooze",
      index: 0,
      refusal: "malformed",
    });
    // Nothing reached the log: it holds the seeded events alone.
    expect(await new PgEventStore(db, A).read(S1)).toHaveLength(7);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("says which item broke a rule: stale decisions, and malformed requests", async () => {
    const db = await fresh();
    await seed(db, S1, debrief(true));
    await write(db, S1, { reviews: [inboxReview(1)], snoozes: [] });
    expect(
      await write(db, S1, { reviews: [inboxReview(2), inboxReview(1)], snoozes: [] }),
    ).toMatchObject({
      ok: false,
      reason: "refused",
      kind: "review",
      index: 1,
      refusal: "not_proposed",
    });
    expect(
      await write(db, S1, {
        reviews: [inboxReview(2)],
        snoozes: [snoozed(2, null, { snoozeId: newId() }).payload as never],
      }),
    ).toMatchObject({ ok: false, reason: "refused", kind: "snooze", refusal: "malformed" });
    // A batch takes only unmarked proposals: proposal 1 carries a flag.
    expect(
      await write(db, S1, {
        reviews: [inboxReview(2, { mode: "batch", batchId: newId() })],
        snoozes: [],
      }),
    ).toMatchObject({ ok: true });
    expect(await new PgEventStore(db, A).read(S1)).toHaveLength(9);
  });

  it("fails closed on reviews without a signer, and takes snoozes without one", async () => {
    const db = await fresh();
    await seed(db, S1, debrief(true));
    expect(await write(db, S1, { reviews: [inboxReview(1)], snoozes: [] }, A, null)).toEqual({
      ok: false,
      reason: "audit_unavailable",
    });
    const snoozeOnly = await write(
      db,
      S1,
      { reviews: [], snoozes: [snoozed(1, null, { snoozeId: newId() }).payload as never] },
      A,
      null,
    );
    expect(snoozeOnly).toMatchObject({ ok: true, checkpoint: null });
  });

  it("can't reach another workspace's session", async () => {
    const db = await fresh();
    await seed(db, SB, debrief(true), B);
    expect(await write(db, SB, { reviews: [inboxReview(1)], snoozes: [] })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await new PgEventStore(db, B).read(SB)).toHaveLength(7);
  });
});

describe("the repair path", () => {
  it("seals a log that never ended: session.ended at its last event's time, then the seal by web", async () => {
    const db = await fresh();
    await seed(db, S1, debrief(false).slice(0, 5));
    const outcome = await withTenant(db, A, (tx) => sealSessionLog(tx, S1, { now: NOW, newId }));
    expect(outcome).toBe("sealed");
    const events = await new PgEventStore(db, A).read(S1);
    expect(events.slice(-2).map((event) => [event.type, event.payload])).toEqual([
      ["session.ended", { endedAt: "2026-11-10T19:15:05.000Z", costUsd: 0.0003 }],
      ["session.sealed", { sealedAt: NOW.toISOString(), by: "web" }],
    ]);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, S1));
    expect(row?.sealedAt?.toISOString()).toBe(NOW.toISOString());
    expect(row?.endedAt?.toISOString()).toBe("2026-11-10T19:15:05.000Z");
  });

  it("seals an ended log, and leaves a sealed, empty, or missing one alone", async () => {
    const db = await fresh();
    await seed(db, S1, debrief(false));
    await seed(db, S2, distinct(debrief(true), 2));
    const seal = (sessionId: string, tenant = A) =>
      withTenant(db, tenant, (tx) => sealSessionLog(tx, sessionId, { now: NOW, newId }));
    expect(await seal(S1)).toBe("sealed");
    expect((await new PgEventStore(db, A).read(S1)).at(-1)?.type).toBe("session.sealed");
    expect(await seal(S1)).toBe("already_sealed");
    expect(await seal(S2)).toBe("already_sealed");
    expect(await seal(S3)).toBe("empty");
    expect(await seal(SB)).toBe("not_found");
  });

  it("asks about the user's sessions that ended a while ago, or never ended, without a seal", async () => {
    const db = await fresh();
    await seed(db, S1, debrief(false)); // ended 2026-11-10, no seal
    await seed(db, S2, distinct(debrief(true), 2)); // sealed
    await seed(db, S3, distinct(debrief(false).slice(0, 4), 3)); // never ended, started 2026-11-10
    await seed(db, SB, distinct(debrief(false), 4), B); // B's
    const ask = (endedBefore: Date, startedBefore: Date) =>
      withTenant(db, A, (tx) => unsealedSessions(tx, { endedBefore, startedBefore, limit: 20 }));
    // Oldest first: S3 started before S1 ended.
    expect(await ask(NOW, NOW)).toEqual([S3, S1]);
    // Ended too recently, and started too recently.
    expect(await ask(new Date("2026-11-10T00:00:00Z"), new Date("2026-11-10T00:00:00Z"))).toEqual(
      [],
    );
    expect(
      await withTenant(db, A, (tx) =>
        unsealedSessions(tx, { endedBefore: NOW, startedBefore: NOW, limit: 1 }),
      ),
    ).toHaveLength(1);
  });
});

describe("importSessionLog", () => {
  const acme = readFixture("samples/acme-dynamics.jsonl");
  const pier = readFixture("samples/pier-logistics.jsonl");

  it("loads a sample sealed, with fresh ids, its records mapped to the workspace's demo CRM", async () => {
    const db = await fresh();
    await withTenant(db, A, (tx) => loadDemoCrm(tx));
    const result = await withTenant(db, A, (tx) =>
      importSessionLog(tx, acme, { mapDemoIds: true, now: NOW }),
    );
    expect(result).toMatchObject({ created: true, proposals: 4 });
    const original = fromJsonl(acme);
    expect(result.sessionId).not.toBe(original[0]?.sessionId);
    const events = await new PgEventStore(db, A).read(result.sessionId);
    expect(events.at(-1)).toMatchObject({
      type: "session.sealed",
      payload: { sealedAt: NOW.toISOString(), by: "import" },
    });
    expect(events).toHaveLength(original.length + 1);
    const [demoDana] = await db
      .select({ id: crmEntities.id })
      .from(crmEntities)
      .where(eq(crmEntities.externalId, "demo:ct_045"));
    const rows = await db
      .select()
      .from(proposals)
      .where(eq(proposals.sessionId, result.sessionId))
      .orderBy(asc(proposals.seq));
    expect(rows[0]?.targetEntityId).toBe(demoDana?.id);
    expect(rows.every((row) => row.status === "proposed")).toBe(true);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, result.sessionId));
    expect(session).toMatchObject({ userId: A.userId, sealedAt: NOW });
  });

  it("finds a sample loaded before and adds nothing, and gives each workspace its own ids", async () => {
    const db = await fresh();
    const first = await withTenant(db, A, (tx) => importSessionLog(tx, pier));
    const again = await withTenant(db, A, (tx) => importSessionLog(tx, pier));
    expect(again).toMatchObject({ sessionId: first.sessionId, created: false });
    const other = await withTenant(db, B, (tx) => importSessionLog(tx, pier));
    expect(other.created).toBe(true);
    expect(other.sessionId).not.toBe(first.sessionId);
    const proposalIds = await db
      .select({ id: proposals.id, sessionId: proposals.sessionId })
      .from(proposals);
    const mine = proposalIds
      .filter((row) => row.sessionId === first.sessionId)
      .map((row) => row.id);
    const theirs = proposalIds
      .filter((row) => row.sessionId === other.sessionId)
      .map((row) => row.id);
    expect(mine).toHaveLength(3);
    expect(mine.some((id) => theirs.includes(id))).toBe(false);
    // Without the demo CRM, records stay as the file names them, linked to nothing in the mirror.
    const rows = await db.select().from(proposals).where(eq(proposals.sessionId, first.sessionId));
    expect(rows.every((row) => row.targetEntityId === null)).toBe(true);
  });

  it("refuses a log that doesn't replay, writing nothing", async () => {
    const db = await fresh();
    const broken = `${toJsonl(fromJsonl(pier).slice(1))}`;
    await expect(withTenant(db, A, (tx) => importSessionLog(tx, broken))).rejects.toThrow();
    expect(await db.select().from(sessions).where(eq(sessions.userId, A.userId))).toHaveLength(3);
  });
});
