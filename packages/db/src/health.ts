import { count, eq } from "drizzle-orm";
import {
  bigint,
  type PgDatabase,
  type PgQueryResultHKT,
  pgSchema,
  serial,
  text,
} from "drizzle-orm/pg-core";
import { appMeta } from "./schema";

// Drizzle's own bookkeeping table. It's defined here rather than in schema.ts so that
// drizzle-kit never tries to create it.
const drizzleMigrations = pgSchema("drizzle").table("__drizzle_migrations", {
  id: serial().primaryKey(),
  hash: text().notNull(),
  createdAt: bigint("created_at", { mode: "number" }),
});

export type DbHealth = { status: "ok"; branch?: string; migrations: number };

/** Reads the stamped branch name and the number of applied migrations from the database. */
export async function readDbHealth<T extends PgQueryResultHKT, S extends Record<string, unknown>>(
  db: PgDatabase<T, S>,
): Promise<DbHealth> {
  const [branch] = await db
    .select({ value: appMeta.value })
    .from(appMeta)
    .where(eq(appMeta.key, "branch"))
    .limit(1);
  const [applied] = await db.select({ n: count() }).from(drizzleMigrations);
  return {
    status: "ok",
    ...(branch ? { branch: branch.value } : {}),
    migrations: applied?.n ?? 0,
  };
}

/** Records which Neon branch this database is. Safe to run repeatedly. */
export async function stampBranch<T extends PgQueryResultHKT, S extends Record<string, unknown>>(
  db: PgDatabase<T, S>,
  name: string,
): Promise<void> {
  await db
    .insert(appMeta)
    .values({ key: "branch", value: name })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: name, updatedAt: new Date() } });
}
