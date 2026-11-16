import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgtap } from "@electric-sql/pglite-pgtap";
import { vector } from "@electric-sql/pglite-pgvector";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/schema";
import type { tenantTables } from "../src/tenant";

// The real SQL migrations run against Postgres compiled to WebAssembly, so CI needs no database.
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const seed = readFileSync(new URL("./fixtures/two-workspaces.sql", import.meta.url), "utf8");

/** The seeded tenants (test/fixtures/two-workspaces.sql). */
export const A = { userId: "user-a", workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
export const B = { userId: "user-b", workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

/** A seeded row's id: `rowId("a", 1)` is A's credential. */
export function rowId(tenant: "a" | "b", table: number): string {
  return `${tenant}0000000-0000-4000-8000-0000000000${String(table).padStart(2, "0")}`;
}

/** The column RLS keys on: `workspace_id`, or `id` for `workspaces` itself. */
export function tenantKey(table: (typeof tenantTables)[number]): AnyPgColumn {
  return "workspaceId" in table ? table.workspaceId : table.id;
}

/** A fresh database with every migration applied, as the owner would see it. */
export async function migratedDb(options: { pgtap?: boolean } = {}) {
  const extensions: PGliteOptions["extensions"] = { vector, pg_trgm };
  if (options.pgtap) extensions.pgtap = pgtap;
  const client = new PGlite({ extensions });
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  return { client, db };
}

/** A copy of a database in a fresh session, much faster than migrating and seeding again. */
export async function cloneDb(client: PGlite) {
  const copy = (await client.clone()) as PGlite;
  return { client: copy, db: drizzle({ client: copy, schema }) };
}

/** Like `migratedDb`, plus tenants A and B with one row in every tenant table each. */
export async function seededDb(options: { pgtap?: boolean } = {}) {
  const { client, db } = await migratedDb(options);
  await client.exec(seed);
  return { client, db };
}
