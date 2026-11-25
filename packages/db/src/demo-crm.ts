// The demo CRM in a workspace (@earshot/demo-crm): fictional companies, contacts, and deals that
// a new workspace can load into its CRM mirror, `crm_entities`, to try Earshot before it connects
// a real CRM, and remove again. Every function takes a transaction from withTenant and checks
// that it is one, so row-level security confines it to one workspace and audit entries name the
// acting user.
//
// Phase 5 WP12 adds the inbox's two demo controls, which act on demo rows only: "Simulate a CRM
// change" (`moveDemoField`: one field moves, and the mirror's history records it in the same
// transaction) and "Add a matching record" (`addDemoRecord`: a record arrives, its arrival recorded
// as its name's change from null), so a review card's 3-way view and re-link offer can be tried
// before Phase 6 syncs a real CRM.
import { containsKeyShape } from "@earshot/core";
import type { CrmEntityRow } from "@earshot/demo-crm";
import { and, count, eq, isNull, like, not, sql, type TablesRelationalConfig } from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { asFieldValue, recordCrmChanges } from "./crm-history";
import { auditLog, type CrmFieldValue, crmConnections, crmEntities } from "./schema";
import { currentTenant, type TenantContext } from "./tenant";

/**
 * Demo rows are the ones with no CRM connection whose external id starts with this. The dataset's
 * own ids (`co_001`, `ct_001`, `deal_001`) follow it, so a demo row maps back to its source.
 */
export const DEMO_CRM_EXTERNAL_ID_PREFIX = "demo:";

/**
 * Records the inbox's "Add a matching record" adds (Phase 5 WP12): demo rows, so removing the demo
 * CRM removes them too, but not the dataset's, so they don't count toward how much of it is loaded.
 */
export const DEMO_CRM_ADDED_PREFIX = `${DEMO_CRM_EXTERNAL_ID_PREFIX}added:`;

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
export function isDemoRow(workspaceId: string) {
  return and(
    // RLS already limits the rows to the workspace; the filter keeps the query explicit.
    eq(crmEntities.workspaceId, workspaceId),
    isNull(crmEntities.connectionId),
    like(crmEntities.externalId, `${DEMO_CRM_EXTERNAL_ID_PREFIX}%`),
  );
}

