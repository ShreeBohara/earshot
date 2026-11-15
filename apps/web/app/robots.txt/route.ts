import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

/** Only production is indexable; previews and local dev disallow everything. */
export function GET() {
  const { env } = getCloudflareContext();
  const body =
    env.DEPLOY_ENV === "production" ? "User-agent: *\nAllow: /\n" : "User-agent: *\nDisallow: /\n";
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
