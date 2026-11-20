"use client";

import { Button } from "@earshot/ui/components/button";
import { AudioLinesIcon, PlayIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { playLabel } from "@/lib/evidence/copy";
import type { PlayableSpan } from "@/lib/evidence/state";
import { useEvidenceHub } from "./evidence-provider";

const noSubscription = () => () => {};

/**
 * A play button for a span of a card's words (Phase 5 spec WP9): a real button named for what it
 * plays ("Play what you said, 2 seconds"), by pointer, Enter, or Space. It has no single-key
 * shortcut of its own: the inbox's keys stay the spec's. Pressing it readies Web Audio in the press
 * itself, then plays the words with 250 ms either side; pressing it again plays them again.
 *
 * While its words play, its icon shows it (still, with reduced motion), and the page's status line
 * says "Playing what you said." once. Its name never changes, so nothing is announced twice. If the
 * clip has gone since the card rendered, the card says why, and focus moves to the card rather than
 * falling to the page as the button gives way.
 */
export function PlayEvidenceButton({ span }: { span: PlayableSpan }) {
  const hub = useEvidenceHub();
  const playing = useSyncExternalStore(
    hub?.subscribe ?? noSubscription,
    () => hub?.playing() === span.key,
    () => false,
  );
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label={playLabel(span.seconds)}
      data-slot="play-evidence"
      data-playing={playing ? "" : undefined}
      className="-my-0.5 ms-1 align-middle font-sans text-foreground"
      onClick={(event) => {
        if (!hub) return;
        const card = event.currentTarget.closest<HTMLElement>("[data-inbox-card]");
        void hub.play(span).then((outcome) => {
          if (outcome !== "missing" || !card) return;
          requestAnimationFrame(() => {
            const active = document.activeElement;
            if (!active || active === document.body) card.focus();
          });
        });
      }}
    >
      {playing ? (
        <AudioLinesIcon aria-hidden="true" className="motion-safe:animate-pulse" />
      ) : (
        <PlayIcon aria-hidden="true" />
      )}
      Play
    </Button>
  );
}
