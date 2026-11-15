import type { PGlite } from "@electric-sql/pglite";
import { eq, getTableName, sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { createPoolDb } from "../src/client";
import { commitments, credentials } from "../src/schema";
import { TENANT_ROLE, tenantTables, withTenant } from "../src/tenant";
import { A, B, cloneDb, rowId, seededDb, tenantKey } from "./db";

type Db = Awaited<ReturnType<typeof seededDb>>["db"];

async function whoAmI(db: Db) {
  const { rows } = await db.execute<{ role: string; workspace: string | null }>(
    sql`select current_user as role, current_setting('app.workspace_id', true) as workspace`,
  );
  return rows[0];
}

describe("withTenant", () => {
  let template: PGlite;
  let db: Db;

  beforeAll(async () => {
    ({ client: template } = await seededDb());
  });

  // Each test gets its own copy of the seeded database, so writes don't leak between tests.
  beforeEach(async () => {
    ({ db } = await cloneDb(template));
  });

  afterEach(async () => {
    await db.$client.close();
  });

  it("shows A only its own rows in every tenant table", async () => {
    for (const table of tenantTables) {
      const key = tenantKey(table);
      const owner = await db.select({ key }).from(table);
      const tenant = await withTenant(db, A, (tx) => tx.select({ key }).from(table));

      expect(owner, `${getTableName(table)} as the owner`).toHaveLength(2);
      expect(tenant, `${getTableName(table)} as A`).toEqual([{ key: A.workspaceId }]);
    }
  });

  it("returns nothing for B's ids, even when asked for them directly", async () => {
    const rows = await withTenant(db, A, (tx) =>
      tx
        .select()
        .from(credentials)
        .where(eq(credentials.id, rowId("b", 1))),
    );
    expect(rows).toEqual([]);
  });

  it("rejects a write into B", async () => {
    const error = await withTenant(db, A, (tx) =>
      tx.insert(commitments).values({ workspaceId: B.workspaceId, owner: "rep", text: "Hijack" }),
    ).catch((e: unknown) => e);

    // Drizzle wraps the driver's error; the Postgres message is its cause.
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).cause)).toMatch(
      /new row violates row-level security policy for table "commitments"/,
    );
  });

  it("runs as earshot_app with both settings, and leaves the connection as it found it", async () => {
    const inside = await withTenant(db, A, async (tx) => {
      const { rows } = await tx.execute<{ role: string; user: string; workspace: string }>(
        sql`select current_user as role, current_setting('app.user_id') as user,
                   current_setting('app.workspace_id') as workspace`,
      );
      return rows[0];
    });
    expect(inside).toEqual({ role: TENANT_ROLE, user: A.userId, workspace: A.workspaceId });

    // SET LOCAL and set_config(…, true) end with the transaction; the setting reverts to empty,
    // which the policies treat like a missing one.
    expect(await whoAmI(db)).toEqual({ role: "postgres", workspace: "" });
  });

  it("rolls back and resets when the callback throws", async () => {
    const failing = withTenant(db, A, async (tx) => {
      await tx
        .insert(commitments)
        .values({ workspaceId: A.workspaceId, owner: "rep", text: "Lost" });
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");

    expect(await db.select().from(commitments).where(eq(commitments.text, "Lost"))).toEqual([]);
    expect(await whoAmI(db)).toEqual({ role: "postgres", workspace: "" });
  });

  it("round-trips encrypted bytes through the bytea columns", async () => {
    const ciphertext = new Uint8Array([0, 1, 2, 250, 255]);
    const stored = await withTenant(db, A, async (tx) => {
      const [row] = await tx
        .insert(credentials)
        .values({
          workspaceId: A.workspaceId,
          provider: "deepgram",
          ciphertext,
          iv: new Uint8Array(12),
          wrappedDek: new Uint8Array(40),
          dekIv: new Uint8Array(12),
          last4: "9f2c",
        })
        .returning();
      return row;
    });
    expect(stored?.ciphertext).toEqual(ciphertext);
    expect(stored?.iv).toHaveLength(12);
  });

  it("accepts the production pool database", () => {
    // Compile time only: Neon's pool database must fit withTenant's types. Nothing connects.
    const scoped = (url: string) =>
      withTenant(createPoolDb(url), A, (tx) => tx.select().from(credentials));
    expectTypeOf(scoped).returns.resolves.toBeArray();
  });

  it("refuses a malformed context before touching the database", async () => {
    let called = false;
    const run = async () => {
      called = true;
    };
    await expect(withTenant(db, { userId: A.userId, workspaceId: "nope" }, run)).rejects.toThrow(
      TypeError,
    );
    await expect(withTenant(db, { userId: "", workspaceId: A.workspaceId }, run)).rejects.toThrow(
      TypeError,
    );
    expect(called).toBe(false);
  });
});
