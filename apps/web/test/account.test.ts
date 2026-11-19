import { buildAccountExport, schema, tenantTables, withTenant } from "@earshot/db";
import type { PGlite } from "@electric-sql/pglite";
import { eq, getTableName, sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MagicLinkMessage } from "@/lib/auth/email";
import type { Auth } from "@/lib/auth/server";
import { loadViewer, type Viewer } from "@/lib/auth/viewer-core";
import {
  authRequest,
  cloneDb,
  migratedTemplate,
  signInByMagicLink,
  type TestDb,
  testAuth,
  withCookie,
} from "./support/harness";

const {
  account,
  auditLog,
  commitments,
  credentials,
  crmConnections,
  crmEntities,
  session,
  sessions,
  user,
  utterances,
  workspaces,
} = schema;

let template: PGlite;
let db: TestDb;
let auth: Auth;
let outbox: MagicLinkMessage[];

beforeAll(async () => {
  template = await migratedTemplate();
});

beforeEach(async () => {
  db = await cloneDb(template);
  outbox = [];
  auth = testAuth({ db, outbox });
});

afterEach(async () => {
  await db.$client.close();
});

/** Known secret strings for one tenant. None may ever appear in an export. */
function canaries(tag: string) {
  return {
    credentialCiphertext: `CANARY-CREDENTIAL-${tag}`,
    crmToken: `CANARY-CRM-TOKEN-${tag}`,
    oauthAccess: `gho_CANARY_ACCESS_${tag}`,
    oauthRefresh: `ghr_CANARY_REFRESH_${tag}`,
    oauthIdToken: `eyJ.CANARY_ID_${tag}`,
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);

/** Signs a user up for real and gives their workspace a row in several tenant tables. */
async function seededTenant(email: string, tag: string) {
  const { cookie } = await signInByMagicLink(auth, outbox, email);
  const viewer = (await loadViewer({ auth, db, headers: withCookie(cookie) })) as Viewer;
  const secret = canaries(tag);

  await db.insert(account).values({
    id: `github-${tag}`,
    accountId: `gh-${tag}`,
    providerId: "github",
    userId: viewer.user.id,
    accessToken: secret.oauthAccess,
    refreshToken: secret.oauthRefresh,
    idToken: secret.oauthIdToken,
    scope: "read:user,user:email",
    updatedAt: new Date(),
  });

  // Tenant rows, written the way the app writes them: through withTenant, as the viewer.
  await withTenant(db, { userId: viewer.user.id, workspaceId: viewer.workspaceId }, async (tx) => {
    await tx.insert(credentials).values({
      workspaceId: viewer.workspaceId,
      provider: "deepgram",
      ciphertext: bytes(secret.credentialCiphertext),
      iv: bytes("iv-iv-iv-iv-"),
      wrappedDek: bytes(`wrapped-${secret.credentialCiphertext}`),
      dekIv: bytes("dek-iv-dek-i"),
      last4: tag.slice(-4).padStart(4, "x"),
    });
    const [connection] = await tx
      .insert(crmConnections)
      .values({
        workspaceId: viewer.workspaceId,
        provider: "hubspot",
        authType: "service_key",
        ciphertext: bytes(secret.crmToken),
        iv: bytes("iv-iv-iv-iv-"),
        wrappedDek: bytes(`wrapped-${secret.crmToken}`),
        dekIv: bytes("dek-iv-dek-i"),
      })
      .returning();
    await tx.insert(crmEntities).values({
      workspaceId: viewer.workspaceId,
      connectionId: connection?.id ?? null,
      kind: "company",
      externalId: `hs-${tag}`,
      name: `Company ${tag}`,
    });
    const [capture] = await tx
      .insert(sessions)
      .values({
        workspaceId: viewer.workspaceId,
        userId: viewer.user.id,
        mode: "debrief",
        engine: "cascaded",
      })
      .returning();
    await tx.insert(utterances).values({
      workspaceId: viewer.workspaceId,
      sessionId: capture?.id ?? "",
      seq: 0,
      witness: "biased",
      text: `Transcript line from ${tag}`,
      startedMs: 0,
      endedMs: 1000,
    });
    await tx.insert(commitments).values({
      workspaceId: viewer.workspaceId,
      owner: "rep",
      text: `Commitment of ${tag}`,
    });
  });

  const [{ token } = { token: "" }] = await db
    .select({ token: session.token })
    .from(session)
    .where(eq(session.userId, viewer.user.id));
  return { cookie, viewer, secret, sessionToken: token };
}

describe("data export", () => {
  it("holds all of A's data and none of B's, with no secret values", async () => {
    const a = await seededTenant("ana@acme.example", "ANA");
    const b = await seededTenant("bo@globex.example", "BO");

    const exported = await buildAccountExport(db, a.viewer.user.id);
    const json = JSON.stringify(exported);

    expect(exported.user).toMatchObject({ email: "ana@acme.example" });
    expect(exported.workspaces).toHaveLength(1);
    expect(exported.workspaces[0]?.id).toBe(a.viewer.workspaceId);
    const tables = exported.workspaces[0]?.tables ?? {};
    expect(Object.keys(tables).sort()).toEqual(tenantTables.map((t) => getTableName(t)).sort());
    expect(tables.utterances).toEqual([
      expect.objectContaining({ text: "Transcript line from ANA" }),
    ]);
    expect(tables.credentials).toEqual([
      expect.objectContaining({ provider: "deepgram", last4: "xANA" }),
    ]);

    // None of B's data.
    for (const value of [
      b.viewer.user.id,
      b.viewer.workspaceId,
      "bo@globex.example",
      "Company BO",
      "Transcript line from BO",
      "Commitment of BO",
    ]) {
      expect(json, `B's ${value} leaked into A's export`).not.toContain(value);
    }
    // No secrets, A's or B's, including A's own session token.
    for (const value of [
      ...Object.values(a.secret),
      ...Object.values(b.secret),
      a.sessionToken,
      b.sessionToken,
    ]) {
      expect(value.length).toBeGreaterThan(8);
      expect(json, "a secret leaked into the export").not.toContain(value);
    }
    // Envelope-encrypted columns are absent, not just unrecognizable.
    for (const column of [
      "ciphertext",
      "wrappedDek",
      "dekIv",
      "accessToken",
      "refreshToken",
      "idToken",
      "password",
      "token",
    ]) {
      expect(json).not.toContain(`"${column}"`);
    }
  });

  it("records account.exported in A's audit log only", async () => {
    const a = await seededTenant("ana@acme.example", "ANA");
    const b = await seededTenant("bo@globex.example", "BO");

    await buildAccountExport(db, a.viewer.user.id);

    const entries = await db
      .select({ workspaceId: auditLog.workspaceId, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(eq(auditLog.action, "account.exported"));
    expect(entries).toEqual([{ workspaceId: a.viewer.workspaceId, actor: a.viewer.user.id }]);
    expect(entries.some((entry) => entry.workspaceId === b.viewer.workspaceId)).toBe(false);
  });
});

describe("account deletion", () => {
  it("deletes A's user, workspace, and tenant rows, and leaves B intact", async () => {
    const a = await seededTenant("ana@acme.example", "ANA");
    const b = await seededTenant("bo@globex.example", "BO");

    const response = await auth.handler(
      authRequest("/delete-user", { body: {}, cookie: a.cookie }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    // The session cookie is cleared.
    expect(response.headers.getSetCookie().join("\n")).toMatch(/earshot\.session_token=;/);

    expect(await db.select().from(user).where(eq(user.id, a.viewer.user.id))).toEqual([]);
    expect(
      await db.select().from(workspaces).where(eq(workspaces.id, a.viewer.workspaceId)),
    ).toEqual([]);
    for (const table of [session, account]) {
      expect(await db.select().from(table).where(eq(table.userId, a.viewer.user.id))).toEqual([]);
    }
    for (const table of tenantTables) {
      const key = "workspaceId" in table ? table.workspaceId : table.id;
      const left = await db.select({ key }).from(table).where(eq(key, a.viewer.workspaceId));
      expect(left, `${getTableName(table)} still holds A's rows`).toEqual([]);
    }

    // B is untouched and still signed in.
    expect(await loadViewer({ auth, db, headers: withCookie(b.cookie) })).toMatchObject({
      workspaceId: b.viewer.workspaceId,
    });
    const bRows = await withTenant(
      db,
      { userId: b.viewer.user.id, workspaceId: b.viewer.workspaceId },
      (tx) => tx.select().from(utterances),
    );
    expect(bRows).toEqual([expect.objectContaining({ text: "Transcript line from BO" })]);
  });

  it("purges the storage of A's sessions before deleting them, and none of B's", async () => {
    const purged: string[][] = [];
    auth = testAuth({ db, outbox, purgeSessions: async (ids) => void purged.push([...ids]) });
    const a = await seededTenant("ana@acme.example", "ANA");
    const b = await seededTenant("bo@globex.example", "BO");
    const sessionsOf = async (workspaceId: string) =>
      (
        await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.workspaceId, workspaceId))
      )
        .map((row) => row.id)
        .sort();
    const aSessions = await sessionsOf(a.viewer.workspaceId);
    const bSessions = await sessionsOf(b.viewer.workspaceId);
    expect(aSessions).toHaveLength(1);

    const response = await auth.handler(
      authRequest("/delete-user", { body: {}, cookie: a.cookie }),
    );

    expect(response.status).toBe(200);
    expect(purged).toEqual([aSessions]);
    expect(purged.flat().some((id) => bSessions.includes(id))).toBe(false);
    expect(await sessionsOf(b.viewer.workspaceId)).toEqual(bSessions);
  });

  it("deletes nothing, and says to retry, when purging session storage fails", async () => {
    auth = testAuth({
      db,
      outbox,
      purgeSessions: async () => {
        throw new Error("edge unavailable");
      },
    });
    const a = await seededTenant("ana@acme.example", "ANA");

    const response = await auth.handler(
      authRequest("/delete-user", { body: {}, cookie: a.cookie }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "PURGE_FAILED" });
    expect(await db.select().from(user).where(eq(user.id, a.viewer.user.id))).toHaveLength(1);
    expect(
      await db.select().from(workspaces).where(eq(workspaces.id, a.viewer.workspaceId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(sessions).where(eq(sessions.workspaceId, a.viewer.workspaceId)),
    ).toHaveLength(1);
  });

  it("refuses without a recent sign-in, and deletes nothing", async () => {
    const a = await seededTenant("ana@acme.example", "ANA");
    await db.execute(
      sql`update session set created_at = now() - interval '2 hours' where user_id = ${a.viewer.user.id}`,
    );

    const response = await auth.handler(
      authRequest("/delete-user", { body: {}, cookie: a.cookie }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "SESSION_EXPIRED" });
    expect(await db.select().from(user).where(eq(user.id, a.viewer.user.id))).toHaveLength(1);
    expect(
      await db.select().from(workspaces).where(eq(workspaces.id, a.viewer.workspaceId)),
    ).toHaveLength(1);
  });

  it("refuses without a session", async () => {
    const response = await auth.handler(authRequest("/delete-user", { body: {} }));
    expect(response.status).toBe(401);
  });
});
