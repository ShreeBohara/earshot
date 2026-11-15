import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  halfvec,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { envelopeColumns, timestamps } from "./columns";
import { workspaceId } from "./workspaces";

/** A connected CRM. Its tokens are envelope-encrypted like `credentials`. */
export const crmConnections = pgTable(
  "crm_connections",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    provider: text().notNull(),
    /** For example `oauth` or `service_key`. */
    authType: text("auth_type").notNull(),
    ...envelopeColumns(),
    /** The provider API version the adapter targets, for example HubSpot's `2026-09`. */
    apiVersion: text("api_version"),
    status: text().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    // Child rows reference (workspace_id, id), so they can only point inside their own workspace.
    unique("crm_connections_workspace_id_id_unique").on(t.workspaceId, t.id),
    check("crm_connections_provider_check", sql`${t.provider} in ('hubspot', 'twenty', 'attio')`),
  ],
);

/**
 * The local mirror of CRM companies, contacts, and deals that entity linking searches
 * (docs/adr/0008). `connection_id` is null for records with no CRM behind them, such as the
 * demo CRM.
 */
export const crmEntities = pgTable(
  "crm_entities",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    connectionId: uuid("connection_id"),
    kind: text().notNull(),
    externalId: text("external_id").notNull(),
    name: text().notNull(),
    aliases: text().array().notNull().default(sql`'{}'::text[]`),
    /** Double Metaphone codes of the name and aliases, for sound-alike matching. */
    phoneticKeys: text("phonetic_keys").array().notNull().default(sql`'{}'::text[]`),
    /** Half precision keeps a 512-dimension embedding at about 1 KB. */
    embedding: halfvec({ dimensions: 512 }),
    properties: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("crm_entities_workspace_id_id_unique").on(t.workspaceId, t.id),
    // NULLS NOT DISTINCT, so records without a connection are deduplicated too.
    unique("crm_entities_external_key_unique")
      .on(t.workspaceId, t.connectionId, t.kind, t.externalId)
      .nullsNotDistinct(),
    foreignKey({
      name: "crm_entities_connection_fk",
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [crmConnections.workspaceId, crmConnections.id],
    }).onDelete("cascade"),
    check("crm_entities_kind_check", sql`${t.kind} in ('company', 'contact', 'deal')`),
    index("crm_entities_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
    index("crm_entities_embedding_hnsw_idx").using("hnsw", t.embedding.op("halfvec_cosine_ops")),
  ],
);
