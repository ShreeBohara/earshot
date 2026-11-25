import { withViewer } from "@/lib/auth/viewer";
import { sessionCorrectionsRoute } from "@/lib/reviews/corrections";
import { correctionRouteDeps } from "@/lib/reviews/deps";

export const dynamic = "force-dynamic";

/**
 * A correction, or a follow-up question skipped, for one of the viewer's sessions once it's sealed
 * (docs/adr/0038): `{ "t": "correct", "correctionId", "proposalId", "field", "questionId"?, "said",
 * "timeZone"? }` or `{ "t": "skip", "questionId" }`. Typed words become a typed utterance and a
 * dictation's a spoken one; the words are read with the linker over the workspace's mirror and the
 * normalizers, into a proposal that supersedes the one corrected. Answers `{ sessionId, outcome,
 * proposalId, recorded, lastSeq }`; 409 `not_sealed` while the session is still finishing, 409
 * `stale` for a card that changed, 422 `unreadable` for words with no value of the field's kind,
 * 429 `too_many` past a correction limit (lib/reviews/corrections.ts).
 */
export const POST = withViewer<RouteContext<"/api/sessions/[id]/corrections">>(
  async (viewer, request, { params }) =>
    sessionCorrectionsRoute(viewer, request, (await params).id, await correctionRouteDeps()),
);
