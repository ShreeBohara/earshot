// Account lifecycle on the owner connection: the personal workspace a user gets at sign-up, the
// export of everything a user's workspaces hold, and the deletes that run before the user row
// goes (docs/adr/0006, docs/adr/0019).
import type { AuditPublicKey } from "@earshot/keys/server";
import {
  and,
  asc,
  eq,
  getTableName,
  inArray,
  ne,
  notExists,
  sql,
  type TablesRelationalConfig,
} from "drizzle-orm";
import type {
  PgDatabase,
  PgQueryResultHKT,
  PgTable,
  PgTransaction,
  SelectedFields,
} from "drizzle-orm/pg-core";
import { AUDIT_FORM_VERSION, exportAuditChain } from "./audit-chain";
import {
  account,
  auditCheckpoints,
  auditLog,
  credentials,
  crmConnections,
  passkey,
  session,
  sessions,
  user,
  workspaceMembers,
  workspaces,
} from "./schema";
import { resolveWorkspace, tenantTables, withTenant } from "./tenant";

type AnyPgDatabase<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> = PgDatabase<TQueryResult, TFullSchema, TSchema>;

/** A workspace name for a new user: their first name when we know it, otherwise "Personal". */
export function personalWorkspaceName(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${first.slice(0, 40)}'s workspace` : "Personal";
}

/**
 * Makes sure a user belongs to at least one workspace, creating a personal workspace with them as
 * its owner if they have none. The workspace and the membership are written in one transaction,
 * so a user never ends up owning half a workspace.
 *
 * Idempotent and safe to race: a transaction-scoped advisory lock on the user id serializes
 * concurrent calls, so the sign-up hook and a request that finds no workspace can't both create
 * one. Runs on the owner connection, because the tenant role can't create workspaces or write
 * memberships (docs/adr/0019).
 */
