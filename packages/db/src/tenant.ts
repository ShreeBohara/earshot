import { sql, type TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import {
  auditLog,
  commitments,
  credentials,
  crmConnections,
  crmEntities,
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
 * Who a transaction acts for. Resolve `workspaceId` from `workspace_members` for the signed-in
 * user before calling `withTenant`: that lookup spans workspaces, so it runs as the owner.
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
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction pinned to one workspace (docs/adr/0019). The transaction takes
 * the `earshot_app` role and sets `app.user_id` and `app.workspace_id`, all with
 * transaction-local scope, so every query `fn` makes through `tx` sees and writes only that
 * workspace's rows, and nothing carries over to the connection's next transaction.
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
