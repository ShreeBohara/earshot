import {
  findSecretFragment,
  generateMasterKey,
  importMasterKey,
  loadVaultMasterKey,
  type ProviderId,
} from "@earshot/keys/server";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/schema";
import { auditLog, credentials } from "../src/schema";
import { withTenant } from "../src/tenant";
import {
  deleteCredential,
  listCredentials,
  putCredential,
  revealCredential,
  VaultOffError,
  VaultOpenError,
} from "../src/vault";
import { A, B, cloneDb, seededDb } from "./db";

// Canary keys. If any eight characters in a row of one show up where they shouldn't, it leaked.
const KEY = "sk-ant-api03-VAULTcanaryQz7Xw2Lp9Rt4Mn8Bv6CxKs5Hg";
const REPLACEMENT = "sk-ant-api03-SECONDcanaryHw3Jy1Uz7Io9Pq2Ks4Lm";

type Db = Awaited<ReturnType<typeof seededDb>>["db"];

let template: PGlite;
let master: CryptoKey;
let client: PGlite;
let db: Db;

beforeAll(async () => {
  ({ client: template } = await seededDb());
  master = await importMasterKey(generateMasterKey());
});

beforeEach(async () => {
  ({ client, db } = await cloneDb(template));
});

afterEach(async () => {
  await client.close();
});

const put = (tenant: typeof A, input: Parameters<typeof putCredential>[2]) =>
  withTenant(db, tenant, (tx) => putCredential(tx, master, input));
const reveal = (tenant: typeof A, provider: ProviderId, label?: string) =>
  withTenant(db, tenant, (tx) => revealCredential(tx, master, { provider, label }));

/** Fails if any eight characters in a row of any secret appear in the haystack. */
function expectNoTrace(haystack: string, secrets: readonly string[]) {
  for (const secret of secrets) {
    expect(findSecretFragment(haystack, secret), "a fragment of a key leaked").toBeUndefined();
  }
}

/**
 * The vault's audit entries for a workspace, as the owner sees them, sorted by action:
 * back-to-back transactions can share a timestamp, so time can't order them.
 */
async function credentialAudit(workspaceId: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), like(auditLog.action, "credential.%")));
  return rows.sort((a, b) => a.action.localeCompare(b.action));
}

/**
 * Every value in every column of every table, as text, read as the owner (no RLS): text columns
 * cast to text, and bytea both escaped (printable bytes as themselves) and hex-encoded.
 */
async function dumpEverything(pg: PGlite): Promise<string> {
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const { rows: tables } = await pg.query<{ schema: string; name: string }>(
    `select table_schema as schema, table_name as name from information_schema.tables
     where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')`,
  );
  expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["credentials", "audit_log"]));

  const values: string[] = [];
  for (const table of tables) {
    const { rows: columns } = await pg.query<{ name: string; type: string }>(
      `select column_name as name, data_type as type from information_schema.columns
       where table_schema = $1 and table_name = $2`,
      [table.schema, table.name],
    );
    const exprs = columns.map(({ name, type }) =>
      type === "bytea"
        ? `encode(${quote(name)}, 'escape') || ' ' || encode(${quote(name)}, 'hex')`
        : `${quote(name)}::text`,
    );
    const { rows } = await pg.query<Record<string, string | null>>(
      `select ${exprs.map((expr, i) => `${expr} as c${i}`).join(", ")}
       from ${quote(table.schema)}.${quote(table.name)}`,
    );
    for (const row of rows) values.push(...Object.values(row).map((v) => v ?? ""));
  }
  return values.join("\n");
}

