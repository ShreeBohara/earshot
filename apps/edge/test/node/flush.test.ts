// The flush consumer against Postgres (spec WP7 tests, "Node with PGlite"): `flushBatch` with the
// real `postgresFlushStore` (withTenant → appendEvents → rebuildProjections) on PGlite with every
// migration and row-level security. Only the Queue and the Durable Object are faked.
import { fileURLToPath } from "node:url";
import {
  exportAuditChain,
  type ReviewPayload,
  schema,
  verifyAuditExport,
  withTenant,
  writeSessionReviews,
} from "@earshot/db";
import { type AuditSigner, loadAuditSigningKey } from "@earshot/keys/server";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type FlushDeps,
  flushBatch,
  postgresFlushStore,
  type QueueMessageLike,
  retryDelaySeconds,
  type SessionRpc,
} from "../../src/flush";
import type { FlushEvent, FlushMessage } from "../../src/flush-message";
import { createLogger } from "../../src/log";

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/db/migrations", import.meta.url),
);

const A = { userId: "user-a", workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const B = { userId: "user-b", workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
/** The committed development key, as `wrangler dev` signs with. */
let signer: AuditSigner;

beforeAll(async () => {
  const signing = await loadAuditSigningKey({}, { development: true });
  if (signing.status !== "development") throw new Error("no development signing key");
  signer = signing.signer;
  client = new PGlite({ extensions: { vector, pg_trgm } });
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  for (const tenant of [A, B]) {
    await db.insert(schema.user).values({
      id: tenant.userId,
      name: tenant.userId,
      email: `${tenant.userId}@example.test`,
    });
    await db.insert(schema.workspaces).values({ id: tenant.workspaceId, name: tenant.userId });
    await db.insert(schema.workspaceMembers).values({ ...tenant, role: "owner" });
  }
}, 60_000);

afterAll(async () => {
  await client.close();
});

let counter = 0;
/** A fresh lowercase UUID (UUIDv4 shape, from a counter, so tests stay readable). */
function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

/** A session row, as the web app's `POST /api/sessions` writes it before any flush. */
async function createSession(tenant = A): Promise<string> {
  const id = uuid();
  await db.insert(schema.sessions).values({ id, ...tenant, mode: "debrief", engine: "cascaded" });
  return id;
}

const TS = "2026-11-19T10:00:00.000Z";

/** A debrief's log, as SessionDO numbers it: start, an utterance, a proposal, usage, the end. */
function debrief(): FlushEvent[] {
  const utteranceId = uuid();
  const payloads: [string, number, Record<string, unknown>][] = [
    ["session.started", 1, { mode: "debrief", engine: "cascaded", providers: {}, startedAt: TS }],
    [
      "utterance.final",
      2,
      {
        utteranceId,
        text: "Send Dana the deck.",
        confidence: 0.9,
        startMs: 0,
        endMs: 1_500,
        witness: "biased",
      },
    ],
    [
      "proposal.created",
      1,
      {
        proposalId: uuid(),
        type: "task",
        targetEntityId: null,
        fields: {
          title: {
            value: "Send Dana the deck",
            evidence: { utteranceId, span: [0, 18], audioMs: [0, 1_500], confidence: 0.9 },
          },
        },
        riskFlags: [],
      },
    ],
    [
      "usage.recorded",
      1,
      {
        usageId: uuid(),
        kind: "llm",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        inputTokens: 1_500,
        outputTokens: 120,
        costUsd: 0.00021,
        priceTable: "2026-11-15",
      },
    ],
    ["session.ended", 1, { endedAt: "2026-11-19T10:02:00.000Z", costUsd: 0.00021 }],
  ];
  return payloads.map(([type, schemaVersion, payload], seq) => ({
    id: uuid(),
    seq,
    type,
    schemaVersion,
    ts: TS,
    payload,
  }));
}

function message(sessionId: string, events: FlushEvent[], tenant = A): FlushMessage {
  return {
    v: 1,
    sessionId,
    ...tenant,
    fromSeq: events[0]?.seq ?? 0,
    toSeq: events.at(-1)?.seq ?? 0,
    events,
  };
}

interface Delivery extends QueueMessageLike {
  acked: boolean;
  retried: { delaySeconds?: number } | undefined;
}

function delivery(body: unknown, attempts = 1): Delivery {
  const message: Delivery = {
    id: `m-${uuid()}`,
    body,
    attempts,
    acked: false,
    retried: undefined,
    ack() {
      message.acked = true;
    },
    retry(options) {
      message.retried = options ?? {};
    },
  };
  return message;
}

/** The session's Durable Object, faked: its copy of the log, and what Postgres confirmed. */
function fakeDo(log: FlushEvent[] = []) {
  const confirmed: number[] = [];
  let failConfirms = 0;
  const rpc: SessionRpc = {
    async readRange(fromSeq, toSeq) {
      return log.filter((event) => event.seq >= fromSeq && event.seq <= toSeq);
    },
    async confirmFlushed(seq) {
      if (failConfirms > 0) {
        failConfirms -= 1;
        throw new Error("the Durable Object is unreachable");
      }
      confirmed.push(seq);
    },
  };
  return {
    rpc,
    confirmed,
    failNextConfirm() {
      failConfirms += 1;
    },
  };
}

function deps(
  session: SessionRpc,
  deadLetters: unknown[] = [],
  lines: string[] = [],
  options: { signer?: AuditSigner | null } = {},
): FlushDeps {
  return {
    store: postgresFlushStore(db, {
      signer: options.signer === undefined ? signer : options.signer,
    }),
    session: () => session,
    deadLetter: async (body) => {
      deadLetters.push(body);
    },
    log: createLogger([], (line) => lines.push(line)),
  };
}

/** The session's stored events' ids, read as the owner. */
async function storedIds(sessionId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.sessionEvents.id })
    .from(schema.sessionEvents)
    .where(eq(schema.sessionEvents.sessionId, sessionId))
    .orderBy(asc(schema.sessionEvents.seq));
  return rows.map((row) => row.id);
}

