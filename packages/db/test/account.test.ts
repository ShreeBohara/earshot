import type { PGlite } from "@electric-sql/pglite";
import { and, eq, getTableName, sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildAccountExport,
  deleteSoleMemberWorkspaces,
  ensureWorkspace,
  personalWorkspaceName,
} from "../src/account";
import {
  account,
  auditLog,
  passkey,
  session,
  user,
  verification,
  workspaceMembers,
  workspaces,
} from "../src/schema";
import { resolveWorkspace, tenantTables } from "../src/tenant";
import { A, B, cloneDb, rowId, seededDb, tenantKey } from "./db";

type Db = Awaited<ReturnType<typeof seededDb>>["db"];

let template: PGlite;
let db: Db;

beforeAll(async () => {
  ({ client: template } = await seededDb());
});

beforeEach(async () => {
  ({ db } = await cloneDb(template));
});

afterEach(async () => {
  await db.$client.close();
});

/** Secret values seeded for both users. None of them may appear in any export. */
function canaries(tenant: "a" | "b") {
  return {
    accessToken: `gho_CANARY_ACCESS_${tenant}`,
    refreshToken: `ghr_CANARY_REFRESH_${tenant}`,
    idToken: `eyJ.CANARY_ID_TOKEN_${tenant}`,
    password: `$scrypt$CANARY_PASSWORD_${tenant}`,
    sessionToken: `CANARY_SESSION_TOKEN_${tenant}`,
    publicKey: `CANARY_PASSKEY_PUBLIC_KEY_${tenant}`,
    verification: `CANARY_VERIFICATION_${tenant}`,
  };
}

async function seedAuthSecrets(tenant: "a" | "b") {
  const userId = tenant === "a" ? A.userId : B.userId;
  const secret = canaries(tenant);
  await db.insert(account).values({
    id: `account-${tenant}`,
    accountId: `gh-${tenant}`,
    providerId: "github",
    userId,
    accessToken: secret.accessToken,
    refreshToken: secret.refreshToken,
    idToken: secret.idToken,
    password: secret.password,
    updatedAt: new Date(),
  });
  await db.insert(session).values({
    id: `session-${tenant}`,
    token: secret.sessionToken,
    userId,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    updatedAt: new Date(),
    userAgent: "Vitest",
  });
  await db.insert(passkey).values({
    id: `passkey-${tenant}`,
    name: "Laptop",
    publicKey: secret.publicKey,
    userId,
    credentialID: `credential-${tenant}`,
    counter: 0,
    deviceType: "multiDevice",
    backedUp: true,
  });
  await db.insert(verification).values({
    id: `verification-${tenant}`,
    identifier: `magic-link:${secret.verification}`,
    value: secret.verification,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
  });
}

describe("personalWorkspaceName", () => {
  it("uses the first name when there is one", () => {
    expect(personalWorkspaceName("Ada Archer")).toBe("Ada's workspace");
    expect(personalWorkspaceName("")).toBe("Personal");
    expect(personalWorkspaceName("   ")).toBe("Personal");
    expect(personalWorkspaceName(null)).toBe("Personal");
  });
});

describe("ensureWorkspace", () => {
  it("creates one personal workspace with the user as owner, then reuses it", async () => {
    await db.insert(user).values({ id: "user-c", name: "Cy Cole", email: "cy@c.example" });

    const first = await ensureWorkspace(db, { id: "user-c", name: "Cy Cole" });
    const second = await ensureWorkspace(db, { id: "user-c", name: "Cy Cole" });

    expect(first.created).toBe(true);
    expect(second).toEqual({ workspaceId: first.workspaceId, created: false });
    expect(
      await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, "user-c")),
    ).toEqual([
      expect.objectContaining({ workspaceId: first.workspaceId, userId: "user-c", role: "owner" }),
    ]);
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, first.workspaceId));
    expect(workspace?.name).toBe("Cy's workspace");
  });

  it("creates exactly one workspace when called concurrently", async () => {
    await db.insert(user).values({ id: "user-c", name: "", email: "cy@c.example" });

    const results = await Promise.all(
      Array.from({ length: 4 }, () => ensureWorkspace(db, { id: "user-c" })),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.workspaceId)).size).toBe(1);
    expect(await resolveWorkspace(db, "user-c")).toBe(results[0]?.workspaceId);
  });

  it("returns the existing workspace of a user who has one", async () => {
    expect(await ensureWorkspace(db, { id: A.userId })).toEqual({
      workspaceId: A.workspaceId,
      created: false,
    });
  });

  it("fails rather than invent a member for a user who doesn't exist", async () => {
    await expect(ensureWorkspace(db, { id: "no-such-user" })).rejects.toThrow();
    // The transaction rolled back: no orphan workspace was left behind.
    expect(await db.select({ id: workspaces.id }).from(workspaces)).toHaveLength(2);
  });
});

