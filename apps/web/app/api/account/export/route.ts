import { buildAccountExport } from "@earshot/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { readAuditKeys } from "@/lib/audit/keys";
import { log } from "@/lib/auth";
import { withViewer } from "@/lib/auth/viewer";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * One JSON download with everything Earshot holds about the signed-in user: profile, sign-in
 * methods, sessions, and every tenant table's rows for their workspaces, read through RLS. No
 * secrets: tokens, password hashes, and encrypted key material stay in the database. Recorded in
 * each workspace's audit log as `account.exported`.
 *
 * Each workspace's audit chain comes with its canonical texts and checkpoints, and the file carries
 * the public signing keys, so `db:audit-verify` checks it offline (docs/adr/0033). With a signing
 * key, each exported head is signed as an `export` checkpoint, so the export verifies through its
 * last entry. A missing or broken key never blocks an export: it carries whatever public keys
 * there are, and its newest entries check as unsigned.
 */
export const GET = withViewer(async (viewer, request) => {
  // Another site could still make the browser fetch this (it can't read the answer). Refuse, so
  // only Earshot's own pages and direct visits download an export.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json(
      { error: "forbidden", message: "Download your export from Earshot's settings page." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  const audit = await readAuditKeys(getCloudflareContext().env, { log });
  const auditKeys = audit.publicKeys.ok
    ? audit.publicKeys.keys
    : "signer" in audit.signing
      ? [audit.signing.signer.publicKey]
      : [];
  const exported = await buildAccountExport(await getDb(), viewer.user.id, new Date(), {
    auditKeys,
    ...("signer" in audit.signing ? { signer: audit.signing.signer } : {}),
  });
  const day = exported.exportedAt.slice(0, 10);
  return new Response(`${JSON.stringify(exported, null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="earshot-export-${day}.json"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