describe("putCredential, listCredentials, revealCredential", () => {
  it("stores a key sealed, returns only its metadata, and reveals it to its own workspace", async () => {
    const validatedAt = new Date("2026-11-15T12:00:00Z");
    const stored = await put(A, { provider: "anthropic", secret: KEY, validatedAt });

    expect(Object.keys(stored).sort()).toEqual([
      "createdAt",
      "id",
      "label",
      "last4",
      "provider",
      "validatedAt",
    ]);
    expect(stored).toMatchObject({
      provider: "anthropic",
      label: "default",
      last4: KEY.slice(-4),
      validatedAt,
    });
    expectNoTrace(JSON.stringify(stored), [KEY]);

    const listed = await withTenant(db, A, (tx) => listCredentials(tx));
    expect(listed).toContainEqual(stored);
    expectNoTrace(JSON.stringify(listed), [KEY]);
    expect(await reveal(A, "anthropic")).toBe(KEY);
  });

  it("replaces the key in a slot, keeping the row, and keeps other labels apart", async () => {
    const first = await put(A, { provider: "anthropic", secret: KEY, validatedAt: new Date() });
    const work = await put(A, { provider: "anthropic", label: " work ", secret: KEY });
    // Pasted keys often carry whitespace; it's trimmed before sealing.
    const second = await put(A, { provider: "anthropic", secret: `  ${REPLACEMENT}\n` });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toEqual(first.createdAt);
    expect(second).toMatchObject({ last4: REPLACEMENT.slice(-4), validatedAt: null });
    expect(work).toMatchObject({ label: "work", last4: KEY.slice(-4) });
    expect(await reveal(A, "anthropic")).toBe(REPLACEMENT);
    expect(await reveal(A, "anthropic", "work")).toBe(KEY);

    const rows = await db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(eq(credentials.workspaceId, A.workspaceId), eq(credentials.provider, "anthropic")),
      );
    expect(rows).toHaveLength(2);
    expect((await credentialAudit(A.workspaceId)).map((e) => e.action)).toEqual([
      "credential.replaced",
      "credential.stored",
      "credential.stored",
    ]);
  });

  it("deletes a key and records it once", async () => {
    await put(A, { provider: "anthropic", secret: KEY });
    const remove = () => withTenant(db, A, (tx) => deleteCredential(tx, { provider: "anthropic" }));

    expect(await remove()).toBe(true);
    expect(await reveal(A, "anthropic")).toBeNull();
    expect(await remove()).toBe(false);
    expect((await credentialAudit(A.workspaceId)).map((e) => e.action)).toEqual([
      "credential.deleted",
      "credential.stored",
    ]);
  });
});

describe("the gate: no key in storage, in a query's result, or in the audit log", () => {
  it("leaves no trace of a key in any column of any table", async () => {
    await put(A, { provider: "anthropic", secret: KEY });
    await put(A, { provider: "anthropic", secret: REPLACEMENT });
    await put(B, { provider: "anthropic", label: "work", secret: KEY });
    await withTenant(db, B, (tx) => deleteCredential(tx, { provider: "anthropic", label: "work" }));
    await put(B, { provider: "openai", secret: REPLACEMENT });

    const dump = await dumpEverything(client);
    expect(dump).toContain(KEY.slice(-4)); // the dump does see the vault's rows
    expectNoTrace(dump, [KEY, REPLACEMENT]);
    for (const key of [KEY, REPLACEMENT]) {
      expect(dump).not.toContain(Buffer.from(key).toString("base64"));
      expect(dump).not.toContain(Buffer.from(key).toString("hex"));
    }
  });

  it("lists keys with a query that never selects an envelope column", async () => {
    await put(A, { provider: "anthropic", secret: KEY });
    const queries: string[] = [];
    const logged = drizzle({
      client,
      schema,
      logger: { logQuery: (query) => queries.push(query) },
    });

    const listed = await withTenant(logged, A, (tx) => listCredentials(tx));

    const reads = queries.filter((query) => query.includes('from "credentials"'));
    expect(reads).toHaveLength(1);
    for (const column of ["ciphertext", "iv", "wrapped_dek", "dek_iv"]) {
      expect(reads[0]).not.toContain(`"${column}"`);
    }
    expect(reads[0]).not.toMatch(/\*/);
    for (const row of listed) {
      expect(Object.keys(row).sort()).toEqual([
        "createdAt",
        "id",
        "label",
        "last4",
        "provider",
        "validatedAt",
      ]);
    }
  });

  it("returns no envelope column from a store or a delete either", async () => {
    const queries: string[] = [];
    const logged = drizzle({
      client,
      schema,
      logger: { logQuery: (query) => queries.push(query) },
    });
    await withTenant(logged, A, (tx) =>
      putCredential(tx, master, { provider: "groq", secret: KEY }),
    );
    await withTenant(logged, A, (tx) => deleteCredential(tx, { provider: "groq" }));

    const returning = queries
      .filter((query) => query.includes(' "credentials"'))
      .map((query) => query.split(/\breturning\b/)[1])
      .filter((clause) => clause !== undefined);
    expect(returning).toHaveLength(2);
    for (const clause of returning) {
      for (const column of ["ciphertext", "iv", "wrapped_dek", "dek_iv"]) {
        expect(clause).not.toContain(`"${column}"`);
      }
    }
  });

  it("audits stores, replacements, and deletes in the user's name, with last4 but no key", async () => {
    const stored = await put(A, { provider: "anthropic", secret: KEY });
    await put(A, { provider: "anthropic", secret: REPLACEMENT });
    await withTenant(db, A, (tx) => deleteCredential(tx, { provider: "anthropic" }));

    const entries = await credentialAudit(A.workspaceId);
    const subject = { subjectType: "credential", subjectId: stored.id, actorUserId: A.userId };
    const detail = (last4: string) => ({ provider: "anthropic", label: "default", last4 });
    expect(
      entries.map(({ action, subjectType, subjectId, actorUserId, detail }) => ({
        action,
        subjectType,
        subjectId,
        actorUserId,
        detail,
      })),
    ).toEqual([
      { action: "credential.deleted", ...subject, detail: detail(REPLACEMENT.slice(-4)) },
      { action: "credential.replaced", ...subject, detail: detail(REPLACEMENT.slice(-4)) },
      { action: "credential.stored", ...subject, detail: detail(KEY.slice(-4)) },
    ]);
    expectNoTrace(JSON.stringify(entries), [KEY, REPLACEMENT]);
  });
});

