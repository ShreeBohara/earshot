// Approval policies in Postgres (Phase 5 spec §4.6, WP11; docs/adr/0034): the latest version of a
// workspace's policy, for the session route's snapshot and Settings → Review, and the change the
// policy route writes once the viewer has stepped up: the next version, a `policy.changed` audit
// entry with the rules' hash and how the change's author signed in, and a signed checkpoint, in one
// transaction.
//
// Every function takes a transaction from `withTenant`, so row-level security confines it to one
// workspace, and the version and its audit entry name the transaction's user, as the tables'
// `actor_insert` policies require. The lock order: the workspace's policy lock first, then its audit
// lock, which the audit trigger takes at the insert and holds until commit.
import {
  ApprovalPolicyRules,
  canonicalJson,
  checkPolicyRules,
  type SignInMethod,
} from "@earshot/core";
import type { AuditSigner } from "@earshot/keys/server";
import { desc, eq, sql, type TablesRelationalConfig } from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { type AuditCheckpoint, recordAudit, writeCheckpoint } from "./audit-chain";
import { AuditUnavailableError } from "./reviews";
import { approvalPolicies } from "./schema";
import { currentTenant } from "./tenant";

type Tx<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> = PgTransaction<TQueryResult, TFullSchema, TSchema>;

/** The audit action a policy change records. */
export const POLICY_CHANGED_ACTION = "policy.changed";

/** A stored version of the workspace's policy. */
export interface ApprovalPolicyVersion {
  /** The policy's id: the same for every version of the workspace's policy. */
  readonly id: string;
  readonly version: number;
  readonly rules: ApprovalPolicyRules;
  /** Lowercase hex SHA-256 of the rules' canonical JSON. */
  readonly rulesSha256: string;
  readonly createdAt: Date;
  /** Who changed it; null once they've left the workspace. */
  readonly createdBy: string | null;
}

/** Lowercase hex SHA-256 of `rules`' canonical JSON (`canonicalJson` in `@earshot/core`). */
export async function rulesSha256(rules: ApprovalPolicyRules): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(rules)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The latest version of the transaction's workspace's policy, or null when it has none. A stored
 * version whose rules no longer parse (written by a later form, say) reads as `invalid`, and
 * callers apply nothing: no policy is safe, since every proposal then waits for a person.
 */
export async function readApprovalPolicy<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: Tx<TQueryResult, TFullSchema, TSchema>): Promise<ApprovalPolicyVersion | "invalid" | null> {
  const { workspaceId } = await currentTenant(tx, "readApprovalPolicy");
  const row = await latestRow(tx, workspaceId);
  if (!row) return null;
  return versionOf(row) ?? "invalid";
}

type PolicyRow = typeof approvalPolicies.$inferSelect;

/** The workspace's latest version as stored, or undefined. */
async function latestRow<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: Tx<TQueryResult, TFullSchema, TSchema>, workspaceId: string): Promise<PolicyRow | undefined> {
  const [row] = await tx
    .select()
    .from(approvalPolicies)
    .where(eq(approvalPolicies.workspaceId, workspaceId))
    .orderBy(desc(approvalPolicies.version))
    .limit(1);
  return row;
}

