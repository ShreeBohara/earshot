// The mirror's history (Phase 5 spec decision 10, WP12; docs/adr/0008): what a CRM record's field
// held at any time, from `crm_entity_changes`, so a review card can tell the CRM's value when the
// rep spoke (`base`) from its value now (`current`) and show three values when they differ. The
// demo CRM's controls write it now (./demo-crm.ts) and Phase 6's sync later; nothing else does.
//
// Every function that reads or writes takes a transaction from withTenant and checks that it is
// one, so row-level security confines it to one workspace. The table is append-only for the app
// (migration 0017): a change is recorded once and never edited.
import { and, eq, inArray, sql, type TablesRelationalConfig } from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import {
  CRM_CHANGE_SOURCES,
  type CrmChangeSource,
  type CrmFieldValue,
  crmEntities,
  crmEntityChanges,
} from "./schema";
import { currentTenant } from "./tenant";

type Tx<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> = PgTransaction<TQueryResult, TFullSchema, TSchema>;

/** One change to one field, as `valueFromHistory` reads it. */
export interface FieldChange {
  readonly id: string;
  readonly old: CrmFieldValue;
  readonly new: CrmFieldValue;
  readonly changedAt: Date;
}

/** A field of a record: what `readFieldHistory` is asked for. */
export interface FieldRef {
  readonly entityId: string;
  readonly field: string;
}

/** Where a field's history sits in `readFieldHistory`'s answer. */
export function fieldKey({ entityId, field }: FieldRef): string {
  return `${entityId}\u0000${field}`;
}

/** Oldest first; changes at the same instant in id order, so the answer never depends on rows. */
function chronological(a: FieldChange, b: FieldChange): number {
  return a.changedAt.getTime() - b.changedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * `valueAt`'s rule on one field's changes (spec WP12 step 1), pure: the `new` of the last change
 * at or before `at`; else the `old` of the first change after it; else `current`, the record's
 * value now. A field with no history has always held its value now, as far as the mirror knows;
 * one whose first change came after `at` held that change's `old` (null before a record arrived).
 */
export function valueFromHistory(
  changes: readonly FieldChange[],
  at: Date,
  current: CrmFieldValue,
): CrmFieldValue {
  const when = at.getTime();
  let before: FieldChange | undefined;
  let after: FieldChange | undefined;
  for (const change of [...changes].sort(chronological)) {
    if (change.changedAt.getTime() <= when) before = change;
    else {
      after = change;
      break;
    }
  }
  if (before) return before.new;
  if (after) return after.old;
  return current;
}

/** A value the history can hold: a JSON scalar; anything else (an object, a list) is no value. */
export function asFieldValue(value: unknown): CrmFieldValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD = /^[a-z][A-Za-z0-9]{0,63}$/;

/**
 * The changes to each of `refs`, oldest first, keyed by `fieldKey`; fields with none are absent.
 * One query for all of them, never one per field. Ids that aren't UUIDs and names that aren't
 * field names can't have history, and are skipped.
 */
export async function readFieldHistory<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: Tx<TQueryResult, TFullSchema, TSchema>,
  refs: readonly FieldRef[],
): Promise<Map<string, FieldChange[]>> {
  const tenant = await currentTenant(tx, "readFieldHistory");
  const wanted = refs.filter((ref) => UUID.test(ref.entityId) && FIELD.test(ref.field));
  const history = new Map<string, FieldChange[]>();
  if (wanted.length === 0) return history;
  const keys = new Set(
    wanted.map((ref) => fieldKey({ ...ref, entityId: ref.entityId.toLowerCase() })),
  );
  const rows = await tx
    .select({
      id: crmEntityChanges.id,
      entityId: crmEntityChanges.entityId,
      field: crmEntityChanges.field,
      old: crmEntityChanges.old,
      new: crmEntityChanges.new,
      changedAt: crmEntityChanges.changedAt,
    })
    .from(crmEntityChanges)
    .where(
      and(
        // Row-level security already limits the rows to the workspace; the filter keeps it explicit.
        eq(crmEntityChanges.workspaceId, tenant.workspaceId),
        inArray(crmEntityChanges.entityId, [...new Set(wanted.map((ref) => ref.entityId))]),
        inArray(crmEntityChanges.field, [...new Set(wanted.map((ref) => ref.field))]),
      ),
    );
  for (const row of rows) {
    const key = fieldKey(row);
    if (!keys.has(key)) continue;
    const change: FieldChange = {
      id: row.id,
      old: asFieldValue(row.old),
      new: asFieldValue(row.new),
      changedAt: row.changedAt,
    };
    const list = history.get(key);
    if (list) list.push(change);
    else history.set(key, [change]);
  }
  for (const list of history.values()) list.sort(chronological);
  return history;
}

/**
 * A record's field at time `at` (spec WP12 step 1): the `new` of its last change at or before
 * `at`; else the `old` of its first change after it; else its value now. `name` is the record's
 * name; any other field is one of its properties (a deal's `stage`, a contact's `title`).
 * Undefined when the workspace holds no such record.
 */
export async function valueAt<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: Tx<TQueryResult, TFullSchema, TSchema>,
  entityId: string,
  field: string,
  at: Date,
): Promise<CrmFieldValue | undefined> {
  const tenant = await currentTenant(tx, "valueAt");
  if (!UUID.test(entityId) || !FIELD.test(field)) return undefined;
  const [row] = await tx
    .select({ name: crmEntities.name, value: sql<unknown>`${crmEntities.properties} -> ${field}` })
    .from(crmEntities)
    .where(and(eq(crmEntities.workspaceId, tenant.workspaceId), eq(crmEntities.id, entityId)))
    .limit(1);
  if (!row) return undefined;
  const current = field === "name" ? row.name : asFieldValue(row.value);
  const history = await readFieldHistory(tx, [{ entityId, field }]);
  return valueFromHistory(
    history.get(fieldKey({ entityId: entityId.toLowerCase(), field })) ?? [],
    at,
    current,
  );
}

/** A change to record: one field of one record, before and after. */
export interface CrmChangeInput {
  readonly entityId: string;
  readonly field: string;
  readonly old: CrmFieldValue;
  readonly new: CrmFieldValue;
  readonly source: CrmChangeSource;
  /** When the CRM changed; the transaction's time when absent. */
  readonly changedAt?: Date;
}

/**
 * Appends changes to the workspace's history, in the caller's transaction, so the write that made
 * them commits with them or not at all. Returns their ids, in order. The source must be one of
 * `CRM_CHANGE_SOURCES` (the table's check says so too).
 */
export async function recordCrmChanges<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: Tx<TQueryResult, TFullSchema, TSchema>,
  changes: readonly CrmChangeInput[],
): Promise<string[]> {
  const tenant = await currentTenant(tx, "recordCrmChanges");
  if (changes.length === 0) return [];
  for (const change of changes) {
    if (!CRM_CHANGE_SOURCES.includes(change.source)) {
      throw new TypeError("recordCrmChanges: the source must be demo or sync");
    }
  }
  const rows = await tx
    .insert(crmEntityChanges)
    .values(
      changes.map((change) => ({
        workspaceId: tenant.workspaceId,
        entityId: change.entityId,
        field: change.field,
        old: change.old,
        new: change.new,
        source: change.source,
        ...(change.changedAt ? { changedAt: change.changedAt } : {}),
      })),
    )
    .returning({ id: crmEntityChanges.id });
  return rows.map((row) => row.id);
}