describe("flushBatch on Postgres", () => {
  it("appends and rebuilds the projections in one transaction, then confirms and acks", async () => {
    const sid = await createSession();
    const events = debrief();
    const durable = fakeDo(events);
    const first = delivery(message(sid, events.slice(0, 3)));
    const second = delivery(message(sid, events.slice(3)));
    await flushBatch({ messages: [first, second] }, deps(durable.rpc));

    expect([first.acked, second.acked]).toEqual([true, true]);
    expect(durable.confirmed).toEqual([2, 4]);
    expect(await storedIds(sid)).toEqual(events.map((event) => event.id));
    const [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sid));
    expect(session?.endedAt?.toISOString()).toBe("2026-11-19T10:02:00.000Z");
    expect(session?.costUsd).toBe("0.0002");
    const utterances = await db
      .select()
      .from(schema.utterances)
      .where(eq(schema.utterances.sessionId, sid));
    expect(utterances.map((row) => row.text)).toEqual(["Send Dana the deck."]);
    const proposals = await db
      .select()
      .from(schema.proposals)
      .where(eq(schema.proposals.sessionId, sid));
    expect(proposals.map((row) => row.type)).toEqual(["task"]);
  });

  it("acks a duplicate delivery without storing anything twice", async () => {
    const sid = await createSession();
    const events = debrief();
    const durable = fakeDo(events);
    await flushBatch({ messages: [delivery(message(sid, events))] }, deps(durable.rpc));
    const again = delivery(message(sid, events));
    await flushBatch({ messages: [again] }, deps(durable.rpc));
    expect(again.acked).toBe(true);
    expect(await storedIds(sid)).toHaveLength(events.length);
    expect(durable.confirmed).toEqual([4, 4]);
  });

  it("recovers a lost acknowledgement: retries, then finds the events stored and confirms", async () => {
    const sid = await createSession();
    const events = debrief();
    const durable = fakeDo(events);
    durable.failNextConfirm();
    const first = delivery(message(sid, events));
    await flushBatch({ messages: [first] }, deps(durable.rpc));
    expect(first.acked).toBe(false);
    expect(first.retried).toEqual({ delaySeconds: 10 });
    expect(await storedIds(sid)).toHaveLength(events.length);

    const redelivered = delivery(message(sid, events), 2);
    await flushBatch({ messages: [redelivered] }, deps(durable.rpc));
    expect(redelivered.acked).toBe(true);
    expect(durable.confirmed).toEqual([4]);
  });

  it("repairs a gap from the Durable Object when a later range arrives first", async () => {
    const sid = await createSession();
    const events = debrief();
    const durable = fakeDo(events);
    const later = delivery(message(sid, events.slice(3)));
    await flushBatch({ messages: [later] }, deps(durable.rpc));
    expect(later.acked).toBe(true);
    expect(await storedIds(sid)).toEqual(events.map((event) => event.id));
    const earlier = delivery(message(sid, events.slice(0, 3)));
    await flushBatch({ messages: [earlier] }, deps(durable.rpc));
    expect(earlier.acked).toBe(true);
    expect(await storedIds(sid)).toHaveLength(events.length);
  });

  it("applies one batch's ranges in seq order, whatever order they arrive in", async () => {
    const sid = await createSession();
    const events = debrief();
    const durable = fakeDo([]); // no repair possible: the order has to be right
    const messages = [
      delivery(message(sid, events.slice(2))),
      delivery(message(sid, events.slice(0, 2))),
    ];
    await flushBatch({ messages }, deps(durable.rpc));
    expect(messages.map((m) => m.acked)).toEqual([true, true]);
    expect(await storedIds(sid)).toEqual(events.map((event) => event.id));
  });

  it("appends only the rest of a range that overlaps what Postgres has", async () => {
    const sid = await createSession();
    const events = debrief();
    const durable = fakeDo(events);
    await flushBatch({ messages: [delivery(message(sid, events.slice(0, 3)))] }, deps(durable.rpc));
    const overlapping = delivery(message(sid, events.slice(1)));
    await flushBatch({ messages: [overlapping] }, deps(durable.rpc));
    expect(overlapping.acked).toBe(true);
    expect(await storedIds(sid)).toEqual(events.map((event) => event.id));
  });

  it("refuses to ack when a second writer's events hold the seqs, and raises an alert", async () => {
    const sid = await createSession();
    const ours = debrief();
    const theirs = debrief();
    const durable = fakeDo(ours);
    await flushBatch({ messages: [delivery(message(sid, theirs.slice(0, 2)))] }, deps(durable.rpc));
    const lines: string[] = [];
    const conflicted = delivery(message(sid, ours.slice(0, 2)), 3);
    await flushBatch({ messages: [conflicted] }, deps(durable.rpc, [], lines));
    expect(conflicted.acked).toBe(false);
    expect(conflicted.retried).toEqual({ delaySeconds: retryDelaySeconds(3) });
    expect(lines.join("\n")).toContain(`error flush conflict {"sessionId":"${sid}","fromSeq":0}`);
    expect(await storedIds(sid)).toEqual(theirs.slice(0, 2).map((event) => event.id));
  });

  it("retries a session that has no row, with a growing delay, until the DLQ takes it", async () => {
    const sid = uuid(); // no sessions row
    const durable = fakeDo();
    for (const attempts of [1, 2, 5]) {
      const pending = delivery(message(sid, debrief()), attempts);
      await flushBatch({ messages: [pending] }, deps(durable.rpc));
      expect(pending.retried).toEqual({ delaySeconds: retryDelaySeconds(attempts) });
    }
    expect([1, 2, 3, 4, 5, 6].map(retryDelaySeconds)).toEqual([10, 20, 40, 80, 160, 300]);
  });

  it("dead-letters a batch the rebuild refuses, storing nothing, and a malformed message", async () => {
    const sid = await createSession();
    const [start] = debrief();
    if (!start) throw new Error("no start");
    const twoStarts = [start, { ...start, id: uuid(), seq: 1 }];
    const deadLetters: unknown[] = [];
    const refused = delivery(message(sid, twoStarts));
    const malformed = delivery({ v: 1, sessionId: sid, events: "nope" });
    await flushBatch({ messages: [refused, malformed] }, deps(fakeDo().rpc, deadLetters));
    expect([refused.acked, malformed.acked]).toEqual([true, true]);
    expect([refused.retried, malformed.retried]).toEqual([undefined, undefined]);
    expect(deadLetters).toEqual([refused.body, malformed.body]);
    expect(await storedIds(sid)).toEqual([]);
  });

  it("can't flush workspace B's message into workspace A's session", async () => {
    const sid = await createSession(A);
    const events = debrief();
    await flushBatch(
      { messages: [delivery(message(sid, events.slice(0, 2)))] },
      deps(fakeDo(events).rpc),
    );
    const intruder = delivery(message(sid, events.slice(2), B));
    await flushBatch({ messages: [intruder] }, deps(fakeDo(events).rpc));
    expect(intruder.acked).toBe(false);
    expect(intruder.retried).toBeDefined();
    expect(await storedIds(sid)).toEqual(events.slice(0, 2).map((event) => event.id));
    // Row-level security hid A's session from B's transaction: B saw no events at all.
    const visible = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role earshot_app`);
      await tx.execute(
        sql`select set_config('app.user_id', ${B.userId}, true), set_config('app.workspace_id', ${B.workspaceId}, true)`,
      );
      return tx.select().from(schema.sessionEvents).where(eq(schema.sessionEvents.sessionId, sid));
    });
    expect(visible).toEqual([]);
  });

  it("reads a range from the Durable Object when the message carries no events", async () => {
    const sid = await createSession();
    const events = debrief();
    const durable = fakeDo(events);
    const { events: _events, ...rangeOnly } = message(sid, events);
    const pending = delivery(rangeOnly);
    await flushBatch({ messages: [pending] }, deps(durable.rpc));
    expect(pending.acked).toBe(true);
    expect(await storedIds(sid)).toEqual(events.map((event) => event.id));
  });
});

// ─── Phase 5: review events, their audit rows, and the web Worker's writes after the seal ──────

const REVIEWER = { userId: A.userId, auth: { method: "passkey", signedInAt: TS } };

/** A `proposal.reviewed` v2 payload, as SessionDO fills the tray's: approved, by keyboard. */
function reviewPayload(proposalId: string, overrides: Record<string, unknown> = {}) {
  return {
    reviewId: uuid(),
    proposalId,
    decision: "approved",
    target: null,
    mode: "single",
    batchId: null,
    policy: null,
    undoes: null,
    reason: null,
    seen: { tier: "none", fields: {}, target: null, relinked: null, clip: "none" },
    timing: { decisionMs: 800, handlingMs: 950 },
    input: "keyboard",
    surface: "tray",
    syncEligibleAt: "2026-11-19T10:02:30.000Z",
    by: REVIEWER,
    ...overrides,
  };
}

/**
 * A reviewed debrief, as SessionDO numbers it: the debrief's start, utterance, and proposal; a
 * tray approval and a snooze of a second proposal; usage; the end; and the seal.
 */
function reviewedDebrief(): { events: FlushEvent[]; proposalId: string; secondId: string } {
  const [started, utterance, proposal, usage, ended] = debrief();
  if (!started || !utterance || !proposal || !usage || !ended) throw new Error("no debrief");
  const proposalId = proposal.payload.proposalId as string;
  const secondId = uuid();
  // Both name a record, so the writers' rules let them be approved.
  const linked = { ...proposal, payload: { ...proposal.payload, targetEntityId: "ct_045" } };
  const second = { ...linked, id: uuid(), payload: { ...linked.payload, proposalId: secondId } };
  const bodies: Omit<FlushEvent, "seq">[] = [
    started,
    utterance,
    linked,
    second,
    {
      id: uuid(),
      type: "proposal.reviewed",
      schemaVersion: 2,
      ts: TS,
      payload: reviewPayload(proposalId),
    },
    {
      id: uuid(),
      type: "proposal.snoozed",
      schemaVersion: 1,
      ts: TS,
      payload: { snoozeId: uuid(), proposalId: secondId, until: null, by: REVIEWER },
    },
    usage,
    ended,
    {
      id: uuid(),
      type: "session.sealed",
      schemaVersion: 1,
      ts: TS,
      payload: { sealedAt: "2026-11-19T10:03:00.000Z", by: "session" },
    },
  ];
  return { events: bodies.map((event, seq) => ({ ...event, seq })), proposalId, secondId };
}

async function auditRows() {
  return db.select().from(schema.auditLog).orderBy(asc(schema.auditLog.chainSeq));
}

async function checkpoints() {
  return db.select().from(schema.auditCheckpoints).orderBy(asc(schema.auditCheckpoints.chainSeq));
}

/** A fresh tenant per test, so each test's audit chain starts empty. */
async function freshTenant(): Promise<{ userId: string; workspaceId: string }> {
  const tenant = { userId: `user-${uuid()}`, workspaceId: uuid() };
  await db.insert(schema.user).values({
    id: tenant.userId,
    name: tenant.userId,
    email: `${tenant.userId}@example.test`,
  });
  await db.insert(schema.workspaces).values({ id: tenant.workspaceId, name: tenant.userId });
  await db.insert(schema.workspaceMembers).values({ ...tenant, role: "owner" });
  return tenant;
}

function forTenant(events: FlushEvent[], tenant: { userId: string }): FlushEvent[] {
  return events.map((event) =>
    event.type === "proposal.reviewed" || event.type === "proposal.snoozed"
      ? {
          ...event,
          payload: { ...event.payload, by: { ...REVIEWER, userId: tenant.userId } },
        }
      : event,
  );
}

describe("review events at flush: audit rows and a checkpoint", () => {
  it("writes an audit row per review event a message appends, in the session user's name, and one flush checkpoint", async () => {
    const tenant = await freshTenant();
    const sid = await createSession(tenant);
    const { events: raw, proposalId } = reviewedDebrief();
    const events = forTenant(raw, tenant);
    const pending = delivery(message(sid, events, tenant));
    await flushBatch({ messages: [pending] }, deps(fakeDo(events).rpc));
    expect(pending.acked).toBe(true);

    const rows = (await auditRows()).filter((row) => row.workspaceId === tenant.workspaceId);
    const review = events.find((event) => event.type === "proposal.reviewed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: tenant.userId,
      action: "proposal.approved",
      subjectType: "proposal",
      subjectId: proposalId,
      chainSeq: 1,
      detail: {
        sessionId: sid,
        eventId: review?.id,
        seq: review?.seq,
        reviewId: review?.payload.reviewId,
        mode: "single",
        batchId: null,
        policy: null,
        undoes: null,
        auth: REVIEWER.auth,
        surface: "tray",
        input: "keyboard",
      },
    });
    const stored = await withTenant(db, tenant, (tx) =>
      tx
        .select()
        .from(schema.sessionEvents)
        .where(eq(schema.sessionEvents.id, review?.id ?? "")),
    );
    expect(stored).toHaveLength(1);
    const ckpts = (await checkpoints()).filter((row) => row.workspaceId === tenant.workspaceId);
    expect(ckpts.map((row) => [row.chainSeq, row.request, row.kid])).toEqual([
      [1, "flush", signer.kid],
    ]);
    // The chain and its checkpoint verify offline, against the development key.
    const exported = await withTenant(db, tenant, (tx) => exportAuditChain(tx));
    const file = {
      format: "earshot.account-export",
      audit: { form: 1, keys: [signer.publicKey] },
      workspaces: [
        {
          id: tenant.workspaceId,
          tables: { audit_log: exported.entries, audit_checkpoints: exported.checkpoints },
        },
      ],
    };
    const verified = await verifyAuditExport(JSON.parse(JSON.stringify(file)), {
      allowDevelopmentKey: true,
    });
    expect(verified.problems).toEqual([]);
    expect(verified.ok).toBe(true);
  });

  it("audits an approval policy's auto-approval as proposal.auto_approved, naming the policy's id, version, and rule (Phase 5 WP11)", async () => {
    const tenant = await freshTenant();
    const sid = await createSession(tenant);
    const { events: raw, proposalId } = reviewedDebrief();
    const policy = { id: "01a1c6f2-7d10-7a3b-9c4d-5e6f7a8b9c0d", version: 3, rule: "notes" };
    // As SessionDO writes one: the session's user with no sign-in, no input, no time.
    const events = forTenant(raw, tenant).map((event) =>
      event.type === "proposal.reviewed"
        ? {
            ...event,
            payload: {
              ...event.payload,
              mode: "policy",
              policy,
              by: { userId: tenant.userId, auth: null },
              input: "none",
              surface: "session",
              timing: { decisionMs: 0, handlingMs: 0 },
            },
          }
        : event,
    );
    const pending = delivery(message(sid, events, tenant));
    await flushBatch({ messages: [pending] }, deps(fakeDo(events).rpc));
    expect(pending.acked).toBe(true);

    const review = events.find((event) => event.type === "proposal.reviewed");
    const rows = (await auditRows()).filter((row) => row.workspaceId === tenant.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: tenant.userId,
      action: "proposal.auto_approved",
      subjectType: "proposal",
      subjectId: proposalId,
      detail: {
        sessionId: sid,
        eventId: review?.id,
        reviewId: review?.payload.reviewId,
        mode: "policy",
        batchId: null,
        policy,
        undoes: null,
        auth: null,
        surface: "session",
        input: "none",
      },
    });
    const ckpts = (await checkpoints()).filter((row) => row.workspaceId === tenant.workspaceId);
    expect(ckpts.map((row) => row.request)).toEqual(["flush"]);
  });

  it("adds no audit rows on a redelivery that finds its events stored", async () => {
    const tenant = await freshTenant();
    const sid = await createSession(tenant);
    const events = forTenant(reviewedDebrief().events, tenant);
    const durable = fakeDo(events);
    await flushBatch({ messages: [delivery(message(sid, events, tenant))] }, deps(durable.rpc));
    const again = delivery(message(sid, events, tenant), 2);
    await flushBatch({ messages: [again] }, deps(durable.rpc));
    expect(again.acked).toBe(true);
    const ours = (rows: { workspaceId: string }[]) =>
      rows.filter((row) => row.workspaceId === tenant.workspaceId);
    expect(ours(await auditRows())).toHaveLength(1);
    expect(ours(await checkpoints())).toHaveLength(1);
  });

  it("audits the review events a gap repair reads from the Durable Object", async () => {
    const tenant = await freshTenant();
    const sid = await createSession(tenant);
    const events = forTenant(reviewedDebrief().events, tenant);
    // Only the last three events arrive; the review before them comes from the object.
    const later = delivery(message(sid, events.slice(6), tenant));
    await flushBatch({ messages: [later] }, deps(fakeDo(events).rpc));
    expect(later.acked).toBe(true);
    const rows = (await auditRows()).filter((row) => row.workspaceId === tenant.workspaceId);
    expect(rows.map((row) => row.action)).toEqual(["proposal.approved"]);
  });

  it("fails closed without a signing key: retries a message with reviews and stores none of it", async () => {
    const tenant = await freshTenant();
    const sid = await createSession(tenant);
    const events = forTenant(reviewedDebrief().events, tenant);
    const lines: string[] = [];
    // The first four events hold no review: they flush without a key.
    const plain = delivery(message(sid, events.slice(0, 4), tenant));
    await flushBatch({ messages: [plain] }, deps(fakeDo(events).rpc, [], lines, { signer: null }));
    expect(plain.acked).toBe(true);

    const reviewed = delivery(message(sid, events.slice(4), tenant));
    await flushBatch(
      { messages: [reviewed] },
      deps(fakeDo(events).rpc, [], lines, { signer: null }),
    );
    expect(reviewed.acked).toBe(false);
    expect(reviewed.retried).toEqual({ delaySeconds: 10 });
    expect(lines.join("\n")).toContain('"reason":"audit_unavailable"');
    expect(await storedIds(sid)).toEqual(events.slice(0, 4).map((event) => event.id));
    expect((await auditRows()).filter((row) => row.workspaceId === tenant.workspaceId)).toEqual([]);
  });
});

describe("the web Worker as the second writer", () => {
  it("acks a redelivered flush message after the web Worker's reviews, with no conflict", async () => {
    const tenant = await freshTenant();
    const sid = await createSession(tenant);
    const { events: raw, secondId } = reviewedDebrief();
    const events = forTenant(raw, tenant);
    const durable = fakeDo(events);
    const original = message(sid, events, tenant);
    await flushBatch({ messages: [delivery(original)] }, deps(durable.rpc));

    // Postgres holds the seal: the web Worker reviews the snoozed proposal.
    const written = await withTenant(db, tenant, (tx) =>
      writeSessionReviews(
        tx,
        sid,
        {
          reviews: [
            reviewPayload(secondId, {
              surface: "inbox",
              by: { ...REVIEWER, userId: tenant.userId },
            }) as unknown as ReviewPayload,
          ],
          snoozes: [],
        },
        { signer, now: new Date("2026-11-20T09:00:00.000Z"), newId: uuid },
      ),
    );
    expect(written).toMatchObject({ ok: true, lastSeq: events.length });

    // The flush message again, and its seal alone: both acked as committed, nothing conflicts.
    const lines: string[] = [];
    const redelivered = delivery(original, 2);
    const sealOnly = delivery(message(sid, events.slice(-1), tenant), 2);
    await flushBatch({ messages: [redelivered, sealOnly] }, deps(durable.rpc, [], lines));
    expect([redelivered.acked, sealOnly.acked]).toEqual([true, true]);
    expect(lines.join("\n")).not.toContain("flush conflict");
    const ids = await storedIds(sid);
    expect(ids).toHaveLength(events.length + 1);
    expect(ids.slice(0, events.length)).toEqual(events.map((event) => event.id));
    const rows = (await auditRows()).filter((row) => row.workspaceId === tenant.workspaceId);
    expect(rows.map((row) => row.detail.surface)).toEqual(["tray", "inbox"]);
    const ckpts = (await checkpoints()).filter((row) => row.workspaceId === tenant.workspaceId);
    expect(ckpts.map((row) => row.request)).toEqual(["flush", "review"]);
  });
});
