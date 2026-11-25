// Approval policies in Postgres (Phase 5 WP11): the latest version, each change's next version with
// its `policy.changed` audit entry and signed checkpoint, a change made from an old version refused,
// a change to nothing written as nothing, and row-level security keeping each workspace's policy its
// own. On PGlite with every migration.
import { type ApprovalPolicyRules, canonicalJson } from "@earshot/core";
import { type AuditSigner, loadAuditSigningKey } from "@earshot/keys/server";
import type { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { exportAuditChain, verifyAuditExport } from "../src/audit-chain";
import {
  POLICY_CHANGED_ACTION,
  readApprovalPolicy,
  rulesSha256,
  writeApprovalPolicy,
} from "../src/policies";
import { AuditUnavailableError } from "../src/reviews";
import { approvalPolicies, auditCheckpoints, auditLog } from "../src/schema";
import { withTenant } from "../src/tenant";
import { A, B, cloneDb, migratedDb } from "./db";
import { createTenant } from "./tenants";

type Db = Awaited<ReturnType<typeof migratedDb>>["db"];

const NOW = new Date("2026-11-20T12:00:00.000Z");
const AUTH = { method: "passkey" as const, signedInAt: "2026-11-20T11:58:30.000Z" };
const POLICY_ID = "01a1c6f2-7d10-7a3b-9c4d-5e6f7a8b9c0d";

const NOTES: ApprovalPolicyRules = {
  v: 1,
  autoApprove: [{ id: "notes", type: "note", alwaysReview: [] }],
};
const NOTES_AND_DEALS: ApprovalPolicyRules = {
  v: 1,
  autoApprove: [
    { id: "notes", type: "note", alwaysReview: [] },
    { id: "deal-updates", type: "deal_update", alwaysReview: ["amount", "stage"] },
  ],
};

let template: PGlite;
let signer: AuditSigner;
const opened: PGlite[] = [];

beforeAll(async () => {
  const signing = await loadAuditSigningKey({}, { development: true });
  if (signing.status !== "development") throw new Error("no development key");
  signer = signing.signer;
  const { client, db } = await migratedDb();
  await createTenant(db, A);
  await createTenant(db, B);
  template = client;
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((client) => client.close()));
});

afterAll(async () => {
  await template.close();
});

async function fresh(): Promise<Db> {
  const copy = await cloneDb(template);
  opened.push(copy.client);
  return copy.db;
}

function change(rules: ApprovalPolicyRules, baseVersion: number, overrides = {}) {
  return {
    rules,
    baseVersion,
    auth: AUTH,
    signer,
    newId: () => POLICY_ID,
    now: NOW,
    ...overrides,
  };
}

describe("readApprovalPolicy", () => {
  it("is null for a workspace with no policy", async () => {
    const db = await fresh();
    expect(await withTenant(db, A, (tx) => readApprovalPolicy(tx))).toBeNull();
  });

  it("refuses to run outside a tenant transaction, where RLS wouldn't apply", async () => {
    const db = await fresh();
    await expect(
      db.transaction((tx) => readApprovalPolicy(tx as Parameters<typeof readApprovalPolicy>[0])),
    ).rejects.toThrow(TypeError);
  });

  it("reads a version whose rules no longer parse as invalid, so nothing applies", async () => {
    const db = await fresh();
    await db.insert(approvalPolicies).values({
      workspaceId: A.workspaceId,
      id: POLICY_ID,
      version: 1,
      rules: { v: 2, autoApprove: [] },
      rulesSha256: "0".repeat(64),
      createdBy: A.userId,
    });
    expect(await withTenant(db, A, (tx) => readApprovalPolicy(tx))).toBe("invalid");
  });
});

