import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AuditPublicKey,
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
  escapeControls,
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

/**
 * Whether printed text holds a character that steers a terminal or reorders text: C0 (other than
 * the newlines between lines), DEL, C1, line separators, or bidi controls. Written out here, apart
 * from escapeControls, so the test doesn't trust the code it tests.
 */
function hasRawControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) continue;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

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

  /** Two review requests, each with its checkpoint, as WP3's writers will record them. */
  async function recordReviews(reviewSigner: AuditSigner): Promise<void> {
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
        await writeCheckpoint(tx, reviewSigner, head, "review");
      });
    }
  }

  /**
   * An export as the route writes it, after two review requests: signed through its head by
   * `exportSigner` (this file's key by default; null for an export with no signing key).
   */
  async function exportFile(
    options: {
      readonly reviewSigner?: AuditSigner;
      readonly exportSigner?: AuditSigner | null;
      readonly keys?: AuditPublicKey[];
    } = {},
  ): Promise<string> {
    await recordReviews(options.reviewSigner ?? signer);
    const exportSigner = options.exportSigner === undefined ? signer : options.exportSigner;
    const exported = await buildAccountExport(db, A.userId, new Date(), {
      auditKeys: options.keys ?? [signer.publicKey],
      ...(exportSigner ? { signer: exportSigner } : {}),
    });
    return `${JSON.stringify(exported, null, 2)}\n`;
  }

  async function run(file: string, flags: string[] = [], keysFile?: string) {
    const out: string[] = [];
    const err: string[] = [];
    const files: Record<string, string> = {
      "export.json": file,
      ...(keysFile ? { "keys.json": keysFile } : {}),
    };
    const code = await auditVerify({
      argv: ["export.json", ...flags, ...(keysFile ? ["--keys", "keys.json"] : [])],
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

  it("passes on an export signed through its head: links, hashes, canonical texts, and signatures", async () => {
    const file = await exportFile();
    const result = await verifyAuditExport(JSON.parse(file));
    expect(result.problems).toEqual([]);
    expect(result).toMatchObject({
      ok: true,
      intact: true,
      unsignedEntries: 0,
      keySource: "export",
    });
    expect(result.workspaces).toEqual([
      {
        workspaceId: A.workspaceId,
        entries: 5, // the seeded entry, three reviews, and account.exported
        checkpoints: 3, // two review requests and the export's own
        head: { seq: 5, entryHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
        signedThrough: 5,
        unsignedTail: 0,
        developmentSignatures: 0,
      },
    ]);
    const checkpoints = (
      JSON.parse(file) as {
        workspaces: { tables: { audit_checkpoints: { request: string; chainSeq: number }[] } }[];
      }
    ).workspaces[0]?.tables.audit_checkpoints;
    expect(checkpoints?.map((c) => [c.request, c.chainSeq])).toEqual([
      ["review", 2],
      ["review", 4],
      ["export", 5],
    ]);

    const printed = await run(file);
    expect(printed).toMatchObject({ code: 0, err: "" });
    expect(printed.out).toContain("signed through its head");
    expect(printed.out).toMatch(/^OK: every link, hash, canonical text, and signature checks out/m);

    // With the keys saved from /api/audit/keys instead of the file's own.
    const keysFile = JSON.stringify({ keys: [signer.publicKey] });
    expect(await run(file, [], keysFile)).toMatchObject({ code: 0 });
  });

  it("fails on entries no checkpoint signs; --allow-unsigned-tail says the chain is intact and exits 2", async () => {
    // An export from a deployment with no signing key: its own entry is after the last checkpoint.
    const file = await exportFile({ exportSigner: null });

    const strict = await verifyAuditExport(JSON.parse(file));
    expect(strict).toMatchObject({ ok: false, intact: true, unsignedEntries: 1 });
    expect(strict.problems).toEqual([
      expect.objectContaining({ workspaceId: A.workspaceId, kind: "unsigned_tail", seq: 5 }),
    ]);
    expect(strict.workspaces[0]).toMatchObject({ signedThrough: 4, unsignedTail: 1 });
    const failed = await run(file);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("FAILED: 1 problem.");
    expect(failed.err).toContain("Entry 5 isn't signed by any checkpoint");
    expect(failed.err).toContain("--allow-unsigned-tail");
    expect(failed.out).toContain("signed through seq 4 (1 later entry unsigned)");
    expect(failed.out).not.toMatch(/^OK/m);

    const accepted = await verifyAuditExport(JSON.parse(file), { allowUnsignedTail: true });
    expect(accepted).toMatchObject({ ok: false, intact: true, unsignedEntries: 1, problems: [] });
    const intact = await run(file, ["--allow-unsigned-tail"]);
    expect(intact).toMatchObject({ code: 2, err: "" });
    expect(intact.out).toContain("Chain intact, 1 entry unsigned");
    expect(intact.out).not.toMatch(/^OK/m);

    // Accepting an unsigned tail accepts nothing else.
    const tampered = file.replace('"mode": "batch"', '"mode": "batcx"');
    expect((await run(tampered, ["--allow-unsigned-tail"])).code).toBe(1);
  });

  it("counts nothing as signed in a workspace no checkpoint signs", async () => {
    await db.delete(auditCheckpoints);
    const exported = await buildAccountExport(db, A.userId, new Date(), {
      auditKeys: [signer.publicKey],
    });
    const result = await verifyAuditExport(JSON.parse(JSON.stringify(exported)));
    expect(result.workspaces[0]).toMatchObject({ signedThrough: null, unsignedTail: 2 });
    expect(result.problems).toEqual([
      expect.objectContaining({
        kind: "unsigned_tail",
        seq: 1,
        message: expect.stringMatching(/^Entries 1 to 2 aren't signed/),
      }),
    ]);
    expect((await run(JSON.stringify(exported))).out).toContain(
      "no checkpoint signs it (2 entries unsigned)",
    );
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
      expect(result.out, what).not.toMatch(/^OK/m);
    }
  });

  it("fails on a reordered or truncated chain, a key it doesn't have, or a retired key used too late", async () => {
    const exported = JSON.parse(await exportFile()) as {
      workspaces: { tables: { audit_log: { chainSeq: number }[] } }[];
      audit: { keys: { retiredAt?: string }[] };
    };
    expect(exported.workspaces[0]?.tables.audit_log).toHaveLength(5);

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

    // Signatures that don't count leave the whole chain unsigned, too.
    const other = await testSigner();
    const wrongKeys = await verifyAuditExport(exported, [other.signer.publicKey]);
    expect(new Set(wrongKeys.problems.map((p) => p.kind))).toEqual(
      new Set(["unknown_kid", "unsigned_tail"]),
    );
    expect(wrongKeys.ok).toBe(false);

    const retired = structuredClone(exported);
    for (const key of retired.audit.keys) key.retiredAt = "2000-01-01T00:00:00.000Z";
    expect(new Set((await verifyAuditExport(retired)).problems.map((p) => p.kind))).toEqual(
      new Set(["signed_after_retirement", "unsigned_tail"]),
    );
  });

  it("doesn't count the development key's signatures unless asked, whatever kid it's listed under", async () => {
    const devState = await loadAuditSigningKey({}, { development: true });
    if (!("signer" in devState)) throw new Error("no dev signer");
    const dev = devState.signer;
    const file = await exportFile({ reviewSigner: dev, exportSigner: dev, keys: [dev.publicKey] });

    const strict = await verifyAuditExport(JSON.parse(file));
    expect(strict).toMatchObject({ ok: false, intact: true, unsignedEntries: 5 });
    expect(strict.workspaces[0]).toMatchObject({ signedThrough: null, developmentSignatures: 3 });
    expect(strict.problems).toEqual([
      expect.objectContaining({
        kind: "unsigned_tail",
        message: expect.stringContaining("the development key's don't count"),
      }),
    ]);
    const failed = await run(file);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("3 checkpoints signed with the development key didn't count");

    expect((await verifyAuditExport(JSON.parse(file), { allowDevelopmentKey: true })).ok).toBe(
      true,
    );
    const counted = await run(file, ["--allow-development-key"]);
    expect(counted.code).toBe(0);
    expect(counted.out).toContain("counted, as --allow-development-key asked");
    expect(counted.out).toMatch(/^OK: /m);

    // Anyone holding the development key can sign under a kid of their choosing; its public half
    // still gives it away.
    const relabeledState = await loadAuditSigningKey(
      {
        EARSHOT_AUDIT_SIGNING_KEY: JSON.stringify({
          ...(JSON.parse(DEV_AUDIT_SIGNING_KEY) as Record<string, string>),
          kid: "audit-2026-11-20-beef",
        }),
      },
      { development: true },
    );
    if (!("signer" in relabeledState)) throw new Error("no relabeled signer");
    const relabeled = relabeledState.signer;
    const disguised = await exportFile({
      reviewSigner: relabeled,
      exportSigner: relabeled,
      keys: [relabeled.publicKey],
    });
    const caught = await verifyAuditExport(JSON.parse(disguised));
    expect(caught.ok).toBe(false);
    expect(caught.workspaces[0]?.developmentSignatures).toBe(3);
  });

  it("refuses what isn't an export, ids that aren't UUIDs, and malformed keys, and escapes what it prints", async () => {
    for (const bad of [null, [], { format: "something-else" }]) {
      expect((await verifyAuditExport(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect((await run("{not json")).code).toBe(1);

    const file = await exportFile();
    // Clear the screen, retitle the window, recolour (a C1 CSI), and reverse the text after it.
    const ESCAPES = "\u001b[2J\u001b]0;pwned\u0007\u009b31m\u202e";
    type Editable = {
      audit: { keys: Record<string, unknown>[] };
      workspaces: { id: string; tables: { audit_checkpoints: Record<string, unknown>[] } }[];
    };
    const edited = (edit: (exported: Editable) => void): string => {
      const exported = JSON.parse(file) as Editable;
      edit(exported);
      return JSON.stringify(exported);
    };
    const checkpointAt = (exported: Editable, index: number): Record<string, unknown> => {
      const checkpoint = exported.workspaces[0]?.tables.audit_checkpoints[index];
      if (!checkpoint) throw new Error(`no checkpoint ${index}`);
      return checkpoint;
    };
    const variants: [string, string, RegExp][] = [
      [
        "a workspace id",
        edited((e) => {
          const workspace = e.workspaces[0];
          if (workspace) workspace.id = `${A.workspaceId}${ESCAPES}`;
        }),
        /A workspace's id isn't a UUID, so the file was refused\./,
      ],
      [
        "a checkpoint id",
        edited((e) => {
          checkpointAt(e, 0).id = `x${ESCAPES}`;
        }),
        /A checkpoint's id isn't a UUID, so the file was refused\./,
      ],
      [
        "a public key's kid",
        edited((e) => {
          const key = e.audit.keys[0];
          if (key) key.kid = `audit${ESCAPES}`;
        }),
        /The export's audit keys aren't well-formed public keys\./,
      ],
      [
        "a checkpoint's kid, which reaches a message",
        edited((e) => {
          checkpointAt(e, 1).kid = `audit${ESCAPES}`;
        }),
        /isn't among the keys/,
      ],
    ];
    for (const [what, crafted, message] of variants) {
      const printed = await run(crafted);
      expect(printed.code, what).toBe(1);
      expect(printed.err, what).toMatch(message);
      expect(hasRawControl(printed.out + printed.err), what).toBe(false);
    }
    // The kid that reached a message is there, escaped and quoted.
    const shown = await run(variants[3]?.[1] ?? "");
    expect(shown.err).toContain(String.raw`"audit\u001b[2J\u001b]0;pwned\u0007\u009b31m\u202e"`);

    // A keys file whose kid carries escapes is refused without echoing it.
    const badKeys = JSON.stringify({ keys: [{ ...signer.publicKey, kid: `audit${ESCAPES}` }] });
    const refused = await run(file, [], badKeys);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("well-formed public keys");
    expect(hasRawControl(refused.out + refused.err)).toBe(false);
  });

  it("escapes control characters, line separators, and bidi marks, and nothing else", () => {
    expect(
      escapeControls("a\u0000b\u001b[31m\u007f\u0085\u009b\u2028\u2029\u202e\u2066\u200f"),
    ).toBe(String.raw`a\u0000b\u001b[31m\u007f\u0085\u009b\u2028\u2029\u202e\u2066\u200f`);
    expect(escapeControls("Ünïcødé ✓ 😀 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(
      "Ünïcødé ✓ 😀 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
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
