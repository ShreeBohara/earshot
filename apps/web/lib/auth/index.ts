import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb, requestScopedDb } from "../db";
import { createLogger } from "../log";
import { MODE, readAuthConfig, secretValues } from "./config";
import { type Auth, createAuth } from "./server";

export type { Auth } from "./server";

let auth: Auth | undefined;

/** The server log, redacting this environment's secrets. */
export const log = createLogger(() => {
  try {
    return secretValues(getCloudflareContext().env);
  } catch {
    // Outside a request there's no environment to read; provider-key patterns still apply.
    return [];
  }
});

/**
 * The app's Better Auth instance, built once per isolate from the Worker's environment. It reaches
 * the database through `requestScopedDb`, so each request uses its own pool. Throws, and keeps
 * throwing, while required configuration is missing outside development (lib/auth/config.ts):
 * sign-in fails closed rather than run with a default secret.
 */
export async function getAuth(): Promise<Auth> {
  // Under `next dev`, open (and migrate) the local database before Better Auth touches it. In a
  // Worker the request's pool opens lazily, on Better Auth's first query.
  if (process.env.NODE_ENV === "development") await getDb();
  auth ??= createAuth({
    config: readAuthConfig(getCloudflareContext().env, MODE),
    db: requestScopedDb,
    log,
  });
  return auth;
}
