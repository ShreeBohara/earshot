"use client";

import type { SessionState } from "@earshot/voice/session";
import { LoaderCircleIcon } from "lucide-react";
import { useMemo } from "react";
import type { EvidenceSession } from "@/lib/evidence/state";
import { RECAP_COPY } from "@/lib/recap/copy";
import { wordsFrom } from "@/lib/recap/view";
import { RecapPanel } from "./recap-panel";

/**
 * The capture screen's recap, once the debrief has ended (Phase 5 spec WP10 step 8): SessionDO's
 * `recap.created`, folded into the session's own store, with each sentence's words from the
 * session's utterances. Until it arrives (within 15 s, target), one quiet line says it's being
 * written; it never speaks on its own, since the transcript is the screen's one live region.
 */
export function CaptureRecap({ state, sealed }: { state: SessionState; sealed: boolean }) {
  const session = state.projections.session;
  const recap = session?.recap ?? null;
  const texts = useMemo(
    () =>
      Object.fromEntries(
        state.projections.utterances.map((utterance) => [utterance.utteranceId, utterance.text]),
      ),
    [state.projections.utterances],
  );
  const wordsOf = useMemo(() => wordsFrom(texts), [texts]);
  const clips = useMemo<EvidenceSession | null>(
    () =>
      session
        ? {
            sessionId: session.sessionId,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            recordedHere: true,
          }
        : null,
    [session],
  );
  if (!recap) {
    // Sealed with no recap: an older session, or a log that never got one. Say nothing.
    if (sealed || !session?.endedAt) return null;
    return (
      <p
        className="flex items-center gap-2 text-muted-foreground text-sm"
        data-slot="recap-pending"
      >
        <LoaderCircleIcon aria-hidden="true" className="size-4 motion-safe:animate-spin" />
        {RECAP_COPY.pending}
      </p>
    );
  }
  return (
    <RecapPanel
      recap={recap}
      wordsOf={wordsOf}
      headingLevel={3}
      {...(clips ? { session: clips } : {})}
    />
  );
}
