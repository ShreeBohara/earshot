import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { crmConnections, crmEntities, facts, proposals, workspaces } from "../src/schema";
import { tenantTables } from "../src/tenant";
import { A, B, rowId, seededDb, tenantKey } from "./db";

// How the schema behaves for the owner (no RLS): deletes, cascades, and uniqueness.
describe("schema", () => {
  it("deletes every row of a workspace along with it, and none of another's", async () => {
    const { db } = await seededDb();
    await db.delete(workspaces).where(eq(workspaces.id, A.workspaceId));

    for (const table of tenantTables) {
      expect(await db.select({ key: tenantKey(table) }).from(table)).toEqual([
        { key: B.workspaceId },
      ]);
    }
  });

  it("clears a proposal's target, but not its workspace, when the entity is deleted", async () => {
    const { db } = await seededDb();
    // Deleting the connection cascades to its mirrored entities, and from them to their facts.
    await db.delete(crmConnections).where(eq(crmConnections.id, rowId("a", 2)));

    expect(
      await db.select().from(crmEntities).where(eq(crmEntities.workspaceId, A.workspaceId)),
    ).toEqual([]);
    expect(await db.select().from(facts).where(eq(facts.workspaceId, A.workspaceId))).toEqual([]);
    const [proposal] = await db
      .select()
      .from(proposals)
      .where(eq(proposals.id, rowId("a", 7)));
    expect(proposal).toMatchObject({ workspaceId: A.workspaceId, targetEntityId: null });
  });

  it("treats entities without a connection as one namespace for external ids", async () => {
    const { db } = await seededDb();
    const demo = { workspaceId: A.workspaceId, kind: "company", externalId: "demo-acme" };
    await db.insert(crmEntities).values({ ...demo, name: "Acme" });

    const duplicate = await db
      .insert(crmEntities)
      .values({ ...demo, name: "Akme" })
      .catch((e: unknown) => e);
    expect(String((duplicate as Error).cause)).toMatch(/crm_entities_external_key_unique/);
  });
});
