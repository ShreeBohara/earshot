import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  findSecretFragment,
  generateMasterKey,
  importMasterKey,
  openSecret,
  type ProviderId,
  sealSecret,
} from "@earshot/keys/server";
import type { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { main } from "../scripts/rotate-vault-key";
import { auditLog, credentials, crmConnections } from "../src/schema";
import { withTenant } from "../src/tenant";
import {
  crmConnectionContext,
  putCredential,
  revealCredential,
  sealedOf,
  VaultOpenError,
} from "../src/vault";
import { rotateVaultKey, VaultRotationError } from "../src/vault-rotation";
import { A, B, cloneDb, rowId, seededDb } from "./db";

type Db = Awaited<ReturnType<typeof seededDb>>["db"];
type Tenant = typeof A;

// Three master keys: the current one, the next one, and one that never sealed anything.
const OLD = generateMasterKey();
const NEW = generateMasterKey();
const STRANGER = generateMasterKey();

// What the vault holds: AI keys in `credentials`, CRM tokens in `crm_connections`.
const KEYS: ReadonlyArray<[Tenant, ProviderId, string, string]> = [
  [A, "openai", "default", "sk-proj-ROTATEcanaryAq7Xw2Lp9Rt4Mn8Bv6CxKs"],
  [A, "anthropic", "work", "sk-ant-api03-ROTATEcanaryBz3Jy1Uz7Io9Pq2Ks4"],
  [B, "openai", "default", "sk-proj-ROTATEcanaryCh5Kd3Fy1Ue7Io9Pa2Ks"],
];
const TOKENS: ReadonlyArray<[string, string]> = [
  [rowId("a", 2), "pat-na1-ROTATEcanaryDw2Lp9Rt4Mn8Bv6Cx"],
  [rowId("b", 2), "twenty-ROTATEcanaryEq7Xw2Lp9Rt4Mn8Bv"],
];
const PLAINTEXTS = [...KEYS.map(([, , , key]) => key), ...TOKENS.map(([, token]) => token)];

let template: PGlite;
let oldMaster: CryptoKey;
let newMaster: CryptoKey;
let stranger: CryptoKey;
let client: PGlite;
let db: Db;

beforeAll(async () => {
  oldMaster = await importMasterKey(OLD);
  newMaster = await importMasterKey(NEW);
  stranger = await importMasterKey(STRANGER);
  // Replace the seed's placeholder envelopes with real ones sealed under OLD.
  const seeded = await seededDb();
  template = seeded.client;
  for (const [tenant, provider, label, secret] of KEYS) {
    await withTenant(seeded.db, tenant, (tx) =>
      putCredential(tx, oldMaster, { provider, label, secret }),
    );
  }
  for (const [id, token] of TOKENS) {
    const [row] = await seeded.db.select().from(crmConnections).where(eq(crmConnections.id, id));
    if (!row) throw new Error(`seed is missing CRM connection ${id}`);
    const sealed = await sealSecret(oldMaster, token, crmConnectionContext(row));
    await seeded.db.update(crmConnections).set(sealed).where(eq(crmConnections.id, id));
  }
});

beforeEach(async () => {
  ({ client, db } = await cloneDb(template));
});

afterEach(async () => {
  await client.close();
});

/** The vault's envelopes and the audit log, to show a run changed nothing. */
async function snapshot() {
  return {
    credentials: await db.select().from(credentials).orderBy(asc(credentials.id)),
    crmConnections: await db.select().from(crmConnections).orderBy(asc(crmConnections.id)),
    auditLog: await db.select().from(auditLog).orderBy(asc(auditLog.id)),
  };
}

/** Every key and token opens with `master`. */
async function expectAllOpenWith(master: CryptoKey) {
  for (const [tenant, provider, label, secret] of KEYS) {
    const revealed = await withTenant(db, tenant, (tx) =>
      revealCredential(tx, master, { provider, label }),
    );
    expect(revealed).toBe(secret);
  }
  for (const [id, token] of TOKENS) {
    const [row] = await db.select().from(crmConnections).where(eq(crmConnections.id, id));
    if (!row) throw new Error(`missing CRM connection ${id}`);
    expect(await openSecret(master, sealedOf(row), crmConnectionContext(row))).toBe(token);
  }
}

/** No key or token opens with `master`. */
async function expectNoneOpenWith(master: CryptoKey) {
  for (const [tenant, provider, label] of KEYS) {
    await expect(
      withTenant(db, tenant, (tx) => revealCredential(tx, master, { provider, label })),
    ).rejects.toThrow(VaultOpenError);
  }
  for (const [id] of TOKENS) {
    const [row] = await db.select().from(crmConnections).where(eq(crmConnections.id, id));
    if (!row) throw new Error(`missing CRM connection ${id}`);
    await expect(openSecret(master, sealedOf(row), crmConnectionContext(row))).rejects.toThrow();
  }
}

/** No master key, stored secret, or connection-string password appears, even in part. */
function expectNoKeyMaterial(output: string, extra: readonly string[] = []) {
  const masters = [OLD, NEW, STRANGER];
  const forms = masters.flatMap((key) => [key, Buffer.from(key, "base64").toString("hex")]);
  for (const secret of [...forms, ...PLAINTEXTS, ...extra]) {
    expect(findSecretFragment(output, secret), "key material in the output").toBeUndefined();
  }
}

describe("rotateVaultKey", () => {
  it("re-wraps every data key in every workspace, leaving each ciphertext as it was", async () => {
    const before = await snapshot();
    const report = await rotateVaultKey(db, oldMaster, newMaster);
    expect(report).toEqual({ dryRun: false, credentials: 3, crmConnections: 2, workspaces: 2 });

    const after = await snapshot();
    for (const table of ["credentials", "crmConnections"] as const) {
      expect(after[table]).toHaveLength(before[table].length);
      after[table].forEach((row, i) => {
        const was = before[table][i];
        expect(row.id).toBe(was?.id);
        expect(row.ciphertext).toEqual(was?.ciphertext);
        expect(row.iv).toEqual(was?.iv);
        expect(row.wrappedDek).not.toEqual(was?.wrappedDek);
        expect(row.dekIv).not.toEqual(was?.dekIv);
      });
    }
    await expectAllOpenWith(newMaster);
    await expectNoneOpenWith(oldMaster);
  });

  it("writes one system audit entry per workspace, with counts only", async () => {
    await rotateVaultKey(db, oldMaster, newMaster);
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "credential.rotated"))
      .orderBy(asc(auditLog.workspaceId));

    expect(
      entries.map(({ workspaceId, actorUserId, subjectType, subjectId, detail }) => ({
        workspaceId,
        actorUserId,
        subjectType,
        subjectId,
        detail,
      })),
    ).toEqual([
      {
        workspaceId: A.workspaceId,
        actorUserId: null,
        subjectType: null,
        subjectId: null,
        detail: { credentials: 2, crmConnections: 1 },
      },
      {
        workspaceId: B.workspaceId,
        actorUserId: null,
        subjectType: null,
        subjectId: null,
        detail: { credentials: 1, crmConnections: 1 },
      },
    ]);
    expectNoKeyMaterial(JSON.stringify(entries));
  });

  it("changes nothing when the old key is wrong", async () => {
    const before = await snapshot();
    const error = await rotateVaultKey(db, stranger, newMaster).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VaultRotationError);
    expect(error).toMatchObject({ credentials: 3, crmConnections: 2 });
    expectNoKeyMaterial(String(error));
    expect(await snapshot()).toEqual(before);
    await expectAllOpenWith(oldMaster);
  });

  it("changes nothing when a single row doesn't open", async () => {
    // The owner moves one credential to another label, so its context no longer matches.
    await db
      .update(credentials)
      .set({ label: "moved" })
      .where(eq(credentials.provider, "anthropic"));
    const before = await snapshot();

    const error = await rotateVaultKey(db, oldMaster, newMaster).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultRotationError);
    expect(error).toMatchObject({ credentials: 1, crmConnections: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it("checks every row in a dry run, and changes nothing", async () => {
    const before = await snapshot();
    expect(await rotateVaultKey(db, oldMaster, newMaster, { dryRun: true })).toEqual({
      dryRun: true,
      credentials: 3,
      crmConnections: 2,
      workspaces: 2,
    });
    expect(await snapshot()).toEqual(before);
    await expectAllOpenWith(oldMaster);

    // A dry run reports a wrong old key the same way a real run does.
    await expect(rotateVaultKey(db, stranger, newMaster, { dryRun: true })).rejects.toThrow(
      VaultRotationError,
    );
  });

  it("refuses to rotate to the same key, however it's written", async () => {
    const before = await snapshot();
    const again = await importMasterKey(OLD.replace(/(.{4})/g, "$1 "));
    await expect(rotateVaultKey(db, oldMaster, again)).rejects.toThrow(/same key/);
    expect(await snapshot()).toEqual(before);
  });

  it("does nothing, and audits nothing, for an empty vault", async () => {
    await db.delete(credentials);
    await db.delete(crmConnections);
    expect(await rotateVaultKey(db, oldMaster, newMaster)).toEqual({
      dryRun: false,
      credentials: 0,
      crmConnections: 0,
      workspaces: 0,
    });
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "credential.rotated")),
    ).toEqual([]);
  });
});

