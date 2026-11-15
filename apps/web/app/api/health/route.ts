import { HealthResponse } from "@earshot/core";
import { createHttpDb, readDbHealth } from "@earshot/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";

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

/** Proves web → edge → Durable Object and web → Postgres (with the branch read from the database). */
export async function GET() {
  const { env } = getCloudflareContext();
  const [edge, db] = await Promise.allSettled([edgeHealth(env), dbHealth(env)]);

  const body = HealthResponse.parse({
    status: edge.status === "fulfilled" && db.status === "fulfilled" ? "ok" : "degraded",
    version: env.GIT_SHA,
    env: env.DEPLOY_ENV,
    edge: edge.status === "fulfilled" ? edge.value : { status: "error" },
    db: db.status === "fulfilled" ? db.value : { status: "error" },
  });

  return Response.json(body, {
    status: body.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
