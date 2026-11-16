import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Deployment metadata as key/value pairs. CI writes `branch` after migrating each Neon
 * branch, so the health check can prove which branch a Worker is really connected to.
 * Not a tenant table: the health check reads it as the owner.
 */
export const appMeta = pgTable("app_meta", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
