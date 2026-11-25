// The demo CRM's store over Postgres (Phase 6 WP2): the conformance suite on the demo adapter with
// `createDemoStore`, through PGlite and row-level security, against the same golden plans and
// requests as `@earshot/crm`'s run in memory; then what the store promises beyond the suite: the
// history a write leaves, all in the caller's transaction, and nothing but the transaction's
// workspace's demo rows.
import { fileURLToPath } from "node:url";
import { demoConformanceOptions, runConformance } from "@earshot/crm/conformance";
import {
  DEMO_STAGES,
  type DemoActivity,
  type DemoActivityKind,
  type DemoRecordKind,
  type DemoValue,
  demoAdapter,
  demoFetch,
} from "@earshot/crm/demo";
import { type DemoRaw, demoHarness } from "@earshot/crm/testing";
import { DEAL_STAGES } from "@earshot/demo-crm";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_CRM_EXTERNAL_ID_PREFIX } from "../src/demo-crm";
import { createDemoStore, toDemoRecord } from "../src/demo-store";
import { crmDemoActivities, crmEntities, crmEntityChanges } from "../src/schema";
import { withTenant } from "../src/tenant";
import { A, B, cloneDb, rowId, seededDb } from "./db";

type Db = Awaited<ReturnType<typeof seededDb>>["db"];

const GOLDEN = fileURLToPath(new URL("../../crm/test/golden/demo/", import.meta.url));
const MARKER = "es_oxmttwqjbgqfzongy4te";
const OTHER = "es_c6smbbo5tyzkd4jsongl";

/** A clock that moves 1 ms each time it's read, so every write is later than the last. */
function ticking(start = "2026-11-25T12:00:00.000Z") {
  let at = Date.parse(start);
  return () => {
    at += 1;
    return new Date(at);
  };
}

const ENTITY = {
  id: crmEntities.id,
  kind: crmEntities.kind,
  externalId: crmEntities.externalId,
  name: crmEntities.name,
  properties: crmEntities.properties,
  updatedAt: crmEntities.updatedAt,
};

/** One of A's demo rows, by kind and demo id. */
const demoRowOf = (kind: DemoRecordKind, id: string) =>
  and(
    eq(crmEntities.workspaceId, A.workspaceId),
    eq(crmEntities.kind, kind),
    eq(crmEntities.externalId, `${DEMO_CRM_EXTERNAL_ID_PREFIX}${id}`),
  );

// ─── The conformance suite, on Postgres ──────────────────────────────────────────────────────

