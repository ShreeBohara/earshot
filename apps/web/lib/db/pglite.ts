// Postgres compiled to WebAssembly, in process, with the same extensions and migrations as Neon.
// For `next dev` without DATABASE_URL and for tests only: production builds never import this
// file (lib/db/index.ts reaches it through a development-only dynamic import, and the build's
// dead-code elimination drops it; CI greps the Worker bundle to prove it).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { schema } from "@earshot/db";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { findInRepo } from "../repo-path";

/** packages/db/migrations, found by walking up from the working directory. */
export function findMigrationsFolder(from?: string): string {
  return path.dirname(path.dirname(findInRepo("packages/db/migrations/meta/_journal.json", from)));
}

/**
 * Opens a PGlite database with pgvector and pg_trgm and applies every pending migration. With
 * `dataDir` it's persisted on disk (and reopening it applies only new migrations); without, it
 * lives in memory.
 */
export async function openPglite({ dataDir }: { dataDir?: string } = {}) {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const client = await PGlite.create({
    ...(dataDir ? { dataDir } : {}),
    extensions: { vector, pg_trgm },
  });
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: findMigrationsFolder() });
  return db;
}

export type PgliteDb = Awaited<ReturnType<typeof openPglite>>;
