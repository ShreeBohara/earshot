import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AuditSigner,
  DEV_AUDIT_SIGNING_KEY,
  findSecretFragment,
  generateAuditSigningKey,
  generateMasterKey,
  importMasterKey,
  loadAuditSigningKey,
  toHex,
  verifyCheckpoint,
} from "@earshot/keys/server";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { main as auditVerify } from "../scripts/audit-verify";
import { buildAccountExport } from "../src/account";
import {
  AuditHeadError,
  exportAuditChain,
  recordAudit,
  verifyAuditExport,
  writeCheckpoint,
  ZERO_HASH_HEX,
} from "../src/audit-chain";
import { loadDemoCrm } from "../src/demo-crm";
import * as schema from "../src/schema";
import { auditCheckpoints, auditLog } from "../src/schema";
import { withTenant } from "../src/tenant";
import { putCredential } from "../src/vault";
import { A, B, cloneDb, seededDb } from "./db";

type Db = Awaited<ReturnType<typeof seededDb>>["db"];

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
  );
}

/** A signer with a key made for this test file only. */
async function testSigner(): Promise<{ signer: AuditSigner; d: string }> {
  const key = await generateAuditSigningKey();
  const state = await loadAuditSigningKey(
    { EARSHOT_AUDIT_SIGNING_KEY: key.secret },
    { development: false },
  );
  if (!("signer" in state)) throw new Error(`no signer: ${state.status}`);
  return { signer: state.signer, d: (JSON.parse(key.secret) as { d: string }).d };
}

async function verifyInDb(db: Db, workspaceId: string): Promise<number | null> {
  const { rows } = await db.execute<{ bad: string | null }>(
    sql`select public.audit_chain_verify(${workspaceId}::uuid)::text as bad`,
  );
  return rows[0]?.bad === null || rows[0]?.bad === undefined ? null : Number(rows[0].bad);
}