describe("tenant isolation", () => {
  it("keeps B from listing, revealing, or deleting A's keys", async () => {
    const stored = await put(A, { provider: "anthropic", secret: KEY });

    const listed = await withTenant(db, B, (tx) => listCredentials(tx));
    expect(listed.map((c) => c.id)).not.toContain(stored.id);
    expect(listed.map((c) => c.last4)).toEqual(["bbbb"]); // B's own seeded key, nothing else
    expect(await reveal(B, "anthropic")).toBeNull();
    expect(await withTenant(db, B, (tx) => deleteCredential(tx, { provider: "anthropic" }))).toBe(
      false,
    );

    // A's key is untouched, and B's attempts left nothing in B's audit log.
    expect(await reveal(A, "anthropic")).toBe(KEY);
    expect(await credentialAudit(B.workspaceId)).toEqual([]);
  });

  it("gives each workspace its own slot", async () => {
    await put(A, { provider: "anthropic", secret: KEY });
    await put(B, { provider: "anthropic", secret: REPLACEMENT });

    expect(await reveal(A, "anthropic")).toBe(KEY);
    expect(await reveal(B, "anthropic")).toBe(REPLACEMENT);
    expect((await credentialAudit(A.workspaceId)).map((e) => e.action)).toEqual([
      "credential.stored",
    ]);
  });
});

