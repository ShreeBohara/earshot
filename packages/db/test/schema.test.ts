import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  auditLog,
  credentials,
  crmConnections,
  crmEntities,
  facts,
  proposals,
  sessionEvents,
  sessions,
  user,
  workspaceMembers,
  workspaces,
} from "../src/schema";
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

  it("requires each event's envelope id, unique within its session", async () => {
    const { db } = await seededDb();

    // Drizzle's insert type already demands an id; the database refuses a missing one too.
    const missing = await db
      .execute(
        sql`insert into session_events (workspace_id, session_id, seq, type, schema_version, payload, ts)
            values (${A.workspaceId}, ${rowId("a", 4)}, 1, 'session.ended', 1, '{}', now())`,
      )
      .catch((e: unknown) => e);
    expect(String((missing as Error).cause)).toMatch(/null value in column "id"/);

    const duplicate = await db
      .insert(sessionEvents)
      .values({
        id: rowId("a", 5), // the id of the session's seeded event
        workspaceId: A.workspaceId,
        sessionId: rowId("a", 4),
        seq: 1,
        type: "session.ended",
        schemaVersion: 1,
        payload: {},
        ts: new Date(),
      })
      .catch((e: unknown) => e);
    expect(String((duplicate as Error).cause)).toMatch(/session_events_session_id_id_unique/);
  });

  it("deletes a member's sessions with their membership, but keeps their audit entries", async () => {
    const { db } = await seededDb();
    await db
      .delete(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, A.workspaceId), eq(workspaceMembers.userId, A.userId)),
      );

    expect(await db.select().from(sessions).where(eq(sessions.workspaceId, A.workspaceId))).toEqual(
      [],
    );
    expect(
      await db.select().from(sessionEvents).where(eq(sessionEvents.workspaceId, A.workspaceId)),
    ).toEqual([]);
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.id, rowId("a", 11)));
    expect(entry).toMatchObject({ workspaceId: A.workspaceId, actorUserId: null });
  });

  it("removes a deleted user's memberships and sessions, and clears them from the audit log", async () => {
    const { db } = await seededDb();
    await db.delete(user).where(eq(user.id, A.userId));

    expect(
      await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, A.userId)),
    ).toEqual([]);
    expect(await db.select().from(sessions).where(eq(sessions.userId, A.userId))).toEqual([]);
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.id, rowId("a", 11)));
    expect(entry?.actorUserId).toBeNull();
    // The workspace and the rest of its data stay: deleting it is a separate, deliberate step.
    expect(
      await db.select().from(credentials).where(eq(credentials.workspaceId, A.workspaceId)),
    ).toHaveLength(1);
  });
});
