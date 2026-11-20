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
import { browserEvidence, claimBrowserClips } from "@/lib/evidence/browser";
import type { EvidenceHub } from "@/lib/evidence/hub";
import { CLIPS_OWNER_KEY, clipsOwner } from "@/lib/evidence/owner";
import { browserStorage } from "@/lib/evidence/setting";
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
 *
 * The clips belong to the signed-in viewer (lib/evidence/owner.ts). As the app opens, clips
 * another user left on this browser are cleared before anything is kept. When another tab signs
 * out or another user signs in, this tab stops playing and keeps nothing more.
 */
export function EvidenceProvider({
  children,
  hub: given,
  viewerId,
}: {
  children: ReactNode;
  hub?: EvidenceHub;
  /** The signed-in user the device's clips are kept for; absent in Storybook and the tests. */
  viewerId?: string;
}) {
  const [hub, setHub] = useState<EvidenceHub | null>(given ?? null);
  useEffect(() => {
    if (!given) setHub(browserEvidence());
  }, [given]);
  useEffect(() => hub?.start(document), [hub]);
  useEffect(() => {
    if (!hub || given || !viewerId) return;
    void claimBrowserClips(viewerId);
    const onStorage = (event: StorageEvent) => {
      // A null key is `localStorage.clear()`.
      if (event.key !== CLIPS_OWNER_KEY && event.key !== null) return;
      const owner = clipsOwner(browserStorage());
      if (owner === viewerId) return;
      // Writes stop on their own (`ownsBrowserClips`). Playback stops here, and a sign-out
      // elsewhere clears what's left. Another user's store is theirs: their tab cleared it.
      hub.stop();
      if (owner === null) void hub.clear();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [hub, given, viewerId]);
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