describe("writeApprovalPolicy", () => {
  it("writes version 1 under a new id, with the rules' hash, in the viewer's name, and an audit entry and a policy checkpoint", async () => {
    const db = await fresh();
    const outcome = await withTenant(db, A, (tx) => writeApprovalPolicy(tx, change(NOTES, 0)));
    expect(outcome).toMatchObject({
      ok: true,
      changed: true,
      policy: { id: POLICY_ID, version: 1, rules: NOTES, createdBy: A.userId },
      checkpoint: { request: "policy", kid: signer.kid },
    });
    const sha = await rulesSha256(NOTES);
    expect(sha).toBe(
      Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(NOTES))),
      ).toString("hex"),
    );

    const [row] = await db.select().from(approvalPolicies);
    expect(row).toMatchObject({
      workspaceId: A.workspaceId,
      id: POLICY_ID,
      version: 1,
      rules: NOTES,
      rulesSha256: sha,
      createdBy: A.userId,
    });

    // The audit entry names the policy's id and version, the rules' hash, and the sign-in.
    const entries = await db.select().from(auditLog);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      workspaceId: A.workspaceId,
      actorUserId: A.userId,
      action: POLICY_CHANGED_ACTION,
      subjectType: "approval_policy",
      subjectId: POLICY_ID,
      chainSeq: 1,
      detail: { policyId: POLICY_ID, version: 1, rulesSha256: sha, auth: AUTH },
    });
    const checkpoints = await db.select().from(auditCheckpoints);
    expect(checkpoints.map((c) => [c.chainSeq, c.request])).toEqual([[1, "policy"]]);

    // And the chain verifies offline, signed through the change.
    const chain = await withTenant(db, A, (tx) => exportAuditChain(tx));
    const verified = await verifyAuditExport(
      JSON.parse(
        JSON.stringify({
          format: "earshot.account-export",
          audit: { form: 1, keys: [signer.publicKey] },
          workspaces: [
            {
              id: A.workspaceId,
              tables: { audit_log: chain.entries, audit_checkpoints: chain.checkpoints },
            },
          ],
        }),
      ),
      { allowDevelopmentKey: true },
    );
    expect(verified.problems).toEqual([]);
    expect(verified.ok).toBe(true);
  });

  it("appends each change as the next version under the same id, and reads the latest", async () => {
    const db = await fresh();
    await withTenant(db, A, (tx) => writeApprovalPolicy(tx, change(NOTES, 0)));
    const second = await withTenant(db, A, (tx) =>
      writeApprovalPolicy(tx, change(NOTES_AND_DEALS, 1, { newId: () => "unused" })),
    );
    expect(second).toMatchObject({
      ok: true,
      changed: true,
      policy: { id: POLICY_ID, version: 2 },
    });
    const third = await withTenant(db, A, (tx) =>
      writeApprovalPolicy(tx, change({ v: 1, autoApprove: [] }, 2)),
    );
    expect(third).toMatchObject({ ok: true, policy: { version: 3, rules: { autoApprove: [] } } });

    expect(await withTenant(db, A, (tx) => readApprovalPolicy(tx))).toMatchObject({
      id: POLICY_ID,
      version: 3,
      rules: { v: 1, autoApprove: [] },
    });
    // Every version stays: the table is append-only.
    const rows = await db
      .select({ version: approvalPolicies.version, id: approvalPolicies.id })
      .from(approvalPolicies)
      .orderBy(asc(approvalPolicies.version));
    expect(rows).toEqual([1, 2, 3].map((version) => ({ version, id: POLICY_ID })));
    const entries = await db.select().from(auditLog).orderBy(asc(auditLog.chainSeq));
    expect(entries.map((entry) => (entry.detail as { version: number }).version)).toEqual([
      1, 2, 3,
    ]);
    expect((await db.select().from(auditCheckpoints)).map((c) => c.request)).toEqual([
      "policy",
      "policy",
      "policy",
    ]);
  });

  it("refuses a change made from an old version, writing nothing", async () => {
    const db = await fresh();
    await withTenant(db, A, (tx) => writeApprovalPolicy(tx, change(NOTES, 0)));
    for (const baseVersion of [0, 2]) {
      const outcome = await withTenant(db, A, (tx) =>
        writeApprovalPolicy(tx, change(NOTES_AND_DEALS, baseVersion)),
      );
      expect(outcome).toEqual({ ok: false, reason: "stale", current: 1 });
    }
    expect(await db.select().from(approvalPolicies)).toHaveLength(1);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it("writes nothing for rules equal to the latest version's", async () => {
    const db = await fresh();
    await withTenant(db, A, (tx) => writeApprovalPolicy(tx, change(NOTES, 0)));
    const same = await withTenant(db, A, (tx) =>
      writeApprovalPolicy(tx, change(JSON.parse(JSON.stringify(NOTES)), 1)),
    );
    expect(same).toMatchObject({
      ok: true,
      changed: false,
      checkpoint: null,
      policy: { version: 1 },
    });
    expect(await db.select().from(approvalPolicies)).toHaveLength(1);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it("fails closed without a signer, and refuses rules the writer's checks refuse, before writing", async () => {
    const db = await fresh();
    await expect(
      withTenant(db, A, (tx) => writeApprovalPolicy(tx, change(NOTES, 0, { signer: null }))),
    ).rejects.toThrow(AuditUnavailableError);
    const twoForOneType: ApprovalPolicyRules = {
      v: 1,
      autoApprove: [
        { id: "notes", type: "note", alwaysReview: [] },
        { id: "more-notes", type: "note", alwaysReview: [] },
      ],
    };
    await expect(
      withTenant(db, A, (tx) => writeApprovalPolicy(tx, change(twoForOneType, 0))),
    ).rejects.toThrow("a second rule for its proposal type");
    await expect(
      withTenant(db, A, (tx) =>
        writeApprovalPolicy(tx, change({ v: 2, autoApprove: [] } as never, 0)),
      ),
    ).rejects.toThrow(TypeError);
    expect(await db.select().from(approvalPolicies)).toEqual([]);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("keeps each workspace's policy its own: B neither reads nor extends A's", async () => {
    const db = await fresh();
    await withTenant(db, A, (tx) => writeApprovalPolicy(tx, change(NOTES, 0)));
    expect(await withTenant(db, B, (tx) => readApprovalPolicy(tx))).toBeNull();
    // B's first version starts at 1 under its own id, whatever A's are.
    const b = await withTenant(db, B, (tx) =>
      writeApprovalPolicy(
        tx,
        change(NOTES_AND_DEALS, 0, { newId: () => "01a1c6f2-7d10-7a3b-9c4d-5e6f7a8b9cbb" }),
      ),
    );
    expect(b).toMatchObject({
      ok: true,
      policy: { version: 1, id: "01a1c6f2-7d10-7a3b-9c4d-5e6f7a8b9cbb" },
    });
    expect(await withTenant(db, A, (tx) => readApprovalPolicy(tx))).toMatchObject({
      version: 1,
      rules: NOTES,
    });
    const bRows = await db
      .select()
      .from(approvalPolicies)
      .where(eq(approvalPolicies.workspaceId, B.workspaceId));
    expect(bRows.map((row) => row.createdBy)).toEqual([B.userId]);
    // Each workspace's chain starts at 1.
    const bEntries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, B.workspaceId));
    expect(bEntries.map((entry) => entry.chainSeq)).toEqual([1]);
  });
});
