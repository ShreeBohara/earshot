import { companies, contacts, deals, toEntityRows } from "@earshot/demo-crm";
import { phoneticKeys } from "@earshot/understanding/names";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq, like } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFieldHistory, valueAt } from "../src/crm-history";
import {
  addDemoRecord,
  DEMO_CRM_ADDED_PREFIX,
  DEMO_CRM_EXTERNAL_ID_PREFIX,
  demoCrmStatus,
  demoMove,
  loadDemoCrm,
  moveDemoField,
  removeDemoCrm,
} from "../src/demo-crm";
import {
  auditLog,
  crmConnections,
  crmEntities,
  crmEntityChanges,
  facts,
  proposals,
} from "../src/schema";
import { type TenantContext, withTenant } from "../src/tenant";
import { A, B, cloneDb, rowId, seededDb } from "./db";

// The demo CRM is what a new workspace can load before it connects a real CRM, so its rows must
// satisfy the real crm_entities constraints (the kind check, external-key uniqueness) when the
// tenant role writes them, and removing it must leave every other row alone.

type Db = Awaited<ReturnType<typeof seededDb>>["db"];

const TOTAL = companies.length + contacts.length + deals.length;
const COUNTS = { companies: companies.length, contacts: contacts.length, deals: deals.length };

let template: PGlite;
let client: PGlite;
let db: Db;

beforeAll(async () => {
  ({ client: template } = await seededDb());
});

beforeEach(async () => {
  ({ client, db } = await cloneDb(template));
});

afterEach(async () => {
  await client.close();
});

const load = (tenant: TenantContext) => withTenant(db, tenant, (tx) => loadDemoCrm(tx));
const remove = (tenant: TenantContext) => withTenant(db, tenant, (tx) => removeDemoCrm(tx));
const status = (tenant: TenantContext) => withTenant(db, tenant, (tx) => demoCrmStatus(tx));

/** A workspace's crm_entities rows as its own tenant sees them, as sorted `kind:externalId`. */
async function entitiesSeenBy(tenant: TenantContext) {
  const rows = await withTenant(db, tenant, (tx) =>
    tx.select({ kind: crmEntities.kind, externalId: crmEntities.externalId }).from(crmEntities),
  );
  return rows.map((row) => `${row.kind}:${row.externalId}`).sort();
}

/** The workspace's demo_crm audit entries, as the owner sees them, sorted by action. */
async function demoAudit(workspaceId: string) {
  const rows = await db
    .select({
      action: auditLog.action,
      actorUserId: auditLog.actorUserId,
      subjectType: auditLog.subjectType,
      detail: auditLog.detail,
    })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), like(auditLog.action, "demo_crm.%")));
  return rows.sort((a, b) => a.action.localeCompare(b.action));
}

/** Every demo row in the database, as the owner sees it, by external id. */
async function demoRowsInDb() {
  const rows = await db
    .select({
      externalId: crmEntities.externalId,
      name: crmEntities.name,
      aliases: crmEntities.aliases,
      phoneticKeys: crmEntities.phoneticKeys,
      updatedAt: crmEntities.updatedAt,
    })
    .from(crmEntities)
    .where(like(crmEntities.externalId, `${DEMO_CRM_EXTERNAL_ID_PREFIX}%`));
  return rows.sort((a, b) => a.externalId.localeCompare(b.externalId));
}

const demoKeys = toEntityRows().map(
  (row) => `${row.kind}:${DEMO_CRM_EXTERNAL_ID_PREFIX}${row.externalId}`,
);