describe("buildAccountExport", () => {
  it("holds every tenant table's rows for A's workspace and nothing of B's", async () => {
    await seedAuthSecrets("a");
    await seedAuthSecrets("b");

    const exported = await buildAccountExport(db, A.userId, new Date("2026-11-16T12:00:00Z"));
    const json = JSON.stringify(exported);

    expect(exported.user).toMatchObject({ id: A.userId, email: "ada@a.test" });
    expect(exported.workspaces.map((w) => w.id)).toEqual([A.workspaceId]);
    const tables = exported.workspaces[0]?.tables ?? {};
    for (const table of tenantTables) {
      const rows = tables[getTableName(table)];
      expect(rows, getTableName(table)).toBeDefined();
      expect(rows?.length, getTableName(table)).toBeGreaterThan(0);
    }

    // Nothing of B's: no ids, names, emails, or text.
    for (const value of [
      B.userId,
      B.workspaceId,
      "Bo Baker",
      "bo@b.test",
      "Workspace B",
      "Atlas",
      "Sam Ortiz",
      "Called Sam",
      ...Array.from({ length: 12 }, (_, i) => rowId("b", i + 1)),
    ]) {
      expect(json, `B's ${value} leaked`).not.toContain(value);
    }

    // No secrets of either user.
    for (const value of [...Object.values(canaries("a")), ...Object.values(canaries("b"))]) {
      expect(json, `secret ${value} leaked`).not.toContain(value);
    }
  });

  it("leaves out tokens, password hashes, and envelope-encrypted columns", async () => {
    await seedAuthSecrets("a");
    const exported = await buildAccountExport(db, A.userId);
    const tables = exported.workspaces[0]?.tables ?? {};

    expect(Object.keys(tables.credentials?.[0] ?? {}).sort()).toEqual(
      ["createdAt", "label", "last4", "provider", "validatedAt"].sort(),
    );
    expect(tables.credentials?.[0]).toMatchObject({ provider: "openai", last4: "aaaa" });
    for (const row of [...(tables.credentials ?? []), ...(tables.crm_connections ?? [])]) {
      for (const column of ["ciphertext", "iv", "wrappedDek", "dekIv"]) {
        expect(row).not.toHaveProperty(column);
      }
    }
    expect(exported.accounts).toEqual([
      expect.objectContaining({ providerId: "github", accountId: "gh-a" }),
    ]);
    for (const column of ["accessToken", "refreshToken", "idToken", "password"]) {
      expect(exported.accounts[0]).not.toHaveProperty(column);
    }
    expect(exported.signInSessions[0]).not.toHaveProperty("token");
    expect(exported.passkeys[0]).not.toHaveProperty("publicKey");
    expect(exported.passkeys[0]).toMatchObject({ name: "Laptop" });

    // Every value survives JSON: no byte arrays or bigints sneak in.
    const roundTrip = JSON.parse(JSON.stringify(exported));
    expect(roundTrip.workspaces[0].tables.crm_entities[0].embedding).toHaveLength(512);
  });

  it("includes the event log and the projection columns rebuilt from it", async () => {
    const exported = await buildAccountExport(db, A.userId);
    const tables = exported.workspaces[0]?.tables ?? {};

    expect(tables.session_events).toEqual([
      expect.objectContaining({
        id: rowId("a", 5),
        type: "utterance.final",
        payload: { text: "Met Dana Lee at Acme." },
      }),
    ]);
    expect(Object.keys(tables.session_events?.[0] ?? {})).toEqual(
      expect.arrayContaining(["ts", "tsText"]),
    );
    expect(Object.keys(tables.utterances?.[0] ?? {})).toEqual(expect.arrayContaining(["ts"]));
    expect(Object.keys(tables.proposals?.[0] ?? {})).toEqual(
      expect.arrayContaining(["seq", "reviewedSeq", "reviewedAt", "reviewerMs"]),
    );
  });

  it("records account.exported in the workspace's audit log, inside the export", async () => {
    const exported = await buildAccountExport(db, A.userId);

    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, A.workspaceId), eq(auditLog.action, "account.exported")));
    expect(entries).toEqual([
      expect.objectContaining({ actorUserId: A.userId, subjectType: "user", subjectId: A.userId }),
    ]);
    expect(exported.workspaces[0]?.tables.audit_log).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "account.exported" })]),
    );
    const inB = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, B.workspaceId), eq(auditLog.action, "account.exported")));
    expect(inB).toEqual([]);
  });

  it("refuses to export a user who doesn't exist", async () => {
    await expect(buildAccountExport(db, "no-such-user")).rejects.toThrow(/no such user/);
  });
});

describe("deleteSoleMemberWorkspaces", () => {
  it("deletes A's workspace and its rows, then the user's own rows go with the user", async () => {
    await seedAuthSecrets("a");
    await seedAuthSecrets("b");

    expect(await deleteSoleMemberWorkspaces(db, A.userId)).toEqual([A.workspaceId]);
    await db.delete(user).where(eq(user.id, A.userId));

    for (const table of tenantTables) {
      expect(await db.select({ key: tenantKey(table) }).from(table), getTableName(table)).toEqual([
        { key: B.workspaceId },
      ]);
    }
    for (const table of [account, session, passkey]) {
      const rows = await db.select({ userId: table.userId }).from(table);
      expect(rows, getTableName(table)).toEqual([{ userId: B.userId }]);
    }
    expect(await db.select({ id: user.id }).from(user)).toEqual([{ id: B.userId }]);
  });

  it("keeps a workspace that another member shares", async () => {
    const shared = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await db.insert(workspaces).values({ id: shared, name: "Shared" });
    await db.insert(workspaceMembers).values([
      { workspaceId: shared, userId: A.userId },
      { workspaceId: shared, userId: B.userId },
    ]);

    expect(await deleteSoleMemberWorkspaces(db, A.userId)).toEqual([A.workspaceId]);
    const remaining = await db.execute<{ id: string }>(sql`select id from workspaces order by id`);
    expect(remaining.rows.map((r) => r.id)).toEqual([B.workspaceId, shared]);
  });
});
