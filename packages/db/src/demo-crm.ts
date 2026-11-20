// The demo CRM in a workspace (@earshot/demo-crm): fictional companies, contacts, and deals that
// a new workspace can load into its CRM mirror, `crm_entities`, to try Earshot before it connects
// a real CRM, and remove again. Every function takes a transaction from withTenant and checks
// that it is one, so row-level security confines it to one workspace and audit entries name the
// acting user.
import type { CrmEntityRow } from "@earshot/demo-crm";
import { and, count, eq, isNull, like, sql, type TablesRelationalConfig } from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { auditLog, crmEntities } from "./schema";
import { currentTenant, type TenantContext } from "./tenant";

/**
 * Demo rows are the ones with no CRM connection whose external id starts with this. The dataset's
 * own ids (`co_001`, `ct_001`, `deal_001`) follow it, so a demo row maps back to its source.
 */
export const DEMO_CRM_EXTERNAL_ID_PREFIX = "demo:";

/** What `loadDemoCrm` did: rows it inserted, out of the rows in the dataset. */
export interface DemoCrmLoadResult {
  readonly inserted: number;
  readonly total: number;
}

/** How much of the demo CRM a workspace holds, and what the dataset contains. */
export interface DemoCrmStatus {
  readonly loaded: number;
  readonly total: number;
  readonly counts: {
    readonly companies: number;
    readonly contacts: number;
    readonly deals: number;
  };
}

/**
 * The dataset's rows. Imported on first use, not with this module: the dataset is over 100 KB,
 * and bundlers copy a static import into every server chunk that reaches `@earshot/db`.
 */
async function demoRows(): Promise<CrmEntityRow[]> {
  const { toEntityRows } = await import("@earshot/demo-crm");
  return toEntityRows();
}

type KeysOf = (row: { readonly name: string; readonly aliases: readonly string[] }) => string[];

/**
 * A row's `phonetic_keys`: the Double Metaphone codes of its name and aliases, from the name
 * toolkit (@earshot/understanding), the one place keys are computed. Imported on first use, like
 * the dataset, so it stays out of server chunks that reach `@earshot/db` for anything else.
 */
async function phoneticKeysOf(): Promise<KeysOf> {
  const { phoneticKeys } = await import("@earshot/understanding/names");
  return (row) => phoneticKeys([row.name, ...row.aliases]);
}

/** Matches the workspace's demo rows and nothing else. */
function isDemoRow(workspaceId: string) {
  return and(
    // RLS already limits the rows to the workspace; the filter keeps the query explicit.
    eq(crmEntities.workspaceId, workspaceId),
    isNull(crmEntities.connectionId),
    like(crmEntities.externalId, `${DEMO_CRM_EXTERNAL_ID_PREFIX}%`),
  );
}

/**
 * Loads the demo CRM's companies, contacts, and deals into the workspace's `crm_entities`, with
 * no connection behind them, and their `phonetic_keys`. Idempotent: a row whose external key is
 * already there is skipped (`ON CONFLICT DO NOTHING` on the external-key unique constraint), so
 * loading twice, or after a partial load, leaves exactly one copy of each row. A row already there
 * whose keys are missing or stale gets them (`fillPhoneticKeys`).
 *
 * Records `demo_crm.loaded` in the audit log, with the counts, when it inserted anything.
 */
export async function loadDemoCrm<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: PgTransaction<TQueryResult, TFullSchema, TSchema>): Promise<DemoCrmLoadResult> {
  const tenant = await currentTenant(tx, "loadDemoCrm");
  const [rows, keysOf] = await Promise.all([demoRows(), phoneticKeysOf()]);
  const inserted = await tx
    .insert(crmEntities)
    .values(
      rows.map((row) => ({
        workspaceId: tenant.workspaceId,
        connectionId: null,
        kind: row.kind,
        externalId: `${DEMO_CRM_EXTERNAL_ID_PREFIX}${row.externalId}`,
        name: row.name,
        aliases: row.aliases,
        phoneticKeys: keysOf(row),
        properties: row.properties,
      })),
    )
    .onConflictDoNothing({
      target: [
        crmEntities.workspaceId,
        crmEntities.connectionId,
        crmEntities.kind,
        crmEntities.externalId,
      ],
    })
    .returning({ id: crmEntities.id });
  await fillPhoneticKeys(tx, tenant.workspaceId, keysOf);

  const result = { inserted: inserted.length, total: rows.length };
  if (result.inserted > 0) await recordAudit(tx, tenant, "demo_crm.loaded", result);
  return result;
}