describe("the demo adapter on Postgres", () => {
  let suiteDb: Db;
  const now = ticking();
  let made = 0;
  const tenant = <T>(work: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
    withTenant(suiteDb, A, work);

  const activityOf = async (where: ReturnType<typeof and>): Promise<DemoActivity[]> => {
    const rows = await tenant((tx) =>
      tx
        .select({
          id: crmDemoActivities.id,
          kind: crmDemoActivities.kind,
          writeId: crmDemoActivities.writeId,
          body: crmDemoActivities.body,
          dueAt: crmDemoActivities.dueAt,
          startsAt: crmDemoActivities.startsAt,
          createdAt: crmDemoActivities.createdAt,
          recordKind: crmEntities.kind,
          recordExternalId: crmEntities.externalId,
        })
        .from(crmDemoActivities)
        .innerJoin(crmEntities, eq(crmEntities.id, crmDemoActivities.entityId))
        .where(where),
    );
    return rows.map((row) => ({
      kind: row.kind as DemoActivityKind,
      id: row.id,
      record: {
        kind: row.recordKind as DemoRecordKind,
        id: row.recordExternalId.slice(DEMO_CRM_EXTERNAL_ID_PREFIX.length),
      },
      writeId: row.writeId,
      body: row.body,
      dueAt: row.dueAt?.toISOString() ?? null,
      startsAt: row.startsAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  };

  /** A CRM user's hands on A's demo rows, through row-level security, outside the adapter. */
  const raw: DemoRaw = {
    async insert(kind, name, properties) {
      made += 1;
      const prefix = kind === "company" ? "co" : kind === "contact" ? "ct" : "deal";
      const [row] = await tenant((tx) =>
        tx
          .insert(crmEntities)
          .values({
            workspaceId: A.workspaceId,
            connectionId: null,
            kind,
            externalId: `${DEMO_CRM_EXTERNAL_ID_PREFIX}${prefix}_t${String(made).padStart(4, "0")}`,
            name,
            properties: { ...properties },
            updatedAt: now(),
          })
          .returning(ENTITY),
      );
      if (!row) throw new Error("the fixture wasn't written");
      return toDemoRecord(row);
    },
    read: (kind, id) => tenant((tx) => createDemoStore(tx).record(kind, id)),
    async withWriteId(kind, writeId) {
      const rows = await tenant((tx) =>
        tx
          .select(ENTITY)
          .from(crmEntities)
          .where(
            and(
              eq(crmEntities.workspaceId, A.workspaceId),
              eq(crmEntities.kind, kind),
              sql`${crmEntities.properties} ->> 'writeId' = ${writeId}`,
            ),
          ),
      );
      return rows.map(toDemoRecord);
    },
    activitiesWithWriteId: (kind, writeId) =>
      activityOf(and(eq(crmDemoActivities.kind, kind), eq(crmDemoActivities.writeId, writeId))),
    async activity(kind, id) {
      const [found] = await activityOf(
        and(eq(crmDemoActivities.kind, kind), eq(crmDemoActivities.id, id)),
      );
      return found ?? null;
    },
    async update(kind, id, properties: Readonly<Record<string, DemoValue>>) {
      const { name, ...rest } = properties;
      const [row] = await tenant((tx) =>
        tx
          .update(crmEntities)
          .set({
            ...(typeof name === "string" ? { name } : {}),
            properties: sql`${crmEntities.properties} || ${JSON.stringify(rest)}::jsonb`,
            updatedAt: now(),
          })
          .where(demoRowOf(kind, id))
          .returning(ENTITY),
      );
      if (!row) throw new Error(`no demo ${kind} ${id}`);
      return toDemoRecord(row);
    },
    async remove(kind, id) {
      await tenant((tx) => tx.delete(crmEntities).where(demoRowOf(kind, id)));
    },
  };

  runConformance(
    () => demoAdapter,
    demoHarness({
      async setup() {
        ({ db: suiteDb } = await seededDb());
      },
      async teardown() {
        await suiteDb?.$client.close();
      },
      // One transaction a request, as the tenant, so a lost answer is one the database committed.
      context: () => ({
        connection: { id: null, accountId: A.workspaceId, apiBase: "demo:" },
        fetch: (request) =>
          tenant((tx) => demoFetch(createDemoStore(tx, { now }), { pageSize: 3 })(request)),
      }),
      raw,
    }),
    demoConformanceOptions(GOLDEN, { name: "the demo CRM, on Postgres" }),
  );
});

// ─── What the store promises beyond the suite ────────────────────────────────────────────────

let template: PGlite;
let db: Db;

beforeAll(async () => {
  ({ client: template } = await seededDb());
});

beforeEach(async () => {
  ({ db } = await cloneDb(template));
  // A demo company and deal in A, B's demo company, and a row in A with neither a connection nor
  // the demo prefix, all as the owner.
  await db.insert(crmEntities).values([
    {
      workspaceId: A.workspaceId,
      kind: "company",
      externalId: "demo:co_001",
      name: "Acme",
      properties: {},
      updatedAt: new Date("2026-11-25T10:00:00.000Z"),
    },
    {
      workspaceId: A.workspaceId,
      kind: "deal",
      externalId: "demo:deal_001",
      name: "Acme renewal",
      properties: { stage: "appointmentscheduled", amount: 30_000, companyId: "co_001" },
      updatedAt: new Date("2026-11-25T10:00:01.000Z"),
    },
    {
      workspaceId: B.workspaceId,
      kind: "company",
      externalId: "demo:co_001",
      name: "Atlas",
      properties: {},
    },
    {
      workspaceId: A.workspaceId,
      kind: "company",
      externalId: "plain-1",
      name: "Plain",
      properties: {},
    },
  ]);
});

afterEach(async () => {
  await db.$client.close();
});

const history = () =>
  db
    .select({
      entityId: crmEntityChanges.entityId,
      field: crmEntityChanges.field,
      old: crmEntityChanges.old,
      new: crmEntityChanges.new,
      source: crmEntityChanges.source,
      changedAt: crmEntityChanges.changedAt,
    })
    .from(crmEntityChanges)
    // Leaving out the seed's own history: one change in each workspace.
    .where(notInArray(crmEntityChanges.id, [rowId("a", 14), rowId("b", 14)]));

describe("createDemoStore", () => {
  it("makes a demo row with its marker, its phonetic keys, and its arrival in the history", async () => {
    const at = new Date("2026-11-25T15:00:00.000Z");
    const result = await withTenant(db, A, (tx) =>
      createDemoStore(tx, {
        now: () => at,
        newId: () => "0190aaaa-0000-7000-8000-000000000001",
      }).upsertRecord({
        kind: "contact",
        name: "Priya Raman",
        properties: { firstName: "Priya", lastName: "Raman", companyId: "co_001" },
        writeId: MARKER,
      }),
    );
    expect(result).toEqual({
      created: true,
      record: {
        kind: "contact",
        id: "added:0190aaaa-0000-7000-8000-000000000001",
        name: "Priya Raman",
        properties: { firstName: "Priya", lastName: "Raman", companyId: "co_001", writeId: MARKER },
        updatedAt: at.toISOString(),
      },
    });
    const [row] = await db
      .select()
      .from(crmEntities)
      .where(eq(crmEntities.externalId, "demo:added:0190aaaa-0000-7000-8000-000000000001"));
    expect(row).toMatchObject({ workspaceId: A.workspaceId, connectionId: null, kind: "contact" });
    expect(row?.phoneticKeys.length).toBeGreaterThan(0);
    expect(await history()).toEqual([
      {
        entityId: row?.id,
        field: "name",
        old: null,
        new: "Priya Raman",
        source: "sync",
        changedAt: at,
      },
    ]);

    // The same marker again finds it, and changes nothing.
    const again = await withTenant(db, A, (tx) =>
      createDemoStore(tx).upsertRecord({
        kind: "contact",
        name: "Priya R",
        properties: {},
        writeId: MARKER,
      }),
    );
    expect(again).toEqual({ created: false, record: result.record });
    expect(await history()).toHaveLength(1);
  });

  it("records each field an update changes, and nothing for one that stays", async () => {
    const updated = await withTenant(db, A, (tx) =>
      createDemoStore(tx).updateRecord("deal", "deal_001", {
        stage: "contractsent",
        amount: 30_000,
        closeDate: "2026-12-15",
      }),
    );
    expect(updated?.properties).toMatchObject({
      stage: "contractsent",
      amount: 30_000,
      closeDate: "2026-12-15",
      companyId: "co_001",
    });
    expect((await history()).map(({ field, old, new: value }) => [field, old, value])).toEqual([
      ["stage", "appointmentscheduled", "contractsent"],
      ["closeDate", null, "2026-12-15"],
    ]);
  });

  it("writes nothing when its transaction fails", async () => {
    await expect(
      withTenant(db, A, async (tx) => {
        const store = createDemoStore(tx);
        await store.upsertRecord({
          kind: "company",
          name: "Northwind",
          properties: {},
          writeId: MARKER,
        });
        await store.updateRecord("deal", "deal_001", { stage: "closedwon" });
        throw new Error("the step failed");
      }),
    ).rejects.toThrow("the step failed");
    expect(await history()).toEqual([]);
    expect(await db.select().from(crmEntities).where(eq(crmEntities.name, "Northwind"))).toEqual(
      [],
    );
  });

  it("puts an activity on a demo record once, and none on a record that isn't one", async () => {
    const activity = {
      kind: "note" as const,
      record: { kind: "deal" as const, id: "deal_001" },
      writeId: OTHER,
      body: `Met the CFO.\n\nvia Earshot · ref ${OTHER}`,
      dueAt: null,
      startsAt: null,
    };
    const first = await withTenant(db, A, (tx) => createDemoStore(tx).upsertActivity(activity));
    expect(first).toMatchObject({
      created: true,
      activity: { kind: "note", record: { kind: "deal", id: "deal_001" }, writeId: OTHER },
    });
    const second = await withTenant(db, A, (tx) => createDemoStore(tx).upsertActivity(activity));
    expect(second).toEqual({ created: false, activity: first?.activity });
    expect(
      await withTenant(db, A, (tx) => createDemoStore(tx).activityByWriteId("note", OTHER)),
    ).toEqual(first?.activity);
    const elsewhere = await withTenant(db, A, (tx) =>
      createDemoStore(tx).upsertActivity({
        ...activity,
        writeId: MARKER,
        record: { kind: "company", id: "plain-1" },
      }),
    );
    expect(elsewhere).toBeNull();
  });

  it("sees only the workspace's demo rows: not a connection's, not one without the prefix, not another workspace's", async () => {
    const store = (work: (s: ReturnType<typeof createDemoStore>) => Promise<unknown>) =>
      withTenant(db, A, (tx) => work(createDemoStore(tx)));
    // A's HubSpot row (external id hs-101) and A's row without the prefix.
    expect(await store((s) => s.record("company", "hs-101"))).toBeNull();
    expect(await store((s) => s.record("company", "plain-1"))).toBeNull();
    expect(
      await store((s) => s.updateRecord("company", "plain-1", { name: "Renamed" })),
    ).toBeNull();
    // B's demo company shares A's id, and stays B's.
    expect(await store((s) => s.record("company", "co_001"))).toMatchObject({ name: "Acme" });
    const changed = await withTenant(db, B, (tx) =>
      createDemoStore(tx).record("company", "co_001"),
    );
    expect(changed).toMatchObject({ name: "Atlas" });
    const [plain] = await db
      .select()
      .from(crmEntities)
      .where(eq(crmEntities.externalId, "plain-1"));
    expect(plain?.name).toBe("Plain");
    // A's HubSpot row is untouched by a demo write.
    const [hubspot] = await db
      .select()
      .from(crmEntities)
      .where(eq(crmEntities.id, rowId("a", 3)));
    expect(hubspot?.name).toBe("Acme");
  });

  it("finds a contact by email whatever its case, and pages changes by time then id", async () => {
    await withTenant(db, A, (tx) =>
      createDemoStore(tx, { now: () => new Date("2026-11-25T16:00:00.000Z") }).upsertRecord({
        kind: "contact",
        name: "Dana Lee",
        properties: { email: "Dana.Lee@Acme.example" },
        writeId: MARKER,
      }),
    );
    expect(
      await withTenant(db, A, (tx) => createDemoStore(tx).contactByEmail("dana.lee@acme.EXAMPLE")),
    ).toMatchObject({ name: "Dana Lee" });
    const all = await withTenant(db, A, (tx) => createDemoStore(tx).changes(null, 10));
    expect(all.map((record) => record.name)).toEqual(["Acme", "Acme renewal", "Dana Lee"]);
    const [first, second] = all;
    if (!first || !second) throw new Error("expected two records");
    const after = await withTenant(db, A, (tx) =>
      createDemoStore(tx).changes({ at: first.updatedAt, id: first.id }, 10),
    );
    expect(after.map((record) => record.name)).toEqual(["Acme renewal", "Dana Lee"]);
  });

  it("refuses a transaction that isn't a tenant's", async () => {
    await expect(
      db.transaction((tx) => createDemoStore(tx).record("company", "co_001")),
    ).rejects.toThrow(/createDemoStore must run in a transaction from withTenant/);
  });
});

describe("the demo adapter's stages", () => {
  it("are the demo dataset's, in its order", () => {
    expect(DEMO_STAGES.map((stage) => stage.stageId)).toEqual([...DEAL_STAGES]);
  });
});