/** A stored row as a version, or undefined when its rules don't parse. */
function versionOf(row: PolicyRow): ApprovalPolicyVersion | undefined {
  const rules = ApprovalPolicyRules.safeParse(row.rules);
  if (!rules.success) return undefined;
  return {
    id: row.id,
    version: row.version,
    rules: rules.data,
    rulesSha256: row.rulesSha256,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

/** How the change's author signed in: their web session's method, and when it began. */
export interface PolicyChangeAuth {
  readonly method: SignInMethod;
  /** ISO 8601. */
  readonly signedInAt: string;
}

export interface PolicyChangeInput {
  readonly rules: ApprovalPolicyRules;
  /**
   * The version the change was made from: the latest when the page loaded, or 0 when there was
   * none. A change made from an older version is refused (`stale`), so two tabs can't silently
   * overwrite each other.
   */
  readonly baseVersion: number;
  readonly auth: PolicyChangeAuth;
  /** Signs the change's checkpoint (`request: "policy"`). Null fails closed. */
  readonly signer: AuditSigner | null;
  /** The new policy's id, when the workspace has none yet: a UUIDv7 in the app. */
  readonly newId: () => string;
  readonly now?: Date;
}

export type PolicyChangeOutcome =
  | {
      readonly ok: true;
      /** False when the rules are the latest version's already: nothing was written. */
      readonly changed: boolean;
      readonly policy: ApprovalPolicyVersion;
      /** The checkpoint signing the change's audit entry; null when nothing changed. */
      readonly checkpoint: AuditCheckpoint | null;
    }
  | {
      readonly ok: false;
      readonly reason: "stale";
      /** The latest version now, or 0. */
      readonly current: number;
    };

/**
 * Changes the transaction's workspace's policy (spec §4.6). The caller has checked the step-up;
 * this checks the rest, in one transaction:
 *
 * 1. the rules parse, and keep `checkPolicyRules` (a TypeError otherwise: the route checks first);
 * 2. a signer (`AuditUnavailableError` otherwise, before anything is written);
 * 3. the workspace's policy lock, so concurrent changes take turns;
 * 4. `baseVersion` is the latest version, or the change is `stale`;
 * 5. rules equal to the latest version's write nothing, and answer `changed: false`;
 * 6. otherwise the next version, under the policy's id (a new one for the first version), in the
 *    transaction's user's name;
 * 7. a `policy.changed` audit entry, its subject the policy, its detail `{ policyId, version,
 *    rulesSha256, auth }`, and one checkpoint (`request: "policy"`), last.
 */
export async function writeApprovalPolicy<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: Tx<TQueryResult, TFullSchema, TSchema>,
  input: PolicyChangeInput,
): Promise<PolicyChangeOutcome> {
  const { userId, workspaceId } = await currentTenant(tx, "writeApprovalPolicy");
  const parsed = ApprovalPolicyRules.safeParse(input.rules);
  if (!parsed.success) throw new TypeError("writeApprovalPolicy: the rules don't parse");
  const rules = parsed.data;
  const check = checkPolicyRules(rules);
  if (!check.ok) throw new TypeError(`writeApprovalPolicy: ${check.problem}`);
  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 0) {
    throw new TypeError("writeApprovalPolicy: baseVersion is a version number or 0");
  }
  if (!input.signer) {
    throw new AuditUnavailableError(
      "a policy change needs an audit checkpoint, and EARSHOT_AUDIT_SIGNING_KEY isn't usable here",
    );
  }

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`earshot.policy:${workspaceId}`}, 0))`,
  );
  const latest = await latestRow(tx, workspaceId);
  const current = latest?.version ?? 0;
  if (current !== input.baseVersion) return { ok: false, reason: "stale", current };
  const sha = await rulesSha256(rules);
  const unchanged = latest && latest.rulesSha256 === sha ? versionOf(latest) : undefined;
  if (unchanged) return { ok: true, changed: false, policy: unchanged, checkpoint: null };

  // The policy keeps its id across versions; the first version gets a new one.
  const id = latest?.id ?? input.newId();
  const version = current + 1;
  const [row] = await tx
    .insert(approvalPolicies)
    .values({ workspaceId, id, version, rules, rulesSha256: sha, createdBy: userId })
    .returning();
  if (!row) throw new Error("writeApprovalPolicy: the insert returned no row");
  const audit = await recordAudit(tx, [
    {
      action: POLICY_CHANGED_ACTION,
      subjectType: "approval_policy",
      subjectId: id,
      detail: {
        policyId: id,
        version,
        rulesSha256: sha,
        auth: { method: input.auth.method, signedInAt: input.auth.signedInAt },
      },
    },
  ]);
  const checkpoint = await writeCheckpoint(tx, input.signer, audit.head, "policy", input.now);
  return {
    ok: true,
    changed: true,
    policy: {
      id: row.id,
      version: row.version,
      rules,
      rulesSha256: row.rulesSha256,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
    },
    checkpoint,
  };
}
