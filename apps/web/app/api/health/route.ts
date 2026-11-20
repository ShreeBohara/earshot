import { HealthResponse } from "@earshot/core";
import { createHttpDb, readDbHealth } from "@earshot/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { readAuditKeys } from "@/lib/audit/keys";
import { log } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function edgeHealth(env: CloudflareEnv): Promise<unknown> {
  // In `next dev` the service binding can be missing; fall back to the local edge Worker.
  const response = env.EDGE
    ? await env.EDGE.fetch("https://edge/health")
    : await fetch(`${env.EDGE_DEV_URL ?? "http://localhost:8787"}/health`);
  if (!response.ok) throw new Error(`edge returned ${response.status}`);
  return response.json();
}

async function dbHealth(env: CloudflareEnv) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return readDbHealth(createHttpDb(env.DATABASE_URL));
}

/**
 * Proves web → edge → Durable Object and web → Postgres (with the branch read from the database),
 * and says whether this Worker can sign audit checkpoints (docs/adr/0033), never with the key.
 * The signing key is reported, not counted in `status`: until it's set, only the writes that need
 * a checkpoint fail closed.
 */
export async function GET() {
  const { env } = getCloudflareContext();
  const [edge, db, audit] = await Promise.allSettled([
    edgeHealth(env),
    dbHealth(env),
    readAuditKeys(env, { log }),
  ]);

  const body = HealthResponse.parse({
    status: edge.status === "fulfilled" && db.status === "fulfilled" ? "ok" : "degraded",
    version: env.GIT_SHA,
    env: env.DEPLOY_ENV,
    edge: edge.status === "fulfilled" ? edge.value : { status: "error" },
    db: db.status === "fulfilled" ? db.value : { status: "error" },
    audit: { signingKey: audit.status === "fulfilled" ? audit.value.signing.status : "invalid" },
  });

  return Response.json(body, {
    status: body.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