describe("context binding", () => {
  const slotOf = (workspaceId: string, provider: string, label: string) =>
    and(
      eq(credentials.workspaceId, workspaceId),
      eq(credentials.provider, provider),
      eq(credentials.label, label),
    );

  it("won't open a sealed row moved to another label", async () => {
    await put(A, { provider: "anthropic", secret: KEY });
    await db
      .update(credentials)
      .set({ label: "moved" })
      .where(slotOf(A.workspaceId, "anthropic", "default"));
    await expect(reveal(A, "anthropic", "moved")).rejects.toThrow(VaultOpenError);

    // Moving it back opens it again: the context failed, not the bytes.
    await db
      .update(credentials)
      .set({ label: "default" })
      .where(slotOf(A.workspaceId, "anthropic", "moved"));
    expect(await reveal(A, "anthropic")).toBe(KEY);
  });

  it("won't open a sealed row moved to another provider", async () => {
    await put(A, { provider: "anthropic", label: "spare", secret: KEY });
    await db
      .update(credentials)
      .set({ provider: "openai" })
      .where(slotOf(A.workspaceId, "anthropic", "spare"));
    await expect(reveal(A, "openai", "spare")).rejects.toThrow(VaultOpenError);
  });

  it("won't open a sealed row moved to another workspace", async () => {
    await put(A, { provider: "anthropic", secret: KEY });
    await db
      .update(credentials)
      .set({ workspaceId: B.workspaceId })
      .where(slotOf(A.workspaceId, "anthropic", "default"));

    const error = await reveal(B, "anthropic").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultOpenError);
    expectNoTrace(String(error), [KEY]);
    expect(await reveal(A, "anthropic")).toBeNull();
  });

  it("won't open a row under a different master key", async () => {
    await put(A, { provider: "anthropic", secret: KEY });
    const other = await importMasterKey(generateMasterKey());
    await expect(
      withTenant(db, A, (tx) => revealCredential(tx, other, { provider: "anthropic" })),
    ).rejects.toThrow(VaultOpenError);
  });
});

describe("guards", () => {
  it("refuses to store or reveal while the vault is off, and writes nothing", async () => {
    // No EARSHOT_VAULT_MASTER_KEY: the vault is off.
    const off = await loadVaultMasterKey({});
    expect(off).toBeNull();

    await expect(
      withTenant(db, A, (tx) => putCredential(tx, off, { provider: "anthropic", secret: KEY })),
    ).rejects.toThrow(VaultOffError);
    await expect(
      withTenant(db, A, (tx) => revealCredential(tx, off, { provider: "openai" })),
    ).rejects.toThrow(VaultOffError);

    expect(
      await db.select().from(credentials).where(eq(credentials.provider, "anthropic")),
    ).toEqual([]);
    expect(await credentialAudit(A.workspaceId)).toEqual([]);
    expectNoTrace(await dumpEverything(client), [KEY]);
  });

  it("refuses to run outside withTenant, where RLS wouldn't apply", async () => {
    await expect(db.transaction((tx) => listCredentials(tx))).rejects.toThrow(/withTenant/);
    await expect(
      db.transaction((tx) => putCredential(tx, master, { provider: "anthropic", secret: KEY })),
    ).rejects.toThrow(/withTenant/);
    await expect(
      db.transaction((tx) => deleteCredential(tx, { provider: "openai" })),
    ).rejects.toThrow(/withTenant/);

    // withTenant's settings without its role: RLS still wouldn't apply, so it's refused too.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.user_id', ${A.userId}, true),
                     set_config('app.workspace_id', ${A.workspaceId}, true)`,
        );
        return listCredentials(tx);
      }),
    ).rejects.toThrow(/withTenant/);

    // The owner's transaction would have reached both workspaces' rows; it touched none.
    expect(await db.select({ id: credentials.id }).from(credentials)).toHaveLength(2);
  });

  it("refuses bad input without quoting it", async () => {
    const attempts: Array<Parameters<typeof putCredential>[2]> = [
      // A key pasted into the provider field.
      { provider: KEY as ProviderId, secret: KEY },
      // A key pasted into the label field, or anything shaped like one.
      { provider: "openai", label: KEY, secret: KEY },
      { provider: "openai", label: "sk-proj-abcdefghijklmnopqrstuvwxyz", secret: REPLACEMENT },
      { provider: "openai", label: "", secret: KEY },
      { provider: "openai", label: "x".repeat(65), secret: KEY },
      { provider: "openai", label: "two\nlines", secret: KEY },
      { provider: "openai", secret: "   " },
    ];
    for (const input of attempts) {
      const error = await put(A, input).catch((e: unknown) => e);
      expect(error, JSON.stringify(input.label)).toBeInstanceOf(TypeError);
      expectNoTrace(String(error), [KEY]);
    }
    expect(await credentialAudit(A.workspaceId)).toEqual([]);
  });
});
