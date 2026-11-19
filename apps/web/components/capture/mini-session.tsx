"use client";

import { type LevelSource, Orb } from "@earshot/ui/components/orb";
import { cn } from "@earshot/ui/lib/utils";
import type { CaptureMode } from "@earshot/voice";
import { linkButton } from "@/components/link-button";
import { CaptureLink } from "./link";
import { PushToTalkButton } from "./push-to-talk";

export interface MiniSessionProps {
  levels: LevelSource;
  /** What the rep is doing: "Armed", "Listening", "Paused". */
  status: string;
  /** The last thing said: the live partial, or the last final line. */
  lastLine: string | null;
  proposalCount: number;
  mode: CaptureMode;
  pressed: boolean;
  /** Capture is running, so push-to-talk works. */
  canTalk: boolean;
  /** Capture stopped without ending the session (iOS stops the mic on navigation). */
  suspended: boolean;
  onPress: (at: number) => void;
  onRelease: (at: number) => void;
  onResume: () => void;
  onEnd: () => void;
  /** The capture screen's URL. */
  href?: string;
  /** Pinned to the bottom of the page; off for stories. */
  fixed?: boolean;
}

/**
 * The docked mini-session: a compact bar that keeps a debrief going while the rep browses, with
 * a small orb, the last line, the proposal count, and push-to-talk (Space works here too).
 */
export function MiniSession({
  levels,
  status,
  lastLine,
  proposalCount,
  mode,
  pressed,
  canTalk,
  suspended,
  onPress,
  onRelease,
  onResume,
  onEnd,
  href = "/capture",
  fixed = true,
}: MiniSessionProps) {
  return (
    <aside
      aria-label="Debrief in progress"
      data-slot="mini-session"
      className={cn(
        "border-t bg-background",
        fixed && "fixed inset-x-0 bottom-0 z-40 shadow-[0_-1px_12px_rgb(0_0_0/0.06)]",
      )}
    >
      <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-2 sm:px-6">
        <Orb levels={levels} size={40} label="Microphone level" />
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground text-xs">{status}</p>
          <p className="truncate font-serif text-base">{lastLine ?? "Nothing said yet"}</p>
        </div>
        <p className="hidden shrink-0 text-sm sm:block">
          <span className="font-mono tabular-nums">{proposalCount}</span>{" "}
          {proposalCount === 1 ? "proposal" : "proposals"}
        </p>
        {suspended ? (
          <button type="button" onClick={onResume} className={linkButton({ size: "sm" })}>
            Resume
          </button>
        ) : (
          <PushToTalkButton
            size="sm"
            hideCaption
            mode={mode}
            pressed={pressed}
            disabled={!canTalk}
            onPress={onPress}
            onRelease={onRelease}
          />
        )}
        <CaptureLink href={href} className={linkButton({ variant: "outline", size: "sm" })}>
          Open
        </CaptureLink>
        <button
          type="button"
          onClick={onEnd}
          className={linkButton({ variant: "ghost", size: "sm" })}
        >
          End
        </button>
      </div>
    </aside>
  );
}
