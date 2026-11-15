import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * One-shot queries over Neon's HTTP driver. It can't run interactive transactions, which
 * Phase 2's row-level security work needs; docs/adr/0018 records that decision.
 */
export function createHttpDb(url: string) {
  return drizzle({ client: neon(url), schema });
}

export type HttpDb = ReturnType<typeof createHttpDb>;
