import { withViewer } from "@/lib/auth/viewer";
import { reviewRouteDeps } from "@/lib/reviews/deps";
import { sessionReviewsRoute } from "@/lib/reviews/routes";

export const dynamic = "force-dynamic";

/**
 * Reviews and snoozes for one of the viewer's sessions, once it's sealed (docs/adr/0032):
 * `{ "reviews": [...], "snoozes": [...] }`, 1 to 25 in all, each as the tray would send it over
 * the socket. Answers `{ sessionId, reviews, snoozes, lastSeq }`; 409 `not_sealed` while the
 * session is still finishing, 409 `stale` for a card that changed, 503 `audit_unavailable`
 * without a signing key (lib/reviews/routes.ts).
 */
export const POST = withViewer<RouteContext<"/api/sessions/[id]/reviews">>(
  async (viewer, request, { params }) =>
    sessionReviewsRoute(viewer, request, (await params).id, reviewRouteDeps()),
);