describe("loadDemoCrm", () => {
  it("loads every company, contact, and deal into the workspace, with no connection", async () => {
    expect(await load(A)).toEqual({ inserted: TOTAL, total: TOTAL });

    const rows = await db
      .select()
      .from(crmEntities)
      .where(like(crmEntities.externalId, `${DEMO_CRM_EXTERNAL_ID_PREFIX}%`));
    expect(rows).toHaveLength(TOTAL);
    expect(rows.every((row) => row.workspaceId === A.workspaceId)).toBe(true);
    expect(rows.every((row) => row.connectionId === null)).toBe(true);

    // The dataset's names, aliases, and properties arrive unchanged.
    const acme = companies.find((company) => company.name === "Acme Dynamics");
    const row = rows.find((r) => r.externalId === `${DEMO_CRM_EXTERNAL_ID_PREFIX}${acme?.id}`);
    expect(row).toMatchObject({
      kind: "company",
      name: "Acme Dynamics",
      aliases: acme?.aliases,
      properties: { domain: acme?.domain, industry: acme?.industry },
    });

    expect(await status(A)).toEqual({ loaded: TOTAL, total: TOTAL, counts: COUNTS });
    expect(await demoAudit(A.workspaceId)).toEqual([
      {
        action: "demo_crm.loaded",
        actorUserId: A.userId,
        subjectType: "demo_crm",
        detail: { inserted: TOTAL, total: TOTAL },
      },
    ]);
  });

  it("is idempotent: a second load inserts nothing and records nothing", async () => {
    await load(A);
    const before = await entitiesSeenBy(A);

    expect(await load(A)).toEqual({ inserted: 0, total: TOTAL });
    expect(await entitiesSeenBy(A)).toEqual(before);
    expect(await demoAudit(A.workspaceId)).toHaveLength(1);
  });

  it("fills in only what's missing after a partial load", async () => {
    await load(A);
    const [first] = toEntityRows();
    await db
      .delete(crmEntities)
      .where(eq(crmEntities.externalId, `${DEMO_CRM_EXTERNAL_ID_PREFIX}${first?.externalId}`));
    expect(await status(A)).toEqual({ loaded: TOTAL - 1, total: TOTAL, counts: COUNTS });

    expect(await load(A)).toEqual({ inserted: 1, total: TOTAL });
    expect(await status(A)).toEqual({ loaded: TOTAL, total: TOTAL, counts: COUNTS });
  });

  it("fills every row's phonetic keys from its name and aliases, as the name toolkit does", async () => {
    await load(A);

    const rows = await demoRowsInDb();
    expect(rows).toHaveLength(TOTAL);
    for (const row of rows) {
      expect(row.phoneticKeys.length, row.name).toBeGreaterThan(0);
      expect(row.phoneticKeys, row.name).toEqual(phoneticKeys([row.name, ...row.aliases]));
    }
    // Full-length codes, aliases included, and sound-alikes sharing a key.
    const keysOf = (name: string) => rows.find((row) => row.name === name)?.phoneticKeys;
    expect(keysOf("Meridian Supply Co")).toEqual(["MRTN", "MSK", "SPL"]);
    expect(keysOf("Knight Security")).toEqual(["NT", "SKRT"]);
    expect(keysOf("Nite Security Group")).toEqual(["KRP", "NT", "SKRT"]);
  });

  it("fills the keys of rows loaded before keys existed, once, from each row's own name", async () => {
    const ownKeys = () =>
      db
        .select({ phoneticKeys: crmEntities.phoneticKeys })
        .from(crmEntities)
        .where(eq(crmEntities.externalId, "hs-101"));
    const ownBefore = await ownKeys();
    await load(A);
    // As Phase 3 left them: the same rows, with no keys. One was renamed since.
    await db
      .update(crmEntities)
      .set({ phoneticKeys: [] })
      .where(like(crmEntities.externalId, `${DEMO_CRM_EXTERNAL_ID_PREFIX}%`));
    const [first] = toEntityRows();
    const renamed = `${DEMO_CRM_EXTERNAL_ID_PREFIX}${first?.externalId}`;
    await db
      .update(crmEntities)
      .set({ name: "Harbourview Hospital", aliases: [] })
      .where(eq(crmEntities.externalId, renamed));

    expect(await load(A)).toEqual({ inserted: 0, total: TOTAL });
    const filled = await demoRowsInDb();
    for (const row of filled) {
      expect(row.phoneticKeys, row.name).toEqual(phoneticKeys([row.name, ...row.aliases]));
    }
    expect(filled.find((row) => row.externalId === renamed)?.phoneticKeys).toEqual(
      phoneticKeys("Harbourview Hospital"),
    );

    // Idempotent: loading again changes no row, so no updated_at moves.
    expect(await load(A)).toEqual({ inserted: 0, total: TOTAL });
    expect(await demoRowsInDb()).toEqual(filled);
    // Filling keys isn't a load: the audit log still has the first load only.
    expect(await demoAudit(A.workspaceId)).toHaveLength(1);
    // Rows outside the demo CRM keep the keys they had (the seed gives A's HubSpot row its own).
    expect(await ownKeys()).toEqual(ownBefore);
  });

  it("loads into the acting workspace only; B sees nothing of A's demo CRM", async () => {
    await load(A);

    expect(await status(B)).toEqual({ loaded: 0, total: TOTAL, counts: COUNTS });
    expect(await entitiesSeenBy(B)).toEqual(["company:tw-201"]);
    expect(await demoAudit(B.workspaceId)).toEqual([]);

    // Each workspace gets its own copy: the external-key constraint is per workspace.
    expect(await load(B)).toEqual({ inserted: TOTAL, total: TOTAL });
    expect(await entitiesSeenBy(A)).toEqual(["company:hs-101", ...demoKeys].sort());
    expect(await entitiesSeenBy(B)).toEqual(["company:tw-201", ...demoKeys].sort());
  });

  it("refuses to run outside withTenant, where RLS wouldn't apply", async () => {
    await expect(db.transaction((tx) => loadDemoCrm(tx))).rejects.toThrow(/withTenant/);
    await expect(db.transaction((tx) => removeDemoCrm(tx))).rejects.toThrow(/withTenant/);
    await expect(db.transaction((tx) => demoCrmStatus(tx))).rejects.toThrow(/withTenant/);
    expect(await db.select({ id: crmEntities.id }).from(crmEntities)).toHaveLength(2);
  });
});

