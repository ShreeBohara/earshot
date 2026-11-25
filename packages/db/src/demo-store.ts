// The demo CRM's store over Postgres (Phase 6 WP2; docs/adr/0041): `DemoStore` from
// `@earshot/crm/demo`, which the demo adapter writes through when an approval syncs to the demo CRM,
// over the transaction's workspace's demo rows. Every write lands in the caller's transaction:
// properties on demo records, with a history row (`source: "sync"`) for each field a write changes;
// a record a write makes, as a demo row (`demo:added:…`) with its marker in its properties and its
// arrival in the history; and notes, tasks, and meetings in `crm_demo_activities`. Only demo rows
// (no connection, the `demo:` prefix) of the transaction's workspace: anything else reads as absent.
// Audit rows are the sync's to write (WP3), not the store's.
import type {
  DemoActivity,
  DemoActivityKind,
  DemoCursor,
  DemoRecord,
  DemoRecordKind,
  DemoStore,
  DemoValue,
} from "@earshot/crm/demo";
import { and, asc, eq, sql, type TablesRelationalConfig } from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { asFieldValue, type CrmChangeInput, recordCrmChanges } from "./crm-history";
import { DEMO_CRM_ADDED_PREFIX, DEMO_CRM_EXTERNAL_ID_PREFIX, isDemoRow } from "./demo-crm";
import { crmDemoActivities, crmEntities } from "./schema";
import { currentTenant } from "./tenant";

type Tx<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> = PgTransaction<TQueryResult, TFullSchema, TSchema>;

/** How the store tells time and makes ids: the clock and `crypto.randomUUID` by default. */
export interface DemoStoreOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** A demo row as the store reads it. */
interface EntityRow {
  readonly kind: string;
  readonly externalId: string;
  readonly name: string;
  readonly properties: Record<string, unknown>;
  readonly updatedAt: Date;
}

/** A demo row's id in the demo CRM: its external id without the `demo:` prefix. */
function demoId(externalId: string): string {
  return externalId.slice(DEMO_CRM_EXTERNAL_ID_PREFIX.length);
}