/**
 * Deletes the workspace's demo rows, and only those: rows from a CRM connection, and rows without
 * one whose external id lacks the demo prefix, stay. Facts about a deleted row go with it, and
 * proposals that targeted one keep their content but lose the target (the foreign keys' own
 * cascade and SET NULL).
 *
 * Records `demo_crm.removed`, with the count, when it deleted anything.
 */
export async function removeDemoCrm<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: PgTransaction<TQueryResult, TFullSchema, TSchema>): Promise<{ deleted: number }> {
  const tenant = await currentTenant(tx, "removeDemoCrm");
  const deleted = await tx
    .delete(crmEntities)
    .where(isDemoRow(tenant.workspaceId))
    .returning({ id: crmEntities.id });
  const result = { deleted: deleted.length };
  if (result.deleted > 0) await recordAudit(tx, tenant, "demo_crm.removed", result);
  return result;
}

/** How many of the dataset's rows the workspace holds, out of how many, by kind. */
export async function demoCrmStatus<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: PgTransaction<TQueryResult, TFullSchema, TSchema>): Promise<DemoCrmStatus> {
  const tenant = await currentTenant(tx, "demoCrmStatus");
  const [row] = await tx
    .select({ loaded: count() })
    .from(crmEntities)
    .where(isDemoRow(tenant.workspaceId));
  const rows = await demoRows();
  const kinds = (kind: CrmEntityRow["kind"]) => rows.filter((r) => r.kind === kind).length;
  return {
    loaded: row?.loaded ?? 0,
    total: rows.length,
    counts: { companies: kinds("company"), contacts: kinds("contact"), deals: kinds("deal") },
  };
}

/**
 * Gives each of the workspace's demo rows the keys of its own name and aliases, where the stored
 * keys differ: rows loaded before keys were computed here have none, and a change to the toolkit
 * makes keys stale. One statement for all of them, and none when every row is current, so it's
 * idempotent. Not audited: the keys are derived from what the row already says.
 */
async function fillPhoneticKeys<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: PgTransaction<TQueryResult, TFullSchema, TSchema>,
  workspaceId: string,
  keysOf: KeysOf,
): Promise<void> {
  const rows = await tx
    .select({
      id: crmEntities.id,
      name: crmEntities.name,
      aliases: crmEntities.aliases,
      phoneticKeys: crmEntities.phoneticKeys,
    })
    .from(crmEntities)
    .where(isDemoRow(workspaceId));
  const stale = rows.flatMap((row) => {
    const keys = keysOf(row);
    const same =
      keys.length === row.phoneticKeys.length && keys.every((k, i) => k === row.phoneticKeys[i]);
    return same ? [] : [{ id: row.id, keys }];
  });
  if (stale.length === 0) return;

  // Each key is its own parameter, so no driver has to encode an array.
  const keyArray = (keys: readonly string[]) =>
    sql`array[${sql.join(
      keys.map((key) => sql`${key}`),
      sql`, `,
    )}]::text[]`;
  const values = sql.join(
    stale.map(({ id, keys }) => sql`(${id}::uuid, ${keyArray(keys)})`),
    sql`, `,
  );
  await tx.execute(sql`
    update ${crmEntities} set phonetic_keys = stale.keys, updated_at = now()
    from (values ${values}) as stale (row_id, keys)
    where ${crmEntities.id} = stale.row_id and ${crmEntities.workspaceId} = ${workspaceId}
  `);
}

async function recordAudit<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: PgTransaction<TQueryResult, TFullSchema, TSchema>,
  { userId, workspaceId }: TenantContext,
  action: "demo_crm.loaded" | "demo_crm.removed",
  detail: Record<string, number>,
): Promise<void> {
  await tx.insert(auditLog).values({
    workspaceId,
    actorUserId: userId,
    action,
    subjectType: "demo_crm",
    detail,
  });
}