describe("removeDemoCrm", () => {
  it("removes the demo rows and nothing else", async () => {
    await load(A);
    // Look-alikes that aren't demo rows: one with no connection but the dataset's raw id (no
    // prefix), and one with the demo prefix that came from a CRM connection.
    await withTenant(db, A, (tx) =>
      tx.insert(crmEntities).values([
        {
          workspaceId: A.workspaceId,
          kind: "company",
          externalId: "co_001",
          name: "Typed in by hand",
        },
        {
          workspaceId: A.workspaceId,
          connectionId: rowId("a", 2),
          kind: "company",
          externalId: `${DEMO_CRM_EXTERNAL_ID_PREFIX}co_001`,
          name: "From HubSpot",
        },
      ]),
    );

    expect(await remove(A)).toEqual({ deleted: TOTAL });

    expect(await entitiesSeenBy(A)).toEqual(
      ["company:co_001", `company:${DEMO_CRM_EXTERNAL_ID_PREFIX}co_001`, "company:hs-101"].sort(),
    );
    expect(await status(A)).toEqual({ loaded: 0, total: TOTAL, counts: COUNTS });
    expect(await demoAudit(A.workspaceId)).toEqual([
      expect.objectContaining({ action: "demo_crm.loaded" }),
      {
        action: "demo_crm.removed",
        actorUserId: A.userId,
        subjectType: "demo_crm",
        detail: { deleted: TOTAL },
      },
    ]);
  });

  it("records nothing when there's nothing to remove, and never touches another workspace", async () => {
    await load(A);

    expect(await remove(B)).toEqual({ deleted: 0 });
    expect(await demoAudit(B.workspaceId)).toEqual([]);
    expect(await status(A)).toEqual({ loaded: TOTAL, total: TOTAL, counts: COUNTS });
    expect(await entitiesSeenBy(B)).toEqual(["company:tw-201"]);
  });

  it("takes facts about demo rows with it, and keeps proposals that targeted them", async () => {
    await load(A);
    const [target] = await withTenant(db, A, (tx) =>
      tx
        .select({ id: crmEntities.id })
        .from(crmEntities)
        .where(like(crmEntities.externalId, `${DEMO_CRM_EXTERNAL_ID_PREFIX}co_%`))
        .limit(1),
    );
    const entityId = target?.id ?? "";
    await withTenant(db, A, async (tx) => {
      await tx
        .insert(facts)
        .values({ workspaceId: A.workspaceId, entityId, key: "champion", value: "Dana Lee" });
      await tx
        .update(proposals)
        .set({ targetEntityId: entityId })
        .where(eq(proposals.id, rowId("a", 7)));
    });

    await remove(A);

    expect(await db.select().from(facts).where(eq(facts.entityId, entityId))).toEqual([]);
    const [proposal] = await db
      .select({ targetEntityId: proposals.targetEntityId })
      .from(proposals)
      .where(eq(proposals.id, rowId("a", 7)));
    expect(proposal).toEqual({ targetEntityId: null });
  });
});

// ─── The inbox's demo controls (Phase 5 WP12) ─────────────────────────────────────────────────────

/** A demo record of A's, by its dataset id, with its id and properties as the owner sees them. */
async function demoRecord(sourceId: string) {
  const [row] = await db
    .select({ id: crmEntities.id, properties: crmEntities.properties, name: crmEntities.name })
    .from(crmEntities)
    .where(
      and(
        eq(crmEntities.workspaceId, A.workspaceId),
        eq(crmEntities.externalId, `${DEMO_CRM_EXTERNAL_ID_PREFIX}${sourceId}`),
      ),
    );
  if (!row) throw new Error(`no demo record ${sourceId}`);
  return row;
}

const NOW = new Date("2026-11-25T09:00:00.000Z");

