import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { log } from "../auth";
import { MODE } from "../auth/config";
import { withViewerTenant } from "../auth/viewer";
import type { PolicyRouteDeps } from "./routes";

/**
 * What the approval policy route runs on in this request: the viewer's tenant transaction, the
 * Worker's environment (for the audit signing key), the log, and the clock.
 */
export function policyRouteDeps(): PolicyRouteDeps {
  return {
    withViewerTenant,
    env: getCloudflareContext().env,
    log,
    now: () => new Date(),
    mode: MODE,
  };
}