/** The workspace's demo rows from the dataset: every demo row but the ones the inbox added. */
function isDatasetRow(workspaceId: string) {
  return and(
    isDemoRow(workspaceId),
    not(like(crmEntities.externalId, `${DEMO_CRM_ADDED_PREFIX}%`)),
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
    .where(isDatasetRow(tenant.workspaceId));
  const rows = await demoRows();
  const kinds = (kind: CrmEntityRow["kind"]) => rows.filter((r) => r.kind === kind).length;
  return {
    loaded: row?.loaded ?? 0,
    total: rows.length,
    counts: { companies: kinds("company"), contacts: kinds("contact"), deals: kinds("deal") },
  };
}

// ─── The inbox's demo controls (Phase 5 WP12) ────────────────────────────────────────────────────

/**
 * A deal's stages in pipeline order, as the demo CRM stores them (HubSpot's defaults; restated
 * from @earshot/demo-crm, whose module would bring its dataset along).
 */
const DEMO_PIPELINE = [
  "appointmentscheduled",
  "qualifiedtobuy",
  "presentationscheduled",
  "decisionmakerboughtin",
  "contractsent",
  "closedwon",
] as const;

/** The titles a contact's simulated change gives, the first that differs from the title now. */
const DEMO_TITLES = ["VP of Sales", "Director of Operations", "Head of Procurement"] as const;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEMO_PHONE = /^555-01\d{2}$/;

/** The fields "Simulate a CRM change" can move: a deal's three and a contact's three. */
export const DEMO_MOVE_FIELDS = [
  "stage",
  "amount",
  "closeDate",
  "title",
  "email",
  "phone",
] as const;
export type DemoMoveField = (typeof DEMO_MOVE_FIELDS)[number];

export function isDemoMoveField(field: string): field is DemoMoveField {
  return (DEMO_MOVE_FIELDS as readonly string[]).includes(field);
}

/**
 * Where "Simulate a CRM change" moves a field from its value now, one sensible step per field
 * (ADR-0035), or undefined when it can't move it (no value to move from, or one of another shape):
 *
 * - `stage`: the next stage in the pipeline; a closed deal (won or lost) is reopened at
 *   `contractsent`, and a stage the pipeline doesn't know moves to `qualifiedtobuy`;
 * - `amount`: up 10%, to a whole number;
 * - `closeDate`: a week later;
 * - `title`: a new title (`DEMO_TITLES`' first that differs);
 * - `email`: the same address with a 2 after its name (`dana.lee2@…`);
 * - `phone`: the next number in the demo CRM's 555-01xx range, wrapping at 99.
 */
export function demoMove(field: DemoMoveField, current: CrmFieldValue): CrmFieldValue | undefined {
  switch (field) {
    case "stage": {
      if (typeof current !== "string" || current === "") return undefined;
      if (current === "closedwon" || current === "closedlost") return "contractsent";
      const at = (DEMO_PIPELINE as readonly string[]).indexOf(current);
      if (at < 0) return "qualifiedtobuy";
      return DEMO_PIPELINE[at + 1] ?? "contractsent";
    }
    case "amount":
      return typeof current === "number" && Number.isFinite(current)
        ? Math.round(current * 1.1)
        : undefined;
    case "closeDate": {
      if (typeof current !== "string" || !ISO_DAY.test(current)) return undefined;
      const day = new Date(`${current}T00:00:00Z`);
      if (Number.isNaN(day.getTime())) return undefined;
      day.setUTCDate(day.getUTCDate() + 7);
      return day.toISOString().slice(0, 10);
    }
    case "title":
      if (typeof current !== "string") return undefined;
      return DEMO_TITLES.find((title) => title !== current) ?? DEMO_TITLES[0];
    case "email": {
      if (typeof current !== "string") return undefined;
      const at = current.indexOf("@");
      return at > 0 ? `${current.slice(0, at)}2${current.slice(at)}` : undefined;
    }
    case "phone": {
      if (typeof current !== "string" || !DEMO_PHONE.test(current)) return undefined;
      const next = (Number(current.slice(-2)) + 1) % 100;
      return `555-01${String(next).padStart(2, "0")}`;
    }
  }
}

/** What `moveDemoField` did: the record, the field, and its value before and after. */
export interface DemoFieldMove {
  readonly entityId: string;
  readonly field: DemoMoveField;
  readonly old: CrmFieldValue;
  readonly new: CrmFieldValue;
  /** The history row that records it. */
  readonly changeId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Simulate a CRM change" (spec WP12 step 4): moves one field of one of the workspace's demo
 * records a step (`demoMove`), and records the change in the mirror's history, both in the
 * caller's transaction, so neither lands without the other. The record is locked first, so two
 * clicks can't both move it from the same value. Null, writing nothing, when the record isn't one
 * of this workspace's demo rows (a record from a CRM connection, a row without the demo prefix,
 * another workspace's), the field isn't one it moves, or it holds no value to move from.
 *
 * Records `demo_crm.changed` in the audit log, with the record and the field, not the values.
 */
export async function moveDemoField<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: PgTransaction<TQueryResult, TFullSchema, TSchema>,
  change: { readonly entityId: string; readonly field: string; readonly now: Date },
): Promise<DemoFieldMove | null> {
  const tenant = await currentTenant(tx, "moveDemoField");
  const { entityId, field, now } = change;
  if (!UUID.test(entityId) || !isDemoMoveField(field)) return null;
  const [row] = await tx
    .select({ value: sql<unknown>`${crmEntities.properties} -> ${field}::text` })
    .from(crmEntities)
    .where(and(isDemoRow(tenant.workspaceId), eq(crmEntities.id, entityId)))
    .for("update")
    .limit(1);
  if (!row) return null;
  const old = asFieldValue(row.value);
  const next = demoMove(field, old);
  if (next === undefined) return null;

  // The value goes in as JSON text, a parameter; the field is one of DEMO_MOVE_FIELDS.
  await tx
    .update(crmEntities)
    .set({
      properties: sql`jsonb_set(${crmEntities.properties}, array[${field}::text], ${JSON.stringify(next)}::jsonb, true)`,
      updatedAt: now,
    })
    .where(and(isDemoRow(tenant.workspaceId), eq(crmEntities.id, entityId)));
  const [changeId] = await recordCrmChanges(tx, [
    { entityId, field, old, new: next, source: "demo", changedAt: now },
  ]);
  if (!changeId) throw new Error("moveDemoField: the change wasn't recorded");
  await recordAudit(tx, tenant, "demo_crm.changed", { entityId, field }, entityId);
  return { entityId, field, old, new: next, changeId };
}

/** The longest name a record may have: the session socket's cap on an entity's name. */
const MAX_RECORD_NAME_CHARS = 200;

/** What `addDemoRecord` did: the record, and whether it's new or was there already. */
export interface DemoRecordAdded {
  readonly entityId: string;
  readonly kind: "company" | "contact";
  readonly name: string;
  readonly added: boolean;
}

/**
 * Whether the transaction's workspace's mirror is the demo CRM: demo rows, and no CRM connected.
 * The inbox offers "Add a matching record" only then (Phase 5 WP12).
 */
export async function isDemoCrmWorkspace<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: PgTransaction<TQueryResult, TFullSchema, TSchema>): Promise<boolean> {
  const tenant = await currentTenant(tx, "isDemoCrmWorkspace");
  return isDemoWorkspace(tx, tenant.workspaceId);
}

