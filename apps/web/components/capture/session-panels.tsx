"use client";

import type { EntityRef } from "@earshot/core";
import { cn } from "@earshot/ui/lib/utils";
import type { SessionState } from "@earshot/voice/session";
import { useMemo, useState } from "react";
import { type ActivityRow, deriveActivity } from "@/lib/capture/activity";
import { evidenceSpans } from "@/lib/capture/mentions";
import { ActivityFeed } from "./activity-feed";
import { LiveTranscript } from "./live-transcript";
import { ProposalsTray } from "./proposals-tray";

export interface SessionPanelsProps {
  /** A session store's state: live from SessionClient, or a replay's (`/demo`). */
  state: SessionState | null;
  /** The session's CRM records: what `start` carried. */
  entities: readonly EntityRef[];
  partial?: string | null;
  /** The screen's own feed rows, merged with the session's. */
  activity?: readonly ActivityRow[];
  /** Replays show review status. */
  showReview?: boolean;
  onPainted?: (proposalId: string, at: number) => void;
  transcriptEmptyText?: string;
  className?: string;
}

const NO_ROWS: readonly ActivityRow[] = [];

/**
 * The transcript, the activity feed, and the proposals tray for one session state, wired so that
 * hovering or focusing a proposal marks its quoted words. The capture screen renders it live;
 * WP10's replay renders it from `new SessionStore(id)` fed with `applyEvent`.
 */
export function SessionPanels({
  state,
  entities,
  partial = null,
  activity = NO_ROWS,
  showReview = false,
  onPainted,
  transcriptEmptyText,
  className,
}: SessionPanelsProps) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const utterances = state?.projections.utterances;
  const proposals = state?.projections.proposals;
  const lines = useMemo(
    () => (utterances ?? []).map((u) => ({ id: u.utteranceId, text: u.text })),
    [utterances],
  );
  const quotes = useMemo(
    () => new Map((utterances ?? []).map((u) => [u.utteranceId, u.text])),
    [utterances],
  );
  const highlights = useMemo(() => {
    const proposal = proposals?.find((p) => p.proposalId === highlighted);
    return proposal ? evidenceSpans(proposal.fields) : null;
  }, [proposals, highlighted]);
  const rows = useMemo(() => deriveActivity(state, activity), [state, activity]);

  return (
    <div className={cn("grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]", className)}>
      <div className="flex min-w-0 flex-col gap-8">
        <LiveTranscript
          lines={lines}
          partial={partial}
          entities={entities}
          highlights={highlights}
          {...(transcriptEmptyText ? { emptyText: transcriptEmptyText } : {})}
        />
        <ActivityFeed rows={rows} />
      </div>
      <ProposalsTray
        className="min-w-0"
        proposals={proposals ?? []}
        entities={entities}
        quotes={quotes}
        showReview={showReview}
        highlightedId={highlighted}
        onHighlight={setHighlighted}
        {...(onPainted ? { onPainted } : {})}
      />
    </div>
  );
}