describe("migration 0013's backfill", () => {
  let dir: string;

  beforeAll(() => {
    // The repo's migrations up to 0012 only: the database as it stood before the chain.
    dir = mkdtempSync(join(tmpdir(), "earshot-0012-"));
    cpSync(migrationsFolder, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(dir, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.tag < "0013");
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("chains the rows that exist per workspace in (at, id) order, then makes the columns NOT NULL", async () => {
    const client = new PGlite({ extensions: { vector, pg_trgm } });
    const db = drizzle({ client, schema });
    try {
      await migrate(db, { migrationsFolder: dir });
      await client.exec(
        readFileSync(new URL("./fixtures/two-workspaces.sql", import.meta.url), "utf8")
          // The fixture's checkpoints need migration 0013; the backfill test seeds rows only.
          .split("insert into audit_checkpoints")[0] ?? "",
      );
      // More history in A, out of order and with a tie on `at` that the id breaks, as a Phase 2
      // database might hold: key changes, demo CRM loads, an export.
      await client.exec(`
          insert into audit_log (id, workspace_id, actor_user_id, action, detail, at) values
            ('a0000000-0000-4000-8000-0000000000c3', '${A.workspaceId}', 'user-a', 'demo_crm.loaded',
             '{"companies": 60}', '2026-11-17T10:00:00.5Z'),
            ('a0000000-0000-4000-8000-0000000000c1', '${A.workspaceId}', 'user-a', 'credential.stored',
             '{"provider": "openai", "label": "default", "last4": "aaaa"}', '2026-11-16T09:00:00Z'),
            ('a0000000-0000-4000-8000-0000000000c2', '${A.workspaceId}', null, 'credential.rotated',
             '{}', '2026-11-17T10:00:00.5Z'),
            ('a0000000-0000-4000-8000-0000000000c4', '${A.workspaceId}', 'user-a', 'account.exported',
             '{"note": "Ünïcødé \\"quoted\\""}', '2026-11-18T08:00:00.123456Z');
        `);
      // The seeded entries carry now() as their time, after all of the above.
      await migrate(db, { migrationsFolder });

      const rows = await db
        .select()
        .from(auditLog)
        .orderBy(asc(auditLog.workspaceId), asc(auditLog.chainSeq));
      const aRows = rows.filter((row) => row.workspaceId === A.workspaceId);
      expect(aRows.map((row) => [row.chainSeq, row.id.slice(-2)])).toEqual([
        [1, "c1"],
        [2, "c2"], // ties on `at` with c3, and its id sorts first
        [3, "c3"],
        [4, "c4"],
        [5, "11"],
      ]);
      expect(
        rows.filter((row) => row.workspaceId === B.workspaceId).map((r) => r.chainSeq),
      ).toEqual([1]);

      // Each hash, recomputed outside Postgres from its canonical text, links to the one before.
      let prev = ZERO_HASH_HEX;
      for (const row of aRows) {
        const { rows: canon } = await db.execute<{ text: string }>(
          sql`select public.audit_entry_canonical(a) as text from audit_log a where a.id = ${row.id}`,
        );
        const text = canon[0]?.text ?? "";
        expect(toHex(row.prevHash)).toBe(prev);
        expect(toHex(row.entryHash)).toBe(
          await sha256Hex(new Uint8Array([...row.prevHash, ...new TextEncoder().encode(text)])),
        );
        prev = toHex(row.entryHash);
      }
      expect(await verifyInDb(db, A.workspaceId)).toBeNull();
      expect(await verifyInDb(db, B.workspaceId)).toBeNull();

      const { rows: notNull } = await db.execute<{ attname: string; attnotnull: boolean }>(
        sql`select attname, attnotnull from pg_attribute
              where attrelid = 'public.audit_log'::regclass
                and attname in ('chain_seq', 'prev_hash', 'entry_hash') order by attname`,
      );
      expect(notNull.every((column) => column.attnotnull)).toBe(true);

      // New entries continue the backfilled chain.
      const recorded = await withTenant(db, A, (tx) => recordAudit(tx, [{ action: "test.next" }]));
      expect(recorded.head.seq).toBe(6);
      expect(await verifyInDb(db, A.workspaceId)).toBeNull();
    } finally {
      await client.close();
    }
  }, 120_000);
});

// Each test clones a migrated database; CI runs PGlite far slower than a laptop does.
describe("the chain", { timeout: 120_000 }, () => {
  let template: PGlite;
  let db: Db;

  beforeAll(async () => {
    ({ client: template } = await seededDb());
  }, 120_000);

  beforeEach(async () => {
    ({ db } = await cloneDb(template));
  }, 120_000);

  afterEach(async () => {
    await db.$client.close();
  });

  it("chains the vault's, the demo CRM's, and the account export's entries without changes to them", async () => {
    const master = await importMasterKey(generateMasterKey());
    await withTenant(db, A, (tx) =>
      putCredential(tx, master, {
        provider: "openai",
        secret: "sk-test-CANARY0123456789abcdefghijkl",
      }),
    );
    await withTenant(db, A, (tx) => loadDemoCrm(tx));
    await buildAccountExport(db, A.userId);

    const rows = await db
      .select({ seq: auditLog.chainSeq, action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.workspaceId, A.workspaceId))
      .orderBy(asc(auditLog.chainSeq));
    expect(rows).toEqual([
      { seq: 1, action: "proposal.approved" },
      { seq: 2, action: "credential.replaced" },
      { seq: 3, action: "demo_crm.loaded" },
      { seq: 4, action: "account.exported" },
    ]);
    expect(await verifyInDb(db, A.workspaceId)).toBeNull();
  });

  it("records entries in order, in the tenant's name, and returns the head", async () => {
    const recorded = await withTenant(db, A, (tx) =>
      recordAudit(tx, [
        {
          action: "proposal.approved",
          subjectType: "proposal",
          subjectId: "p-1",
          detail: { n: 1 },
        },
        { action: "proposal.rejected", subjectType: "proposal", subjectId: "p-2" },
        { action: "proposal.edited", detail: { nested: { deep: [1, 2] } } },
      ]),
    );
    expect(recorded.entries.map((entry) => entry.seq)).toEqual([2, 3, 4]);
    expect(recorded.head).toEqual({
      workspaceId: A.workspaceId,
      seq: 4,
      entryHash: recorded.entries[2]?.entryHash,
    });
    const rows = await db
      .select({ seq: auditLog.chainSeq, actor: auditLog.actorUserId, action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.workspaceId, A.workspaceId))
      .orderBy(asc(auditLog.chainSeq));
    expect(rows.slice(1)).toEqual([
      { seq: 2, actor: A.userId, action: "proposal.approved" },
      { seq: 3, actor: A.userId, action: "proposal.rejected" },
      { seq: 4, actor: A.userId, action: "proposal.edited" },
    ]);
  });

  it("refuses to run outside withTenant, or with nothing to record", async () => {
    const { signer } = await testSigner();
    await expect(
      db.transaction((tx) => recordAudit(tx, [{ action: "proposal.approved" }])),
    ).rejects.toThrow(/withTenant/);
    await expect(withTenant(db, A, (tx) => recordAudit(tx, []))).rejects.toThrow(TypeError);
    await expect(withTenant(db, A, (tx) => recordAudit(tx, [{ action: " " }]))).rejects.toThrow(
      TypeError,
    );
    await expect(
      db.transaction((tx) =>
        writeCheckpoint(
          tx,
          signer,
          { workspaceId: A.workspaceId, seq: 1, entryHash: new Uint8Array(32) },
          "review",
        ),
      ),
    ).rejects.toThrow(/withTenant/);
  });

  it("signs the head as a checkpoint whose signature verifies, and refuses a head it doesn't hold", async () => {
    const { signer } = await testSigner();
    const at = new Date("2026-11-20T12:34:56.789Z");
    const checkpoint = await withTenant(db, A, async (tx) => {
      const { head } = await recordAudit(tx, [{ action: "proposal.approved", subjectId: "p-1" }]);
      return writeCheckpoint(tx, signer, head, "review", at);
    });
    expect(checkpoint).toMatchObject({
      workspaceId: A.workspaceId,
      seq: 2,
      signedAt: "2026-11-20T12:34:56.789Z",
      kid: signer.kid,
      request: "review",
    });
    const [stored] = await db
      .select()
      .from(auditCheckpoints)
      .where(eq(auditCheckpoints.id, checkpoint.id));
    expect(stored?.signedAt.toISOString()).toBe("2026-11-20T12:34:56.789Z");
    expect(
      await verifyCheckpoint([signer.publicKey], {
        workspaceId: A.workspaceId,
        seq: stored?.chainSeq ?? 0,
        head: stored?.entryHash ?? new Uint8Array(),
        ts: stored?.signedAt.toISOString() ?? "",
        kid: stored?.kid ?? "",
        signature: stored?.signature ?? new Uint8Array(),
      }),
    ).toEqual({ ok: true, key: signer.publicKey });

    // A head with the wrong hash, a seq that doesn't exist, or another workspace's: nothing signed.
    const before = await db.select({ id: auditCheckpoints.id }).from(auditCheckpoints);
    for (const head of [
      { workspaceId: A.workspaceId, seq: 2, entryHash: new Uint8Array(32) },
      { workspaceId: A.workspaceId, seq: 99, entryHash: checkpoint.entryHash },
      { workspaceId: B.workspaceId, seq: 1, entryHash: checkpoint.entryHash },
    ]) {
      await expect(
        withTenant(db, A, (tx) => writeCheckpoint(tx, signer, head, "review")),
      ).rejects.toThrow(AuditHeadError);
    }
    expect(await db.select({ id: auditCheckpoints.id }).from(auditCheckpoints)).toEqual(before);
  });

  it("exports the chain with canonical texts that hash to the stored hashes", async () => {
    await withTenant(db, A, (tx) =>
      recordAudit(tx, [
        {
          action: "proposal.edited",
          detail: {
            quote: 'Ünïcødé ✓ "quoted" back\\slash\ttab',
            amount: 1.5,
            list: [1, null, true],
          },
        },
      ]),
    );
    const chain = await withTenant(db, A, (tx) => exportAuditChain(tx));
    expect(chain.workspaceId).toBe(A.workspaceId);
    expect(chain.entries.map((entry) => entry.chainSeq)).toEqual([1, 2]);
    expect(chain.checkpoints.map((checkpoint) => checkpoint.chainSeq)).toEqual([1]);
    for (const entry of chain.entries) {
      expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(entry.entryHash).toBe(
        await sha256Hex(
          new Uint8Array([
            ...Buffer.from(entry.prevHash, "hex"),
            ...new TextEncoder().encode(entry.canonical),
          ]),
        ),
      );
    }
    expect(JSON.parse(chain.entries[1]?.canonical ?? "")).toEqual([
      1,
      A.workspaceId,
      2,
      A.userId,
      "proposal.edited",
      null,
      null,
      { quote: 'Ünïcødé ✓ "quoted" back\\slash\ttab', amount: 1.5, list: [1, null, true] },
      chain.entries[1]?.at,
    ]);
    // B's chain isn't A's to export.
    expect(JSON.stringify(chain)).not.toContain(B.workspaceId);
  });
});

describe("verifying an export offline", { timeout: 120_000 }, () => {
  let template: PGlite;
  let db: Db;
  let signer: AuditSigner;
  let privateD: string;

  beforeAll(async () => {
    ({ client: template } = await seededDb());
    ({ signer, d: privateD } = await testSigner());
  }, 120_000);

  beforeEach(async () => {
    ({ db } = await cloneDb(template));
  }, 120_000);

  afterEach(async () => {
    await db.$client.close();
  });

  /** An export with two review requests, each with its checkpoint, as the route writes it. */
  async function exportFile(keys = [signer.publicKey]): Promise<string> {
    // The seeded checkpoint carries a placeholder signature; a real deployment's never would.
    await db.delete(auditCheckpoints);
    for (const batch of [
      [
        {
          action: "proposal.approved",
          subjectType: "proposal",
          subjectId: "p-1",
          detail: { mode: "single" },
        },
      ],
      [
        {
          action: "proposal.approved",
          subjectType: "proposal",
          subjectId: "p-2",
          detail: { mode: "batch" },
        },
        {
          action: "proposal.rejected",
          subjectType: "proposal",
          subjectId: "p-3",
          detail: { amount: 12.5 },
        },
      ],
    ]) {
      await withTenant(db, A, async (tx) => {
        const { head } = await recordAudit(tx, batch);
        await writeCheckpoint(tx, signer, head, "review");
      });
    }
    const exported = await buildAccountExport(db, A.userId, new Date(), { auditKeys: keys });
    return `${JSON.stringify(exported, null, 2)}\n`;
  }

  async function run(file: string, keysFile?: string) {
    const out: string[] = [];
    const err: string[] = [];
    const files: Record<string, string> = {
      "export.json": file,
      ...(keysFile ? { "keys.json": keysFile } : {}),
    };
    const code = await auditVerify({
      argv: ["export.json", ...(keysFile ? ["--keys", "keys.json"] : [])],
      readText: async (path) => {
        const text = files[path];
        if (text === undefined) throw new Error("ENOENT");
        return text;
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("passes on an export: links, hashes, canonical texts, and signatures", async () => {
    const file = await exportFile();
    const result = await verifyAuditExport(JSON.parse(file));
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.keySource).toBe("export");
    expect(result.workspaces).toEqual([
      {
        workspaceId: A.workspaceId,
        entries: 5, // the seeded entry, three reviews, and account.exported
        checkpoints: 2,
        head: { seq: 5, entryHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
        signedThrough: 4,
        developmentSignatures: 0,
      },
    ]);

    const run1 = await run(file);
    expect(run1).toMatchObject({ code: 0, err: "" });
    expect(run1.out).toContain("signed through seq 4 (1 later entry not signed yet)");
    expect(run1.out).toContain("OK: every link, hash, canonical text, and signature checks out.");

    // With the keys saved from /api/audit/keys instead of the file's own.
    const keysFile = JSON.stringify({ keys: [signer.publicKey] });
    expect(await run(file, keysFile)).toMatchObject({ code: 0 });
  });

  it("fails with one byte changed anywhere the chain or a signature covers", async () => {
    const file = await exportFile();
    const exported = JSON.parse(file) as {
      workspaces: {
        tables: {
          audit_log: Record<string, unknown>[];
          audit_checkpoints: Record<string, unknown>[];
        };
      }[];
    };
    const tables = exported.workspaces[0]?.tables;
    const entry = tables?.audit_log[2] ?? {};
    const checkpoint = tables?.audit_checkpoints[1] ?? {};

    /**
     * The file with the first occurrence of `from` (or the last, for a value the chain and a
     * checkpoint share) changed in one byte, at offset `at`.
     */
    const changeOneByte = (from: string, at: number, last = false) => {
      const index = last ? file.lastIndexOf(from) : file.indexOf(from);
      expect(index, `${from} is in the file`).toBeGreaterThanOrEqual(0);
      const position = index + at;
      const original = file[position] ?? "";
      const replacement = /[0-9]/.test(original)
        ? String((Number(original) + 1) % 10)
        : /[a-f]/.test(original)
          ? original === "a"
            ? "b"
            : "a"
          : original === "x"
            ? "y"
            : "x";
      const changed = file.slice(0, position) + replacement + file.slice(position + 1);
      expect(changed.length).toBe(file.length);
      expect(changed).not.toBe(file);
      return changed;
    };

    const cases: [string, string, number, boolean?][] = [
      ["an action", `"action": "${String(entry.action)}"`, 13],
      ["a subject id", `"subjectId": "${String(entry.subjectId)}"`, 15],
      ["a detail value", `"mode": "batch"`, 10],
      ["a time", `"at": "${String(entry.at)}"`, 10],
      ["a seq", `"chainSeq": ${String(entry.chainSeq)}`, 12],
      ["a prevHash", `"prevHash": "${String(entry.prevHash)}"`, 20],
      ["an entryHash", `"entryHash": "${String(entry.entryHash)}"`, 20],
      ["a canonical text", `"canonical": "${String(entry.canonical).slice(0, 4)}`, 15],
      ["a checkpoint's signature", `"signature": "${String(checkpoint.signature)}"`, 20],
      ["a checkpoint's time", `"signedAt": "${String(checkpoint.signedAt)}"`, 17],
      ["a checkpoint's key id", `"kid": "${String(checkpoint.kid)}"`, 9],
      ["a checkpoint's head", `"entryHash": "${String(checkpoint.entryHash)}"`, 20, true],
    ];
    for (const [what, from, at, last] of cases) {
      const result = await run(changeOneByte(from, at, last));
      expect(result.code, what).toBe(1);
      expect(result.err, what).toMatch(/^FAILED: \d+ problems?\./);
    }
  });

  it("fails on a reordered or truncated chain, a key it doesn't have, or a retired key used too late", async () => {
    const exported = JSON.parse(await exportFile()) as {
      workspaces: { tables: { audit_log: { chainSeq: number }[] } }[];
      audit: { keys: { retiredAt?: string }[] };
    };
    const log = exported.workspaces[0]?.tables.audit_log ?? [];

    const reordered = structuredClone(exported);
    const [x, y] = [
      reordered.workspaces[0]?.tables.audit_log[1],
      reordered.workspaces[0]?.tables.audit_log[2],
    ];
    if (x && y) [x.chainSeq, y.chainSeq] = [y.chainSeq, x.chainSeq];
    expect((await verifyAuditExport(reordered)).problems.map((p) => p.kind)).toContain("prev_hash");

    const missing = structuredClone(exported);
    missing.workspaces[0]?.tables.audit_log.splice(1, 1);
    const gap = await verifyAuditExport(missing);
    expect(gap.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "gap", seq: 2 })]),
    );

    const other = await testSigner();
    const wrongKeys = await verifyAuditExport(exported, [other.signer.publicKey]);
    expect(new Set(wrongKeys.problems.map((p) => p.kind))).toEqual(new Set(["unknown_kid"]));

    const retired = structuredClone(exported);
    for (const key of retired.audit.keys) key.retiredAt = "2000-01-01T00:00:00.000Z";
    expect(new Set((await verifyAuditExport(retired)).problems.map((p) => p.kind))).toEqual(
      new Set(["signed_after_retirement"]),
    );
    expect(log.length).toBe(5);
  });

  it("says when the development key signed, and refuses what isn't an export", async () => {
    const devState = await loadAuditSigningKey({}, { development: true });
    if (!("signer" in devState)) throw new Error("no dev signer");
    await db.delete(auditCheckpoints);
    await withTenant(db, A, async (tx) => {
      const { head } = await recordAudit(tx, [{ action: "proposal.approved" }]);
      await writeCheckpoint(tx, devState.signer, head, "review");
    });
    const exported = await buildAccountExport(db, A.userId, new Date(), {
      auditKeys: [devState.signer.publicKey],
    });
    const result = await verifyAuditExport(JSON.parse(JSON.stringify(exported)));
    expect(result.ok).toBe(true);
    expect(result.workspaces[0]?.developmentSignatures).toBe(1);
    const printed = await run(JSON.stringify(exported));
    expect(printed.out).toContain("signed with the development key");

    for (const bad of [
      null,
      [],
      { format: "something-else" },
      { ...exported, audit: { form: 2, keys: [] } },
    ]) {
      expect((await verifyAuditExport(bad)).ok, JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
    expect((await run("{not json")).code).toBe(1);
  });

  it("refuses bad arguments without echoing them", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      readText: async () => {
        throw new Error("ENOENT");
      },
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    };
    expect(await auditVerify({ argv: [], ...io })).toBe(1);
    expect(await auditVerify({ argv: ["a.json", "b.json"], ...io })).toBe(1);
    expect(await auditVerify({ argv: ["a.json", "--keys"], ...io })).toBe(1);
    expect(await auditVerify({ argv: ["a.json", "--secret=sk-CANARY"], ...io })).toBe(1);
    expect(await auditVerify({ argv: ["missing.json"], ...io })).toBe(1);
    expect(err.join("\n")).not.toContain("sk-CANARY");
    expect(out).toEqual([]);
  });

  it("never carries a private key: not the deployment's, not the development key", async () => {
    const file = await exportFile();
    const devD = (JSON.parse(DEV_AUDIT_SIGNING_KEY) as { d: string }).d;
    expect(findSecretFragment(file, privateD)).toBeUndefined();
    expect(findSecretFragment(file, devD)).toBeUndefined();
    expect(file).not.toMatch(/"d"\s*:/);
  });
});
