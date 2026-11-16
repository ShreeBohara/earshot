import { withViewer } from "@/lib/auth/viewer";
import { keyRouteDeps } from "@/lib/keys/deps";
import { validateKeyRoute } from "@/lib/keys/routes";

export const dynamic = "force-dynamic";

/**
 * Checks an AI provider key with its provider and stores nothing. The key travels in the
 * `x-earshot-provider-key` header and the provider in the JSON body, `{ "provider": "openai" }`.
 * Signed-in users only, rate-limited per user and per IP, so it can't be used to test stolen
 * keys. Answers `{ ok, provider, last4, reason? }`, never anything the provider sent back
 * (lib/keys/routes.ts, docs/adr/0021).
 */
export const POST = withViewer(async (viewer, request) =>
  validateKeyRoute(viewer, request, await keyRouteDeps()),
);