describe("db:rotate-vault-key", () => {
  // A password the URL has to percent-encode, so both of its forms are in play.
  const PASSWORD = "Sup3r/Secret:Passw0rd@Owner#1";
  const ENCODED_PASSWORD = encodeURIComponent(PASSWORD);
  const URL_WITHOUT_QUERY = `postgresql://owner:${ENCODED_PASSWORD}@db.example.test/earshot`;
  const env = {
    DATABASE_URL_DIRECT: `${URL_WITHOUT_QUERY}?sslmode=require&application_name=rotate`,
    EARSHOT_VAULT_MASTER_KEY_OLD: OLD,
    EARSHOT_VAULT_MASTER_KEY_NEW: NEW,
  };
  const PASSWORDS = [PASSWORD, ENCODED_PASSWORD];

  /** Runs the script's main() against this test's database and collects what it prints. */
  async function run(argv: string[], overrides: Record<string, string | undefined> = {}) {
    const lines: string[] = [];
    const code = await main({
      argv,
      env: { ...env, ...overrides },
      rotate: (_url, from, to, options) => rotateVaultKey(db, from, to, options),
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    });
    return { code, output: lines.join("\n") };
  }

  /** Runs main() with a rotation that throws `error`, and collects what it prints. */
  async function failWith(error: Error) {
    const lines: string[] = [];
    const code = await main({
      argv: [],
      env,
      rotate: async () => {
        throw error;
      },
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    });
    return { code, output: lines.join("\n") };
  }

  it("uses a password whose encoded and decoded forms differ", () => {
    expect(new URL(env.DATABASE_URL_DIRECT).password).toBe(ENCODED_PASSWORD);
    expect(ENCODED_PASSWORD).not.toBe(PASSWORD);
  });

  it("prints counts, and no key material, for a dry run and then a real run", async () => {
    const dry = await run(["--dry-run"]);
    expect(dry).toEqual({
      code: 0,
      output: expect.stringMatching(
        /^Dry run: 3 credentials and 2 CRM connections in 2 workspaces .* Nothing was changed\.$/,
      ),
    });
    await expectAllOpenWith(oldMaster);

    // pnpm can pass a bare "--" through; it's ignored, so this is a real run.
    const real = await run(["--"]);
    expect(real).toEqual({
      code: 0,
      output: expect.stringMatching(
        /^Re-wrapped 3 credentials and 2 CRM connections in 2 workspaces/,
      ),
    });
    await expectAllOpenWith(newMaster);

    expectNoKeyMaterial(`${dry.output}\n${real.output}`, PASSWORDS);
  });

  it("refuses the same key twice, without changing anything", async () => {
    const before = await snapshot();
    const result = await run([], { EARSHOT_VAULT_MASTER_KEY_NEW: ` ${OLD}\n` });
    expect(result).toEqual({ code: 1, output: expect.stringMatching(/are the same key/) });
    expectNoKeyMaterial(result.output, PASSWORDS);
    expect(await snapshot()).toEqual(before);
  });

  it("fails with counts only, and changes nothing, when the old key is wrong", async () => {
    const before = await snapshot();
    const result = await run([], { EARSHOT_VAULT_MASTER_KEY_OLD: STRANGER });
    expect(result).toEqual({
      code: 1,
      output: expect.stringMatching(/^3 credentials and 2 CRM connections don't open with/),
    });
    expectNoKeyMaterial(result.output, PASSWORDS);
    expect(await snapshot()).toEqual(before);
  });

  it("explains missing or malformed settings and unknown arguments without echoing them", async () => {
    const missing = await run([], {
      EARSHOT_VAULT_MASTER_KEY_OLD: undefined,
      EARSHOT_VAULT_MASTER_KEY_NEW: "  ",
    });
    expect(missing.code).toBe(1);
    expect(missing.output).toMatch(
      /^Missing EARSHOT_VAULT_MASTER_KEY_OLD, EARSHOT_VAULT_MASTER_KEY_NEW\./,
    );

    const malformed = await run([], { EARSHOT_VAULT_MASTER_KEY_OLD: "not-a-real-master-key" });
    expect(malformed.code).toBe(1);
    expect(malformed.output).toMatch(/^EARSHOT_VAULT_MASTER_KEY_OLD isn't a master key/);

    const pasted = await run([STRANGER]);
    expect(pasted.code).toBe(1);
    expect(pasted.output).toMatch(/^Unknown argument\./);

    for (const { output } of [missing, malformed, pasted]) {
      expectNoKeyMaterial(output, [...PASSWORDS, "not-a-real-master-key"]);
    }
  });

  it("keeps the connection string and query parameters out of error output", async () => {
    for (const quoted of [env.DATABASE_URL_DIRECT, URL_WITHOUT_QUERY, PASSWORD, ENCODED_PASSWORD]) {
      const refused = await failWith(new Error(`connect ECONNREFUSED ${quoted}`));
      expect(refused.code).toBe(1);
      expect(refused.output).toMatch(/ECONNREFUSED/);
      expect(refused.output).not.toContain("db.example.test");
      expectNoKeyMaterial(refused.output, PASSWORDS);
    }

    // Drizzle's query errors quote parameters, which here would be wrapped data keys.
    const query = Object.assign(new Error(`Failed query: update … params: ${NEW}`), {
      name: "DrizzleQueryError",
    });
    const failed = await failWith(query);
    expect(failed.output).toMatch(/DrizzleQueryError: query failed/);
    expectNoKeyMaterial(failed.output);
  });

  it("redacts an error before shortening it, so no secret survives the cut", async () => {
    // "Error: " plus this padding puts the 300-character cut ten characters into the secret.
    const padding = "x".repeat(300 - "Error: ".length - 10);
    const secrets = [
      NEW,
      OLD,
      PASSWORD,
      ENCODED_PASSWORD,
      env.DATABASE_URL_DIRECT,
      URL_WITHOUT_QUERY,
    ];
    for (const secret of secrets) {
      const result = await failWith(new Error(`${padding}${secret} and then more text`));
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/^The rotation failed: Error: x+/);
      expect(result.output).not.toContain("db.example.test");
      expectNoKeyMaterial(result.output, PASSWORDS);
    }

    // Both master keys and the password in one message, the key straddling the cut.
    const both = await failWith(new Error(`${padding}${NEW} ${PASSWORD} ${OLD}`));
    expectNoKeyMaterial(both.output, PASSWORDS);
  });

  it("runs as a package script, and says what's missing before it connects", async () => {
    const script = fileURLToPath(new URL("../scripts/rotate-vault-key.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const result = await promisify(execFile)(process.execPath, [tsx, script, "--dry-run"], {
      env: { PATH: process.env.PATH, EARSHOT_VAULT_MASTER_KEY_OLD: OLD },
      timeout: 60_000,
    }).catch((error: { code: number; stdout: string; stderr: string }) => error);

    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toMatch(/^Missing DATABASE_URL_DIRECT, EARSHOT_VAULT_MASTER_KEY_NEW\./);
    expectNoKeyMaterial(result.stderr);
  });
});
