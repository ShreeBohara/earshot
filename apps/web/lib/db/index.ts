import "server-only";
import { createPoolDb } from "@earshot/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { after } from "next/server";
import type { AppDb } from "./types";

export type { AppDb } from "./types";

// One pool per request, keyed by the request's ExecutionContext. OpenNext keeps the Cloudflare
// context in AsyncLocalStorage, so `ctx` is unique to each request in a Worker.
const requestDatabases = new WeakMap<object, AppDb>();
let devDb: AppDb | undefined;

function requestDatabase(): AppDb {
  const { env, ctx } = getCloudflareContext();
  const cached = requestDatabases.get(ctx);
  if (cached) return cached;
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const db = createPoolDb(env.DATABASE_URL);
  requestDatabases.set(ctx, db);
  // A WebSocket can't outlive the request that opened it (docs/adr/0018). `after` runs once the
  // response has been sent, and OpenNext keeps the Worker alive for it with ctx.waitUntil.
  after(() => db.$client.end());
  return db;
}

/**
 * The owner connection for the current request: a Neon WebSocket pool opened on first use and
 * closed after the response, or under `next dev` a process-wide database (PGlite unless
 * DATABASE_URL is set). Runs as the owner, so RLS doesn't apply: tenant data goes through
 * `withViewerTenant` (lib/auth/viewer.ts), never straight through this.
 *
 * Production builds must run in workerd (`pnpm preview` or a deploy), where each request has its
 * own ExecutionContext. `next start` shares one, and isn't supported.
 */
export async function getDb(): Promise<AppDb> {
  if (process.env.NODE_ENV === "development") {
    if (!devDb) {
      const { devDatabase } = await import("./dev");
      devDb = await devDatabase(getCloudflareContext().env.DATABASE_URL);
    }
    return devDb;
  }
  return requestDatabase();
}

/** Like `getDb`, synchronously. Under `next dev` it needs an earlier `await getDb()`. */
export function currentDb(): AppDb {
  if (process.env.NODE_ENV === "development") {
    if (!devDb) throw new Error("The development database isn't open yet: await getDb() first");
    return devDb;
  }
  return requestDatabase();
}

/**
 * A stand-in for the current request's owner connection, for objects built once per isolate that
 * hold on to a database, such as Better Auth's Drizzle adapter. Each property access resolves the
 * request's own pool, so nothing crosses requests.
 */
export const requestScopedDb: AppDb = new Proxy({} as AppDb, {
  get(_target, property) {
    const db = currentDb();
    const value: unknown = Reflect.get(db, property, db);
    return typeof value === "function" ? value.bind(db) : value;
  },
});
