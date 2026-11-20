import { companies, contacts, deals, toEntityRows } from "@earshot/demo-crm";
import { phoneticKeys } from "@earshot/understanding/names";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq, like } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_CRM_EXTERNAL_ID_PREFIX,
  demoCrmStatus,
  loadDemoCrm,
  removeDemoCrm,
} from "../src/demo-crm";
import { auditLog, crmEntities, facts, proposals } from "../src/schema";
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
