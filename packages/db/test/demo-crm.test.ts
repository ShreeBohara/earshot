import { companies, contacts, deals, toEntityRows } from "@earshot/demo-crm";
import { describe, expect, it } from "vitest";
import { crmEntities } from "../src/schema";
import { type TenantContext, withTenant } from "../src/tenant";
import { A, B, seededDb } from "./db";

// The demo CRM is what a new workspace can load before it connects a real CRM, so its rows must
// satisfy the real crm_entities constraints (the kind check, external-key uniqueness) when the
// tenant role writes them.
describe("demo CRM", () => {
  it("loads into crm_entities as the tenant, and only into that workspace", async () => {
    const { db } = await seededDb();
    const rows = toEntityRows();
    expect(rows.length).toBe(companies.length + contacts.length + deals.length);

    await withTenant(db, A, (tx) =>
      tx.insert(crmEntities).values(rows.map((row) => ({ ...row, workspaceId: A.workspaceId }))),
    );

    const demoIds = new Set(rows.map((row) => row.externalId));
    const demoRowsSeenBy = async (tenant: TenantContext) => {
      const seen = await withTenant(db, tenant, (tx) =>
        tx.select({ externalId: crmEntities.externalId }).from(crmEntities),
      );
      return seen.map((row) => row.externalId).filter((id) => demoIds.has(id));
    };

    expect((await demoRowsSeenBy(A)).sort()).toEqual([...demoIds].sort());
    expect(await demoRowsSeenBy(B)).toEqual([]);
  });
});
