import type { schema } from "@earshot/db";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type Schema = typeof schema;

/**
 * The owner connection, whatever driver is behind it: Neon's WebSocket pool in production and
 * previews, PGlite under `next dev` and in tests. RLS doesn't apply to it; tenant work goes
 * through `withTenant` (docs/adr/0018, docs/adr/0019).
 */
export type AppDb = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
