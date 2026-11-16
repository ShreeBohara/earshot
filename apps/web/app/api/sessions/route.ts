import { withViewer } from "@/lib/auth/viewer";
import { voiceRouteDeps } from "@/lib/voice/deps";
import { createSessionRoute } from "@/lib/voice/routes";

export const dynamic = "force-dynamic";

/**
 * Starts a debrief: `{ "mode": "debrief", "engine": "cascaded", "providers": { "speechToText",
 * "llm" }, "selectedAccountId"? }`. Writes the session's row in the viewer's workspace, then
 * answers 201 with `{ sessionId, ticket, ticketExpiresAt, edgeUrl, entities, keyterms }`: the
 * first ticket for the edge Worker's session socket, the CRM records the session may mention,
 * and keyterms for each speech-to-text provider. Signed-in users only, 20 per 10 minutes
 * (lib/voice/routes.ts, docs/adr/0023).
 */
export const POST = withViewer(async (viewer, request) =>
  createSessionRoute(viewer, request, await voiceRouteDeps()),
);
