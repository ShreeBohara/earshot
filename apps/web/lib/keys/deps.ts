import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { log } from "../auth";
import { MODE } from "../auth/config";
import { getDb } from "../db";
import type { KeyRouteDeps } from "./routes";

/** What the key routes run on in this request: its database pool, the Worker's environment, the app's log. */
export async function keyRouteDeps(): Promise<KeyRouteDeps> {
  return {
    db: await getDb(),
    env: getCloudflareContext().env,
    log,
    fetch: (url, init) => fetch(url, init),
    now: () => new Date(),
    rateLimit: MODE === "production",
  };
}
