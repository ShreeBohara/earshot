import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { log } from "../auth";
import { MODE } from "../auth/config";
import { withViewerTenant } from "../auth/viewer";
import { getDb } from "../db";
import type { VoiceRouteDeps } from "./routes";

/**
 * What the session and voice-token routes run on in this request: its database pool and the
 * viewer's tenant transaction (`withViewerTenant`, on the same pool), the Worker's environment,
 * the app's log, the global fetch, and the clock.
 */
export async function voiceRouteDeps(): Promise<VoiceRouteDeps> {
  return {
    db: await getDb(),
    withViewerTenant,
    env: getCloudflareContext().env,
    log,
    fetch: (url, init) => fetch(url, init),
    now: () => new Date(),
    mode: MODE,
    rateLimit: MODE === "production",
  };
}