describe("demoMove", () => {
  it.each([
    ["stage", "appointmentscheduled", "qualifiedtobuy"],
    ["stage", "contractsent", "closedwon"],
    ["stage", "closedwon", "contractsent"],
    ["stage", "closedlost", "contractsent"],
    ["stage", "discovery", "qualifiedtobuy"],
    ["amount", 112_000, 123_200],
    ["amount", 8_005, 8_806],
    ["closeDate", "2027-03-22", "2027-03-29"],
    ["closeDate", "2026-12-28", "2027-01-04"],
    ["title", "General Manager", "VP of Sales"],
    ["title", "VP of Sales", "Director of Operations"],
    ["email", "dana.lee@acme-dynamics.example", "dana.lee2@acme-dynamics.example"],
    ["phone", "555-0145", "555-0146"],
    ["phone", "555-0199", "555-0100"],
  ] as const)("moves %s from %j to %j", (field, from, to) => {
    expect(demoMove(field, from)).toEqual(to);
  });

  it.each([
    ["stage", null],
    ["amount", "lots"],
    ["closeDate", "next week"],
    ["email", "nobody"],
    ["phone", "+1 415 555 0100"],
    ["title", null],
  ] as const)("can't move %s from %j", (field, from) => {
    expect(demoMove(field, from)).toBeUndefined();
  });
});

describe("moveDemoField", () => {
  it("moves the field and records its history in one transaction, with an audit entry", async () => {
    await load(A);
    const deal = await demoRecord("deal_028");
    const before = deal.properties.stage;

    const moved = await withTenant(db, A, (tx) =>
      moveDemoField(tx, { entityId: deal.id, field: "stage", now: NOW }),
    );
    expect(moved).toMatchObject({ entityId: deal.id, field: "stage", old: before });
    expect(moved?.new).toBe(demoMove("stage", before as string));
    expect((await demoRecord("deal_028")).properties).toMatchObject({ stage: moved?.new });
    const history = await withTenant(db, A, (tx) =>
      readFieldHistory(tx, [{ entityId: deal.id, field: "stage" }]),
    );
    expect([...history.values()].flat()).toEqual([
      { id: moved?.changeId, old: before, new: moved?.new, changedAt: NOW },
    ]);
    // The CRM's value when the rep spoke, before the move, and now.
    expect(
      await withTenant(db, A, (tx) =>
        valueAt(tx, deal.id, "stage", new Date("2026-11-20T00:00:00Z")),
      ),
    ).toBe(before);
    expect(await withTenant(db, A, (tx) => valueAt(tx, deal.id, "stage", NOW))).toBe(moved?.new);
    expect((await demoAudit(A.workspaceId)).map((entry) => entry.action)).toEqual([
      "demo_crm.changed",
      "demo_crm.loaded",
    ]);
    const [entry] = (await demoAudit(A.workspaceId)).filter((e) => e.action === "demo_crm.changed");
    expect(entry?.detail).toEqual({ entityId: deal.id, field: "stage" });
  });

  it("leaves neither the move nor its history when the transaction fails", async () => {
    await load(A);
    const deal = await demoRecord("deal_028");
    await expect(
      withTenant(db, A, async (tx) => {
        await moveDemoField(tx, { entityId: deal.id, field: "amount", now: NOW });
        throw new Error("the request failed after the move");
      }),
    ).rejects.toThrow(/after the move/);
    expect((await demoRecord("deal_028")).properties.amount).toBe(deal.properties.amount);
    expect(
      await db.select().from(crmEntityChanges).where(eq(crmEntityChanges.entityId, deal.id)),
    ).toEqual([]);
  });

  it("moves only the workspace's own demo records, and only fields it knows", async () => {
    await load(A);
    await load(B);
    const deal = await demoRecord("deal_028");
    const move = (tenant: TenantContext, entityId: string, field: string) =>
      withTenant(db, tenant, (tx) => moveDemoField(tx, { entityId, field, now: NOW }));
    // A record from a CRM connection isn't a demo record.
    expect(await move(A, rowId("a", 3), "stage")).toBeNull();
    // Another workspace can't move A's record, even by its id.
    expect(await move(B, deal.id, "stage")).toBeNull();
    // Only the fields a review card compares, and never the name or a made-up field.
    expect(await move(A, deal.id, "name")).toBeNull();
    expect(await move(A, deal.id, "properties")).toBeNull();
    expect(await move(A, deal.id, "title")).toBeNull();
    expect(await move(A, "not-a-uuid", "stage")).toBeNull();
    expect((await demoRecord("deal_028")).properties).toEqual(deal.properties);
    expect(
      await db.select().from(crmEntityChanges).where(eq(crmEntityChanges.entityId, deal.id)),
    ).toEqual([]);
  });
});