/** Whether the workspace's mirror is the demo CRM: demo rows, and no CRM connected. */
async function isDemoWorkspace<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: PgTransaction<TQueryResult, TFullSchema, TSchema>, workspaceId: string): Promise<boolean> {
  const [demo] = await tx
    .select({ id: crmEntities.id })
    .from(crmEntities)
    .where(isDemoRow(workspaceId))
    .limit(1);
  if (!demo) return false;
  const [connection] = await tx
    .select({ id: crmConnections.id })
    .from(crmConnections)
    .where(eq(crmConnections.workspaceId, workspaceId))
    .limit(1);
  return connection === undefined;
}

/**
 * "Add a matching record" (spec WP12 step 4): adds a company or a contact to the workspace's demo
 * CRM under the name a new-record proposal heard, so the inbox can offer it at review time. Its
 * arrival goes in the mirror's history as its name's change from null, in the same transaction,
 * which is how the re-link offer knows it reached the CRM after the rep spoke. A contact may name
 * its company, one of the workspace's demo companies (its `companyId`, as the dataset's contacts
 * do); any other company is left off.
 *
 * Only in a workspace whose mirror is the demo CRM (demo rows, and no CRM connected): null,
 * writing nothing, otherwise, and for a name that's empty, too long, or shaped like a provider key
 * (a session's `start` would refuse it). Idempotent: a demo record of the same kind and name is
 * returned as it is (`added: false`). The record is a demo row (`demo:added:…`), so removing the
 * demo CRM removes it too.
 *
 * Records `demo_crm.record_added` in the audit log, with the record and its kind, not its name.
 */
export async function addDemoRecord<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: PgTransaction<TQueryResult, TFullSchema, TSchema>,
  record: {
    readonly kind: "company" | "contact";
    readonly name: string;
    readonly companyEntityId?: string | null;
    readonly newId: () => string;
    readonly now: Date;
  },
): Promise<DemoRecordAdded | null> {
  const tenant = await currentTenant(tx, "addDemoRecord");
  const { kind, now } = record;
  if (kind !== "company" && kind !== "contact") return null;
  // One run of whitespace becomes one space: the name as a card would show it.
  const name = record.name.replace(/\s+/g, " ").trim();
  if (name === "" || name.length > MAX_RECORD_NAME_CHARS || containsKeyShape(name)) return null;
  if (!(await isDemoWorkspace(tx, tenant.workspaceId))) return null;

  const [existing] = await tx
    .select({ id: crmEntities.id })
    .from(crmEntities)
    .where(
      and(
        isDemoRow(tenant.workspaceId),
        eq(crmEntities.kind, kind),
        sql`lower(${crmEntities.name}) = lower(${name})`,
      ),
    )
    .limit(1);
  if (existing) return { entityId: existing.id, kind, name, added: false };

  const properties: Record<string, string> = {};
  if (kind === "contact" && record.companyEntityId && UUID.test(record.companyEntityId)) {
    const [company] = await tx
      .select({ externalId: crmEntities.externalId })
      .from(crmEntities)
      .where(
        and(
          isDemoRow(tenant.workspaceId),
          eq(crmEntities.kind, "company"),
          eq(crmEntities.id, record.companyEntityId),
        ),
      )
      .limit(1);
    if (company)
      properties.companyId = company.externalId.slice(DEMO_CRM_EXTERNAL_ID_PREFIX.length);
  }
  if (kind === "contact") {
    const space = name.indexOf(" ");
    properties.firstName = space < 0 ? name : name.slice(0, space);
    if (space >= 0) properties.lastName = name.slice(space + 1);
  }

  const keysOf = await phoneticKeysOf();
  const [row] = await tx
    .insert(crmEntities)
    .values({
      workspaceId: tenant.workspaceId,
      connectionId: null,
      kind,
      externalId: `${DEMO_CRM_ADDED_PREFIX}${record.newId()}`,
      name,
      aliases: [],
      phoneticKeys: keysOf({ name, aliases: [] }),
      properties,
      updatedAt: now,
    })
    .returning({ id: crmEntities.id });
  if (!row) throw new Error("addDemoRecord: the record wasn't written");
  await recordCrmChanges(tx, [
    { entityId: row.id, field: "name", old: null, new: name, source: "demo", changedAt: now },
  ]);
  await recordAudit(tx, tenant, "demo_crm.record_added", { entityId: row.id, kind }, row.id);
  return { entityId: row.id, kind, name, added: true };
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
  action: "demo_crm.loaded" | "demo_crm.removed" | "demo_crm.changed" | "demo_crm.record_added",
  detail: Record<string, number | string>,
  subjectId?: string,
): Promise<void> {
  await tx.insert(auditLog).values({
    workspaceId,
    actorUserId: userId,
    action,
    subjectType: "demo_crm",
    ...(subjectId ? { subjectId } : {}),
    detail,
  });
}
