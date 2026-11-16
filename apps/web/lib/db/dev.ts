// The `next dev` database. lib/db/index.ts imports this module only behind
// `process.env.NODE_ENV === "development"`, which the production build replaces with `false`, so
// this file and PGlite never reach a Worker bundle.
import path from "node:path";
import { createPoolDb } from "@earshot/db";
import { openPglite } from "./pglite";
import type { AppDb } from "./types";

type DevDatabase = { kind: "pglite" | "neon"; ready: Promise<AppDb> };

const KEY = Symbol.for("earshot.dev-database");

/**
 * One database per `next dev` process, kept on globalThis so hot reloads reuse it (a file-backed
 * PGlite must only be opened once). With DATABASE_URL set it's a long-lived Neon pool, which a
 * Node process can keep open across requests; without it, PGlite persisted in apps/web/.data/
 * with every migration applied. Restart `pnpm dev` after changing DATABASE_URL.
 */
export function devDatabase(databaseUrl: string | undefined): Promise<AppDb> {
  const store = globalThis as typeof globalThis & { [KEY]?: DevDatabase };
  const existing = store[KEY];
  if (existing) return existing.ready;

  const dataDir = path.join(process.cwd(), ".data", "pglite");
  const opened: DevDatabase = databaseUrl
    ? { kind: "neon", ready: Promise.resolve(createPoolDb(databaseUrl)) }
    : { kind: "pglite", ready: openPglite({ dataDir }) };
  store[KEY] = opened;
  opened.ready.then(
    () => {
      if (opened.kind === "pglite") {
        console.info(
          `[earshot] DATABASE_URL is unset: using in-process PGlite at ${path.relative(process.cwd(), dataDir)} (development only)`,
        );
      }
    },
    () => {
      // Let the next request try again instead of caching the failure.
      if (store[KEY] === opened) delete store[KEY];
    },
  );
  return opened.ready;
}
