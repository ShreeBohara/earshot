import { neon, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzlePool } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

/**
 * One-shot queries over Neon's HTTP driver, for non-tenant reads such as the health check.
 * It can't run interactive transactions, so it can't run `withTenant` (docs/adr/0018).
 */
export function createHttpDb(url: string) {
  return drizzleHttp({ client: neon(url), schema });
}

export type HttpDb = ReturnType<typeof createHttpDb>;

/**
 * A pool of WebSocket connections over Neon's serverless driver. It runs interactive
 * transactions, so tenant work goes through it with `withTenant` (docs/adr/0018).
 *
 * In a Worker, create one per request and close it when the request is done, for example
 * `ctx.waitUntil(db.$client.end())`: a WebSocket can't outlive the request that opened it.
 */
export function createPoolDb(url: string) {
  return drizzlePool({ client: new Pool({ connectionString: url }), schema });
}

export type PoolDb = ReturnType<typeof createPoolDb>;
