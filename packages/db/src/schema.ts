import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Deployment metadata as key/value pairs. CI writes `branch` after migrating each Neon
 * branch, so the health check can prove which branch a Worker is really connected to.
 * Phase 2 adds the real schema (users, sessions, events, proposals, …).
 */
export const appMeta = pgTable("app_meta", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
