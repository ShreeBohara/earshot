import { getCloudflareContext } from "@opennextjs/cloudflare";
import { auditKeysResponse, readAuditKeys } from "@/lib/audit/keys";
import { log } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * The public keys that verify the audit chain's checkpoints (docs/adr/0033): the active key and
 * the retired ones, as `{ keys: [{ kid, alg: "Ed25519", x, status, retiredAt? }] }`. No sign-in:
 * they're public, and a verifier anywhere may need them. Save the answer to check an export
 * without trusting the export's own copy of the keys (`db:audit-verify --keys`).
 */
export async function GET() {
  return auditKeysResponse(await readAuditKeys(getCloudflareContext().env, { log }));
}
