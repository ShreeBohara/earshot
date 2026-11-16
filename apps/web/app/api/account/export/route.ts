import { buildAccountExport } from "@earshot/db";
import { withViewer } from "@/lib/auth/viewer";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * One JSON download with everything Earshot holds about the signed-in user: profile, sign-in
 * methods, sessions, and every tenant table's rows for their workspaces, read through RLS. No
 * secrets: tokens, password hashes, and encrypted key material stay in the database. Recorded in
 * each workspace's audit log as `account.exported`.
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
  const exported = await buildAccountExport(await getDb(), viewer.user.id);
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
