"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { FocusTarget } from "@/lib/inbox/focus";

export interface RovingFocus {
  /** The card in the tab order: the one holding roving focus, else the first. */
  readonly activeId: string | null;
  /** Registers a card's element, for focusing it. */
  readonly register: (proposalId: string, element: HTMLElement | null) => void;
  /** Registers the "All caught up" heading. */
  readonly registerCaughtUp: (element: HTMLElement | null) => void;
  /**
   * Moves focus to a card or the "All caught up" heading, after the render that the same event
   * caused: a card that left is gone by then, and one coming back is there.
   */
  readonly focus: (target: FocusTarget) => void;
  /** Focus arrived in a card some other way (Tab, a click): it's the active card now. */
  readonly arrived: (proposalId: string) => void;
}

/**
 * The inbox list's roving focus (spec decision 7): one card at a time is in the tab order
 * (`tabIndex` 0, the rest -1), and j, k, and the focus rules move it. Every move lands on a card or
 * the "All caught up" heading, never on <body>.
 */
export function useRovingFocus(order: readonly (readonly string[])[]): RovingFocus {
  const [chosen, setChosen] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const elements = useRef(new Map<string, HTMLElement>());
  const caughtUp = useRef<HTMLElement | null>(null);
  const pending = useRef<FocusTarget | null>(null);

  const flat = order.flat();
  const activeId = chosen !== null && flat.includes(chosen) ? chosen : (flat[0] ?? null);

  // Runs for each focus request.
  useLayoutEffect(() => {
    const target = pending.current;
    if (!target) return;
    pending.current = null;
    const element = target.kind === "card" ? elements.current.get(target.id) : caughtUp.current;
    // A card that didn't render (a refusal took it back) leaves focus where it is.
    element?.focus();
  }, [request]);

  const register = useCallback((proposalId: string, element: HTMLElement | null) => {
    if (element) elements.current.set(proposalId, element);
    else elements.current.delete(proposalId);
  }, []);

  const registerCaughtUp = useCallback((element: HTMLElement | null) => {
    caughtUp.current = element;
  }, []);

  const focus = useCallback((target: FocusTarget) => {
    pending.current = target;
    setChosen(target.kind === "card" ? target.id : null);
    setRequest((count) => count + 1);
  }, []);

  const arrived = useCallback((proposalId: string) => setChosen(proposalId), []);

  return { activeId, register, registerCaughtUp, focus, arrived };
}
