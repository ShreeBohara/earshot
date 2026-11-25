import { asc, desc, eq, sql, type TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import {
  approvalPolicies,
  auditCheckpoints,
  auditLog,
  commitments,
  credentials,
  crmConnections,
  crmEntities,
  crmEntityChanges,
  facts,
  proposals,
  sessionEvents,
  sessions,
  syncJobs,
  utterances,
  workspaceMembers,
  workspaces,
} from "./schema";

/** The role tenant work runs as. Migration 0004 creates it; RLS applies to it. */
export const TENANT_ROLE = "earshot_app";

/**
 * Who a transaction acts for: the signed-in user, and a workspace that `resolveWorkspace` chose
 * for them. Never pass a workspace id from a request straight through.
 */
export type TenantContext = { userId: string; workspaceId: string };

/**
 * Every table whose rows belong to one workspace. Row-level security limits the tenant role
 * to the current workspace's rows: by `workspace_id`, or by `id` for `workspaces` itself.
 */
export const tenantTables = [
  workspaces,
  workspaceMembers,
  credentials,
  crmConnections,
  crmEntities,
  sessions,
  sessionEvents,
  utterances,
  proposals,
  syncJobs,
  commitments,
  facts,
  auditLog,
  auditCheckpoints,
  approvalPolicies,
  crmEntityChanges,
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Picks the workspace a user acts in, or null if they belong to none. Returns `requestedId` if
 * the user is a member of it, and otherwise the user's oldest membership (ties broken by
 * workspace id), so the answer is always one of the user's own workspaces and never depends on
 * row order. The result can differ from `requestedId`; compare them if the caller needs that
 * exact workspace.
 *
 * Run it on the owner connection, not inside `withTenant`: memberships span workspaces, and RLS
 * would hide all but the current one.
 */
export async function resolveWorkspace<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TQueryResult, TFullSchema, TSchema>,
  userId: string,
  requestedId?: string,
): Promise<string | null> {
  // A malformed id can't be a membership; skip it rather than let the uuid cast throw.
  const requested = requestedId !== undefined && UUID.test(requestedId) ? requestedId : undefined;
  const [membership] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(
      // One round trip: the requested workspace sorts first when the user belongs to it.
      ...(requested ? [desc(sql`${workspaceMembers.workspaceId} = ${requested}`)] : []),
      asc(workspaceMembers.createdAt),
      asc(workspaceMembers.workspaceId),
    )
    .limit(1);
  return membership?.workspaceId ?? null;
}

/**
 * Runs `fn` in a transaction pinned to one workspace and one user (docs/adr/0019). The
 * transaction takes the `earshot_app` role and sets `app.user_id` and `app.workspace_id`, all
 * with transaction-local scope, so every query `fn` makes through `tx` sees and writes only that
 * workspace's rows, records sessions and audit entries only in that user's name, and nothing
 * carries over to the connection's next transaction.
 *
 * Works with any Postgres Drizzle database that runs interactive transactions: `createPoolDb`
 * in production, PGlite in tests. Neon's HTTP driver can't, and throws.
 *
 * RLS guards against mistakes, such as a missing `where` or an id taken from a request. It
 * isn't a sandbox: code holding the connection could `RESET ROLE`.
 */
export async function withTenant<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
  T,
>(
  db: PgDatabase<TQueryResult, TFullSchema, TSchema>,
  { userId, workspaceId }: TenantContext,
  fn: (tx: PgTransaction<TQueryResult, TFullSchema, TSchema>) => Promise<T>,
): Promise<T> {
  if (!userId) throw new TypeError("withTenant: userId is required");
  // A malformed id would fail closed anyway (the policies' uuid cast errors), but later and
  // less clearly.
  if (!UUID.test(workspaceId)) throw new TypeError("withTenant: workspaceId must be a UUID");

  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${TENANT_ROLE}`));
    await tx.execute(
      sql`select set_config('app.user_id', ${userId}, true), set_config('app.workspace_id', ${workspaceId}, true)`,
    );
    return fn(tx);
  });
}

/**
 * The user and workspace `withTenant` set on this transaction. Throws a TypeError, naming
 * `caller`, unless the transaction runs as the tenant role with both settings present: on the
 * owner connection RLS doesn't apply, so a function that trusts it would reach every workspace.
 * Data-layer functions that take a transaction call this first.
 */
export async function currentTenant<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: PgTransaction<TQueryResult, TFullSchema, TSchema>, caller: string): Promise<TenantContext> {
  const result: unknown = await tx.execute(
    sql`select current_user as role, current_setting('app.user_id', true) as user_id,
               current_setting('app.workspace_id', true) as workspace_id`,
  );
  // PGlite and node-postgres-style drivers return { rows }; postgres.js returns the rows.
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
  const row = rows?.[0] as
    | Partial<Record<"role" | "user_id" | "workspace_id", unknown>>
    | undefined;
  const userId = row?.user_id;
  const workspaceId = row?.workspace_id;
  if (
    row?.role !== TENANT_ROLE ||
    typeof userId !== "string" ||
    typeof workspaceId !== "string" ||
    !userId ||
    !workspaceId
  ) {
    throw new TypeError(`${caller} must run in a transaction from withTenant.`);
  }
  return { userId, workspaceId };
}