describe("addDemoRecord", () => {
  /** A's mirror as the demo CRM: the dataset loaded, and the seed's CRM connection gone. */
  async function demoWorkspace() {
    await db.delete(crmConnections).where(eq(crmConnections.workspaceId, A.workspaceId));
    await load(A);
  }
  const add = (
    tenant: TenantContext,
    record: { kind: "company" | "contact"; name: string; companyEntityId?: string | null },
  ) =>
    withTenant(db, tenant, (tx) =>
      addDemoRecord(tx, { ...record, newId: () => crypto.randomUUID(), now: NOW }),
    );

  it("adds a demo record, its arrival in the history, and an audit entry", async () => {
    await demoWorkspace();
    const acme = await demoRecord("co_001");
    const added = await add(A, {
      kind: "contact",
      name: "  Dana   Leigh ",
      companyEntityId: acme.id,
    });
    expect(added).toMatchObject({ kind: "contact", name: "Dana Leigh", added: true });
    const [row] = await db
      .select()
      .from(crmEntities)
      .where(eq(crmEntities.id, added?.entityId ?? ""));
    expect(row).toMatchObject({
      workspaceId: A.workspaceId,
      connectionId: null,
      kind: "contact",
      name: "Dana Leigh",
      properties: { companyId: "co_001", firstName: "Dana", lastName: "Leigh" },
    });
    expect(row?.externalId.startsWith(DEMO_CRM_ADDED_PREFIX)).toBe(true);
    expect(row?.phoneticKeys).toEqual(phoneticKeys(["Dana Leigh"]));
    // It had no name before it arrived.
    const nameAt = (iso: string) =>
      withTenant(db, A, (tx) => valueAt(tx, added?.entityId ?? "", "name", new Date(iso)));
    expect(await nameAt("2026-11-24T00:00:00Z")).toBeNull();
    expect(await nameAt("2026-11-26T00:00:00Z")).toBe("Dana Leigh");
    expect((await demoAudit(A.workspaceId)).map((entry) => entry.action)).toContain(
      "demo_crm.record_added",
    );
    // It isn't the dataset's, so the dataset still counts as loaded, exactly.
    expect(await status(A)).toEqual({ loaded: TOTAL, total: TOTAL, counts: COUNTS });
  });

  it("is idempotent by kind and name, and leaves off a company that isn't a demo company", async () => {
    await demoWorkspace();
    const first = await add(A, { kind: "company", name: "Atmo Systems" });
    const again = await add(A, { kind: "company", name: "atmo systems" });
    expect(again).toEqual({ ...first, name: "atmo systems", added: false });
    const contact = await add(A, {
      kind: "contact",
      name: "Pat Moss",
      companyEntityId: "a0000000-0000-4000-8000-0000000000ff",
    });
    const [row] = await db
      .select({ properties: crmEntities.properties })
      .from(crmEntities)
      .where(eq(crmEntities.id, contact?.entityId ?? ""));
    expect(row?.properties).toEqual({ firstName: "Pat", lastName: "Moss" });
  });

  it("adds nothing outside a demo workspace, or for a name it can't keep", async () => {
    // The seed's CRM connection is still there: A's mirror isn't the demo CRM's alone.
    await load(A);
    expect(await add(A, { kind: "company", name: "Atmo Systems" })).toBeNull();
    // B has no demo CRM at all.
    expect(await add(B, { kind: "company", name: "Atmo Systems" })).toBeNull();
    await db.delete(crmConnections).where(eq(crmConnections.workspaceId, A.workspaceId));
    expect(await add(A, { kind: "company", name: "   " })).toBeNull();
    expect(await add(A, { kind: "company", name: "x".repeat(201) })).toBeNull();
    expect(
      await add(A, { kind: "company", name: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }),
    ).toBeNull();
    expect(
      await add(A, { kind: "deal" as "company", name: "Atmo Systems - Expansion" }),
    ).toBeNull();
    const added = await db
      .select()
      .from(crmEntities)
      .where(like(crmEntities.externalId, `${DEMO_CRM_ADDED_PREFIX}%`));
    expect(added).toEqual([]);
  });

  it("goes with the demo CRM, history and all", async () => {
    await demoWorkspace();
    const added = await add(A, { kind: "company", name: "Atmo Systems" });
    await remove(A);
    expect(
      await db
        .select()
        .from(crmEntities)
        .where(eq(crmEntities.id, added?.entityId ?? "")),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(crmEntityChanges)
        .where(eq(crmEntityChanges.workspaceId, A.workspaceId)),
    ).toEqual([]);
  });
});
