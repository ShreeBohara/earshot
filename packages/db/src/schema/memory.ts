import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { crmEntities } from "./crm";
import { workspaceId } from "./workspaces";

/** The commitment ledger: promises made on calls, by the rep or the prospect. */
export const commitments = pgTable(
  "commitments",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    owner: text().notNull(),
    /** The other party, as said on the call. */
    counterpart: text(),
    text: text().notNull(),
    /** The due date, resolved against the call's time and timezone. */
    dueAt: timestamp("due_at", { withTimezone: true }),
    status: text().notNull().default("open"),
    evidence: jsonb().$type<unknown[]>().notNull().default([]),
    /** The CRM task this commitment created, once synced. */
    crmTaskExternalId: text("crm_task_external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("commitments_workspace_id_status_due_at_idx").on(t.workspaceId, t.status, t.dueAt),
    check("commitments_owner_check", sql`${t.owner} in ('rep', 'prospect')`),
    check("commitments_status_check", sql`${t.status} in ('open', 'kept', 'missed', 'cancelled')`),
  ],
);

/**
 * Facts about CRM entities with the dates they were true, so changes stay visible
 * (for example "champion: Sarah → Raj, from Oct 3").
 */
export const facts = pgTable(
  "facts",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    entityId: uuid("entity_id").notNull(),
    key: text().notNull(),
    value: jsonb().notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    /** Null while the fact is still true. */
    validTo: timestamp("valid_to", { withTimezone: true }),
    evidence: jsonb().$type<unknown[]>().notNull().default([]),
  },
  (t) => [
    foreignKey({
      name: "facts_entity_fk",
      columns: [t.workspaceId, t.entityId],
      foreignColumns: [crmEntities.workspaceId, crmEntities.id],
    }).onDelete("cascade"),
    index("facts_workspace_id_entity_id_key_idx").on(t.workspaceId, t.entityId, t.key),
    check("facts_validity_check", sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`),
  ],
);