export async function ensureWorkspace<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: AnyPgDatabase<TQueryResult, TFullSchema, TSchema>,
  owner: { id: string; name?: string | null },
): Promise<{ workspaceId: string; created: boolean }> {
  if (!owner.id) throw new TypeError("ensureWorkspace: a user id is required");
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`earshot:workspace-bootstrap:${owner.id}`}, 0))`,
    );
    const existing = await resolveWorkspace(tx, owner.id);
    if (existing) return { workspaceId: existing, created: false };

    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: personalWorkspaceName(owner.name) })
      .returning({ id: workspaces.id });
    if (!workspace) throw new Error("ensureWorkspace: the workspace insert returned no row");
    await tx
      .insert(workspaceMembers)
      .values({ workspaceId: workspace.id, userId: owner.id, role: "owner" });
    return { workspaceId: workspace.id, created: true };
  });
}

/**
 * Deletes every workspace the user is the only member of, which cascades to all of its tenant
 * rows. Account deletion runs this before it deletes the user; workspaces that other members
 * share are left alone (Phase 2 has none). Returns the deleted workspace ids.
 */
export async function deleteSoleMemberWorkspaces<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(db: AnyPgDatabase<TQueryResult, TFullSchema, TSchema>, userId: string): Promise<string[]> {
  if (!userId) throw new TypeError("deleteSoleMemberWorkspaces: a user id is required");
  const deleted = await db
    .delete(workspaces)
    .where(soleMemberWorkspaceFilter(db, userId))
    .returning({ id: workspaces.id });
  return deleted.map((row) => row.id);
}

/**
 * The ids of every capture session in the workspaces `userId` is the only member of: the
 * sessions that deleting their account deletes. Account deletion purges these sessions' Durable
 * Object storage first, because a session's object keeps its own copy of the log until Postgres
 * confirms it, and a deleted session never can be. Runs on the owner connection.
 */
export async function soleMemberWorkspaceSessionIds<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(db: AnyPgDatabase<TQueryResult, TFullSchema, TSchema>, userId: string): Promise<string[]> {
  if (!userId) throw new TypeError("soleMemberWorkspaceSessionIds: a user id is required");
  const soleWorkspaces = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(soleMemberWorkspaceFilter(db, userId));
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.workspaceId, soleWorkspaces))
    .orderBy(asc(sessions.id));
  return rows.map((row) => row.id);
}

/** `workspaces` rows `userId` belongs to with no other member, as a where clause on `workspaces`. */
function soleMemberWorkspaceFilter<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(db: AnyPgDatabase<TQueryResult, TFullSchema, TSchema>, userId: string) {
  const memberships = db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const otherMembers = db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaces.id), ne(workspaceMembers.userId, userId)),
    );
  return and(inArray(workspaces.id, memberships), notExists(otherMembers));
}

/** The JSON document `GET /api/account/export` returns. */
export type AccountExport = {
  format: "earshot.account-export";
  version: 1;
  exportedAt: string;
  user: Record<string, unknown>;
  /** Sign-in methods (Better Auth `account` rows), without tokens or password hashes. */
  accounts: Record<string, unknown>[];
  /** Registered passkeys, without their public keys. */
  passkeys: Record<string, unknown>[];
  /** Sign-in sessions, without their tokens. */
  signInSessions: Record<string, unknown>[];
  workspaces: {
    id: string;
    role: string;
    /**
     * Every tenant table's rows for this workspace, keyed by table name. `audit_log` is the
     * workspace's hash chain in seq order, each row with its hashes in hex and its canonical text,
     * and `audit_checkpoints` the signed heads (docs/adr/0033).
     */
    tables: Record<string, Record<string, unknown>[]>;
  }[];
  /**
   * What an offline check of the chains needs besides the rows: the canonical text's form and the
   * deployment's public signing keys, active and retired. `pnpm --filter @earshot/db
   * db:audit-verify <file>` checks the links, the hashes, the canonical texts, and the signatures.
   */
  audit: { form: typeof AUDIT_FORM_VERSION; keys: AuditPublicKey[] };
};

/**
 * Columns that hold secrets never leave the database in an export. These tables are read through
 * an allowlist; every other tenant table is exported whole.
 */
const exportSelections = new Map<PgTable, SelectedFields>([
  [
    credentials,
    {
      provider: credentials.provider,
      label: credentials.label,
      last4: credentials.last4,
      validatedAt: credentials.validatedAt,
      createdAt: credentials.createdAt,
    },
  ],
  [
    crmConnections,
    {
      id: crmConnections.id,
      workspaceId: crmConnections.workspaceId,
      provider: crmConnections.provider,
      authType: crmConnections.authType,
      apiVersion: crmConnections.apiVersion,
      status: crmConnections.status,
      createdAt: crmConnections.createdAt,
      updatedAt: crmConnections.updatedAt,
    },
  ],
]);

async function readTenantTables<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: PgTransaction<TQueryResult, TFullSchema, TSchema>,
): Promise<Record<string, Record<string, unknown>[]>> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  // The chain and its checkpoints in seq order, with hashes in hex, the canonical texts, and times
  // exactly as hashed and signed, so the export verifies offline.
  const chain = await exportAuditChain(tx);
  for (const table of tenantTables) {
    if (table === auditLog) {
      tables[getTableName(table)] = chain.entries as unknown as Record<string, unknown>[];
      continue;
    }
    if (table === auditCheckpoints) {
      tables[getTableName(table)] = chain.checkpoints as unknown as Record<string, unknown>[];
      continue;
    }
    const selection = exportSelections.get(table);
    // Row-level security already limits these reads to the transaction's workspace.
    const rows = selection ? await tx.select(selection).from(table) : await tx.select().from(table);
    tables[getTableName(table)] = rows as Record<string, unknown>[];
  }
  return tables;
}

/**
 * Builds a user's data export: their profile and sign-in records (read as the owner, filtered
 * by user id), and every tenant table's rows for each workspace they belong to, read through
 * `withTenant` so row-level security vouches for every row. Secrets are left out: OAuth tokens,
 * password hashes, session tokens, passkey public keys, and the envelope-encrypted columns of
 * `credentials` and `crm_connections`.
 *
 * Records an `account.exported` audit entry in each workspace, in the same transaction as the
 * reads, so the export includes the entry and a failed export leaves none.
 *
 * `auditKeys` are the deployment's public signing keys (`/api/audit/keys`), carried in the export
 * so its chains and checkpoints verify offline.
 */
export async function buildAccountExport<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: AnyPgDatabase<TQueryResult, TFullSchema, TSchema>,
  userId: string,
  now: Date = new Date(),
  { auditKeys = [] }: { readonly auditKeys?: readonly AuditPublicKey[] } = {},
): Promise<AccountExport> {
  const [profile] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })
    .from(user)
    .where(eq(user.id, userId));
  if (!profile) throw new Error("buildAccountExport: no such user");

  const accounts = await db
    .select({
      id: account.id,
      providerId: account.providerId,
      accountId: account.accountId,
      scope: account.scope,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    })
    .from(account)
    .where(eq(account.userId, userId))
    .orderBy(asc(account.createdAt));
  const passkeys = await db
    .select({
      id: passkey.id,
      name: passkey.name,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
      transports: passkey.transports,
      aaguid: passkey.aaguid,
      createdAt: passkey.createdAt,
    })
    .from(passkey)
    .where(eq(passkey.userId, userId))
    .orderBy(asc(passkey.createdAt));
  const signInSessions = await db
    .select({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      signInMethod: session.signInMethod,
    })
    .from(session)
    .where(eq(session.userId, userId))
    .orderBy(asc(session.createdAt));

  const memberships = await db
    .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.workspaceId));

  const exported: AccountExport["workspaces"] = [];
  for (const membership of memberships) {
    const tables = await withTenant(
      db,
      { userId, workspaceId: membership.workspaceId },
      async (tx) => {
        await tx.insert(auditLog).values({
          workspaceId: membership.workspaceId,
          actorUserId: userId,
          action: "account.exported",
          subjectType: "user",
          subjectId: userId,
          at: now,
        });
        return readTenantTables(tx);
      },
    );
    exported.push({ id: membership.workspaceId, role: membership.role, tables });
  }

  return {
    format: "earshot.account-export",
    version: 1,
    exportedAt: now.toISOString(),
    user: profile,
    accounts,
    passkeys,
    signInSessions,
    workspaces: exported,
    audit: { form: AUDIT_FORM_VERSION, keys: [...auditKeys] },
  };
}
