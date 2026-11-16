import { withViewer } from "@/lib/auth/viewer";
import { voiceRouteDeps } from "@/lib/voice/deps";
import { sessionTicketRoute } from "@/lib/voice/routes";

export const dynamic = "force-dynamic";

/**
 * A fresh ticket for reconnecting to one of the viewer's open sessions, since each ticket opens
 * one socket: `{ sessionId, ticket, ticketExpiresAt, edgeUrl }`. 404 for a session that isn't
 * the viewer's, 409 for one that has ended (lib/voice/routes.ts, docs/adr/0023).
 */
export const POST = withViewer<RouteContext<"/api/sessions/[id]/ticket">>(
  async (viewer, request, { params }) =>
    sessionTicketRoute(viewer, request, (await params).id, await voiceRouteDeps()),
);
