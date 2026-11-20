"use client";

import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { browserEvidence } from "@/lib/evidence/browser";
import type { EvidenceHub } from "@/lib/evidence/hub";
import { type CardEvidence, cardEvidence, type EvidenceSession } from "@/lib/evidence/state";
import type { InboxProposal } from "@/lib/inbox/types";
import { useClipsSetting } from "./use-clips-setting";

const EvidenceContext = createContext<EvidenceHub | null>(null);

const noSubscription = () => () => {};

/**
 * Evidence clips for the signed-in app (Phase 5 spec WP9; ADR-0036): the page's hub for the cards
 * inside, the purge when Earshot starts and each time it comes back into view, and the one status
 * line that says a clip is playing. It sits in `(app)/layout.tsx`, so the line is outside `<main>`,
 * where nothing speaks on its own. The hub arrives after hydration: until then, and wherever no
 * provider is (the pilot, Storybook), cards render as they would without clips.
 */
export function EvidenceProvider({
  children,
  hub: given,
}: {
  children: ReactNode;
  hub?: EvidenceHub;
}) {
  const [hub, setHub] = useState<EvidenceHub | null>(given ?? null);
  useEffect(() => {
    if (!given) setHub(browserEvidence());
  }, [given]);
  useEffect(() => hub?.start(document), [hub]);
  return (
    <EvidenceContext value={hub}>
      {children}
      <EvidenceStatus hub={hub} />
    </EvidenceContext>
  );
}

/** "Playing what you said.", once, as a clip starts; quiet otherwise. */
function EvidenceStatus({ hub }: { hub: EvidenceHub | null }) {
  const text = useSyncExternalStore(
    hub?.subscribe ?? noSubscription,
    () => hub?.announcement() ?? "",
    () => "",
  );
  return (
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      data-slot="clip-status"
    >
      {text}
    </p>
  );
}

/** The page's evidence hub, or null where clips don't exist. */
export function useEvidenceHub(): EvidenceHub | null {
  return use(EvidenceContext);
}

/**
 * What a card can play, and why the rest can't, kept current: the session's clips as read, this
 * device's setting, and the cards' clock. Null where clips don't exist, or before the hub has read
 * anything, so the card renders as it would without clips.
 */
export function useCardEvidence(
  session: EvidenceSession,
  proposal: Pick<InboxProposal, "proposalId" | "target" | "fields">,
  targetShown: boolean,
): CardEvidence | null {
  const hub = useEvidenceHub();
  const [setting] = useClipsSetting();
  const { sessionId, startedAt, endedAt, recordedHere } = session;
  const subscribe = hub?.subscribe ?? noSubscription;
  const index = useSyncExternalStore(
    subscribe,
    () => hub?.index(sessionId) ?? null,
    () => null,
  );
  const now = useSyncExternalStore(
    subscribe,
    () => hub?.now() ?? 0,
    () => 0,
  );
  useEffect(
    () => hub?.watch({ sessionId, startedAt, endedAt, recordedHere }),
    [hub, sessionId, startedAt, endedAt, recordedHere],
  );
  return useMemo(
    () =>
      hub && index
        ? cardEvidence(
            { setting, index, session: { sessionId, startedAt, endedAt, recordedHere }, now },
            proposal,
            targetShown,
          )
        : null,
    [hub, index, setting, sessionId, startedAt, endedAt, recordedHere, now, proposal, targetShown],
  );
}