/** A demo row as a `DemoRecord`: its scalar properties, anything else as no value. */
export function toDemoRecord(row: EntityRow): DemoRecord {
  const properties: Record<string, DemoValue> = {};
  for (const [key, value] of Object.entries(row.properties)) properties[key] = asFieldValue(value);
  return {
    kind: row.kind as DemoRecordKind,
    id: demoId(row.externalId),
    name: row.name,
    properties,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const ENTITY_COLUMNS = {
  id: crmEntities.id,
  kind: crmEntities.kind,
  externalId: crmEntities.externalId,
  name: crmEntities.name,
  properties: crmEntities.properties,
  updatedAt: crmEntities.updatedAt,
};

const ACTIVITY_COLUMNS = {
  id: crmDemoActivities.id,
  kind: crmDemoActivities.kind,
  writeId: crmDemoActivities.writeId,
  body: crmDemoActivities.body,
  dueAt: crmDemoActivities.dueAt,
  startsAt: crmDemoActivities.startsAt,
  createdAt: crmDemoActivities.createdAt,
  recordKind: crmEntities.kind,
  recordExternalId: crmEntities.externalId,
};

type ActivityRow = {
  readonly id: string;
  readonly kind: string;
  readonly writeId: string;
  readonly body: string;
  readonly dueAt: Date | null;
  readonly startsAt: Date | null;
  readonly createdAt: Date;
  readonly recordKind: string;
  readonly recordExternalId: string;
};

function toDemoActivity(row: ActivityRow): DemoActivity {
  return {
    kind: row.kind as DemoActivityKind,
    id: row.id,
    record: { kind: row.recordKind as DemoRecordKind, id: demoId(row.recordExternalId) },
    writeId: row.writeId,
    body: row.body,
    dueAt: row.dueAt?.toISOString() ?? null,
    startsAt: row.startsAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A row's phonetic keys, from the name toolkit, as the demo CRM's loader computes them. */
async function phoneticKeysOf(name: string): Promise<string[]> {
  const { phoneticKeys } = await import("@earshot/understanding/names");
  return phoneticKeys([name]);
}

/**
 * The transaction's workspace's demo CRM as a `DemoStore`, for the demo adapter (`demoContext` in
 * `@earshot/crm/demo`). It checks the transaction is a tenant's (`withTenant`) on its first call.
 */
export function createDemoStore<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: Tx<TQueryResult, TFullSchema, TSchema>, options: DemoStoreOptions = {}): DemoStore {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  let tenant: Promise<{ workspaceId: string }> | null = null;
  const workspace = async (): Promise<string> => {
    tenant ??= currentTenant(tx, "createDemoStore");
    return (await tenant).workspaceId;
  };

  /** One of the workspace's demo records, by its kind and external id. */
  const recordWhere = (workspaceId: string, kind: DemoRecordKind, id: string) =>
    and(
      isDemoRow(workspaceId),
      eq(crmEntities.kind, kind),
      eq(crmEntities.externalId, `${DEMO_CRM_EXTERNAL_ID_PREFIX}${id}`),
    );

  async function findRecord(kind: DemoRecordKind, id: string): Promise<DemoRecord | null> {
    const workspaceId = await workspace();
    const [row] = await tx
      .select(ENTITY_COLUMNS)
      .from(crmEntities)
      .where(recordWhere(workspaceId, kind, id))
      .limit(1);
    return row ? toDemoRecord(row) : null;
  }

  async function findByWriteId(kind: DemoRecordKind, writeId: string): Promise<DemoRecord | null> {
    const workspaceId = await workspace();
    const [row] = await tx
      .select(ENTITY_COLUMNS)
      .from(crmEntities)
      .where(
        and(
          isDemoRow(workspaceId),
          eq(crmEntities.kind, kind),
          sql`${crmEntities.properties} ->> 'writeId' = ${writeId}`,
        ),
      )
      .orderBy(asc(crmEntities.externalId))
      .limit(1);
    return row ? toDemoRecord(row) : null;
  }

  async function findActivity(where: ReturnType<typeof and>): Promise<DemoActivity | null> {
    const [row] = await tx
      .select(ACTIVITY_COLUMNS)
      .from(crmDemoActivities)
      .innerJoin(
        crmEntities,
        and(
          eq(crmEntities.workspaceId, crmDemoActivities.workspaceId),
          eq(crmEntities.id, crmDemoActivities.entityId),
        ),
      )
      .where(where)
      .limit(1);
    return row ? toDemoActivity(row) : null;
  }

  return {
    record: findRecord,
    recordByWriteId: findByWriteId,

    async contactByEmail(email) {
      const workspaceId = await workspace();
      const [row] = await tx
        .select(ENTITY_COLUMNS)
        .from(crmEntities)
        .where(
          and(
            isDemoRow(workspaceId),
            eq(crmEntities.kind, "contact"),
            sql`lower(${crmEntities.properties} ->> 'email') = lower(${email})`,
          ),
        )
        .orderBy(asc(crmEntities.externalId))
        .limit(1);
      return row ? toDemoRecord(row) : null;
    },

    async upsertRecord({ kind, name, properties, writeId }) {
      const workspaceId = await workspace();
      // Two writers with one marker take turns here, so the second finds what the first made.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`earshot:demo-write:${workspaceId}:${writeId}`}, 0))`,
      );
      const existing = await findByWriteId(kind, writeId);
      if (existing) return { record: existing, created: false };
      const at = now();
      const [row] = await tx
        .insert(crmEntities)
        .values({
          workspaceId,
          connectionId: null,
          kind,
          externalId: `${DEMO_CRM_ADDED_PREFIX}${newId()}`,
          name,
          aliases: [],
          phoneticKeys: await phoneticKeysOf(name),
          properties: { ...properties, writeId },
          updatedAt: at,
        })
        .returning(ENTITY_COLUMNS);
      if (!row) throw new Error("createDemoStore: the record wasn't written");
      await recordCrmChanges(tx, [
        { entityId: row.id, field: "name", old: null, new: name, source: "sync", changedAt: at },
      ]);
      return { record: toDemoRecord(row), created: true };
    },

    async updateRecord(kind, id, properties) {
      const workspaceId = await workspace();
      const [row] = await tx
        .select(ENTITY_COLUMNS)
        .from(crmEntities)
        .where(recordWhere(workspaceId, kind, id))
        .for("update")
        .limit(1);
      if (!row) return null;
      const at = now();
      const changes: CrmChangeInput[] = [];
      const next: Record<string, DemoValue> = {};
      let name = row.name;
      for (const [field, value] of Object.entries(properties)) {
        const old = field === "name" ? row.name : asFieldValue(row.properties[field]);
        if (old === value) continue;
        changes.push({ entityId: row.id, field, old, new: value, source: "sync", changedAt: at });
        if (field === "name") name = String(value);
        else next[field] = value;
      }
      if (changes.length === 0) return toDemoRecord(row);
      const [updated] = await tx
        .update(crmEntities)
        .set({
          name,
          ...(name === row.name ? {} : { phoneticKeys: await phoneticKeysOf(name) }),
          // Each value goes in as JSON text, a parameter, merged over what's there.
          properties: sql`${crmEntities.properties} || ${JSON.stringify(next)}::jsonb`,
          updatedAt: at,
        })
        .where(and(isDemoRow(workspaceId), eq(crmEntities.id, row.id)))
        .returning(ENTITY_COLUMNS);
      if (!updated) throw new Error("createDemoStore: the record wasn't updated");
      await recordCrmChanges(tx, changes);
      return toDemoRecord(updated);
    },

    async activityByWriteId(kind, writeId) {
      const workspaceId = await workspace();
      return findActivity(
        and(
          eq(crmDemoActivities.workspaceId, workspaceId),
          eq(crmDemoActivities.kind, kind),
          eq(crmDemoActivities.writeId, writeId),
        ),
      );
    },

    async upsertActivity({ kind, record, writeId, body, dueAt, startsAt }) {
      const workspaceId = await workspace();
      const byWriteId = and(
        eq(crmDemoActivities.workspaceId, workspaceId),
        eq(crmDemoActivities.writeId, writeId),
      );
      const found = await findActivity(byWriteId);
      if (found) return { activity: found, created: false };
      const [target] = await tx
        .select({ id: crmEntities.id })
        .from(crmEntities)
        .where(recordWhere(workspaceId, record.kind, record.id))
        .limit(1);
      if (!target) return null;
      const inserted = await tx
        .insert(crmDemoActivities)
        .values({
          workspaceId,
          kind,
          entityId: target.id,
          writeId,
          body,
          dueAt: dueAt === null ? null : new Date(dueAt),
          startsAt: startsAt === null ? null : new Date(startsAt),
          createdAt: now(),
        })
        // The write id is unique in the workspace: a second writer finds the first's activity.
        .onConflictDoNothing({ target: [crmDemoActivities.workspaceId, crmDemoActivities.writeId] })
        .returning({ id: crmDemoActivities.id });
      const activity = await findActivity(byWriteId);
      if (!activity) throw new Error("createDemoStore: the activity wasn't written");
      return { activity, created: inserted.length > 0 };
    },

    async changes(after: DemoCursor | null, limit: number) {
      const workspaceId = await workspace();
      // Compared to the millisecond, as the cursor's time is written.
      const changed = sql`date_trunc('milliseconds', ${crmEntities.updatedAt})`;
      const rows = await tx
        .select(ENTITY_COLUMNS)
        .from(crmEntities)
        .where(
          after === null
            ? isDemoRow(workspaceId)
            : and(
                isDemoRow(workspaceId),
                sql`(${changed}, ${crmEntities.externalId}) > (${after.at}::timestamptz, ${`${DEMO_CRM_EXTERNAL_ID_PREFIX}${after.id}`})`,
              ),
        )
        .orderBy(changed, asc(crmEntities.externalId))
        .limit(limit);
      return rows.map(toDemoRecord);
    },
  };
}
