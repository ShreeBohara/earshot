"use client";

import { useEffect, useRef, useState } from "react";
import { ReviewClock } from "@/lib/inbox/clock";

/** At least half a card on screen counts as seen (spec §4.8). */
const HALF = 0.5;

/** Inputs that say the reviewer is here: keys, pointers, scrolling, touch. */
const INPUT_EVENTS = ["keydown", "pointerdown", "wheel", "scroll", "touchstart"] as const;

export interface ReviewClockHandle {
  readonly clock: ReviewClock;
  /**
   * The "accept all" checkpoint's own clock (spec §4.8): it runs from opening the checkpoint to
   * confirming it, on a visible page and pausing after 30 s idle, as a card's does, and every item
   * of the batch carries its time. The page drives it with one key, `BATCH_CLOCK_KEY`.
   */
  readonly batchClock: ReviewClock;
  /** Watches a card for half-visibility; call with null to stop. */
  readonly observe: (proposalId: string, element: HTMLElement | null) => void;
}

/** The checkpoint's one "card" on the batch clock. */
export const BATCH_CLOCK_KEY = "accept-all";

function newClock(): ReviewClock {
  return new ReviewClock(
    {
      now: () => performance.now(),
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimeout: (handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    },
    { pageVisible: typeof document === "undefined" || document.visibilityState === "visible" },
  );
}

/**
 * The page's review clock (lib/inbox/clock.ts), fed by the page: visibility from
 * `visibilitychange`, each card's half-visibility from an IntersectionObserver, and the reviewer's
 * input from the window. The page tells it which card is active and when a decision is made, and
 * drives the checkpoint's clock (`batchClock`) itself; the same page events feed both.
 */
export function useReviewClock(activeId: string | null): ReviewClockHandle {
  const [clock] = useState(newClock);
  const [batchClock] = useState(newClock);
  const observer = useRef<IntersectionObserver | null>(null);
  const watched = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    clock.setActive(activeId);
  }, [clock, activeId]);

  useEffect(() => {
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      clock.setPageVisible(visible);
      batchClock.setPageVisible(visible);
    };
    const onInput = () => {
      clock.input();
      batchClock.input();
    };
    document.addEventListener("visibilitychange", onVisibility);
    for (const type of INPUT_EVENTS) {
      window.addEventListener(type, onInput, { capture: true, passive: true });
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.proposalId;
          if (id) clock.setVisible(id, entry.intersectionRatio >= HALF);
        }
      },
      { threshold: [0, HALF, 1] },
    );
    observer.current = io;
    for (const element of watched.current.values()) io.observe(element);
    onVisibility();
    // Mounted: the reviewer is here, and the idle timer starts.
    onInput();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, { capture: true });
      io.disconnect();
      observer.current = null;
      clock.dispose();
      batchClock.dispose();
    };
  }, [clock, batchClock]);

  const [observe] = useState(() => (proposalId: string, element: HTMLElement | null) => {
    const previous = watched.current.get(proposalId);
    if (previous && previous !== element) {
      observer.current?.unobserve(previous);
      watched.current.delete(proposalId);
      clock.setVisible(proposalId, false);
    }
    if (element && previous !== element) {
      watched.current.set(proposalId, element);
      observer.current?.observe(element);
    }
  });

  return { clock, batchClock, observe };
}
