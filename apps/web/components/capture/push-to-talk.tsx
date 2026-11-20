"use client";

import { cn } from "@earshot/ui/lib/utils";
import type { CaptureMode } from "@earshot/voice";
import { MicIcon, RadioIcon } from "lucide-react";
import { type PointerEvent, useId, useRef } from "react";
import { measurePressFeedback } from "@/lib/capture/feedback";

export interface PushToTalkButtonProps {
  pressed: boolean;
  mode: CaptureMode;
  disabled?: boolean;
  /** `lg` on the capture screen (96 px), `sm` in the docked bar (44 px): both above 24×24. */
  size?: "lg" | "sm";
  /** With the DOM event's timestamp, on the page's clock. */
  onPress: (at: number) => void;
  onRelease: (at: number) => void;
  /** Hide the visible caption (the docked bar has no room); the name stays. */
  hideCaption?: boolean;
  className?: string;
}

/**
 * Hold to talk. Pointer capture keeps the press when a finger slides off the button, and a lost
 * capture or a cancelled pointer releases it. Space works too: the capture shortcuts handle it
 * page-wide, this button included. In hands-free mode the button only shows that Earshot is
 * listening.
 */
export function PushToTalkButton({
  pressed,
  mode,
  disabled = false,
  size = "lg",
  onPress,
  onRelease,
  hideCaption = false,
  className,
}: PushToTalkButtonProps) {
  const hintId = useId();
  const holding = useRef(false);
  const handsFree = mode === "hands_free";
  const inactive = disabled || handsFree;

  const down = (event: PointerEvent<HTMLButtonElement>) => {
    if (inactive || event.button !== 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer (some test drivers) can't be captured; the press still counts.
    }
    holding.current = true;
    measurePressFeedback(event.timeStamp);
    onPress(event.timeStamp);
  };
  const up = (event: PointerEvent<HTMLButtonElement>) => {
    if (!holding.current) return;
    holding.current = false;
    onRelease(event.timeStamp);
  };

  const caption = handsFree
    ? "Hands-free: listening"
    : pressed
      ? "Listening… release to send"
      : "Hold to talk";

  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <button
        type="button"
        data-ptt=""
        data-pressed={pressed ? "" : undefined}
        aria-pressed={handsFree ? undefined : pressed}
        aria-disabled={inactive || undefined}
        aria-keyshortcuts="Space"
        aria-describedby={hintId}
        aria-label={handsFree ? "Hands-free is on" : "Push to talk"}
        onPointerDown={down}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={up}
        onContextMenu={(event) => event.preventDefault()}
        className={cn(
          "relative inline-flex touch-none select-none items-center justify-center rounded-full border-2 outline-none transition-[transform,background-color,border-color] duration-100 focus-visible:focus-ring motion-reduce:transition-none",
          size === "lg" ? "size-24" : "size-11",
          inactive
            ? "cursor-not-allowed border-border bg-muted text-muted-foreground"
            : "cursor-pointer border-foreground/20 bg-card text-foreground hover:border-foreground/40 active:scale-95 active:border-state-proposed active:bg-state-proposed-bg",
          pressed &&
            "scale-95 border-state-proposed bg-state-proposed-bg text-state-proposed-text motion-reduce:scale-100",
        )}
      >
        {handsFree ? (
          <RadioIcon aria-hidden="true" className={size === "lg" ? "size-8" : "size-5"} />
        ) : (
          <MicIcon aria-hidden="true" className={size === "lg" ? "size-8" : "size-5"} />
        )}
      </button>
      <p
        id={hintId}
        className={cn("text-center text-muted-foreground text-xs", hideCaption && "sr-only")}
      >
        {caption}
        <span className="sr-only">
          {handsFree
            ? ". Press H for push-to-talk."
            : ". Hold the button, or hold Space, while you speak."}
        </span>
      </p>
    </div>
  );
}
