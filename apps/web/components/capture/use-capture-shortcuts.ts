"use client";

import { useEffect, useRef } from "react";
import type { CaptureController } from "@/lib/capture/controller";
import { measurePressFeedback } from "@/lib/capture/feedback";

/** Fields where Space types a space. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "range", "reset", "submit", "color", "file"].includes(
      target.type,
    );
  }
  return false;
}

/**
 * Another control that Space activates: a button other than push-to-talk, a checkbox, a tab.
 * Links aren't among them (Space only scrolls past a link), so Space talks with a link focused,
 * as it is right after following one to another page.
 */
function isOtherControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || target.closest("[data-ptt]")) return false;
  return Boolean(
    target.closest(
      'button, input, select, textarea, summary, [role="button"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="tab"], [role="radio"], [role="option"]',
    ),
  );
}

/**
 * A dialog is open, or the key came from inside one: a dialog keeps its own keys. The target is
 * checked too, because the dialog's own Esc handler may already have closed (and removed) it by
 * the time the key reaches the window.
 */
function inDialog(event: KeyboardEvent): boolean {
  const target = event.target;
  if (target instanceof Node && !target.isConnected) return true;
  if (target instanceof HTMLElement && target.closest('[role="dialog"], [role="alertdialog"]')) {
    return true;
  }
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

/**
 * A key from the review list (the tray's cards, their editors, choices, and correction panels) or
 * from what it opens in a portal (a card's More menu, a toast's Undo): the list's keys, never the
 * screen's. Esc there closes an editor, a panel, or a menu; it must never end the session.
 */
function inReviewSurface(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      '[data-review-list], [role="menu"], [role="menuitem"], [data-slot="toast-viewport"]',
    ) !== null
  );
}

/**
 * The capture shortcuts. `screen` (the capture screen): hold Space to talk, `H` hands-free, `P`
 * pause live updates, `Esc` end, `?` shortcuts. `dock` (the mini-session on other pages): Space
 * only, so the rest of the app keeps its own keys. Space never fires in a text field, and leaves
 * other buttons to activate as usual. The screen's letters, `Esc`, and `?` ignore keys from the
 * review list and the popups it opens (Phase 5 WP6), which keep their own.
 */
export function useCaptureShortcuts(
  controller: CaptureController,
  scope: "screen" | "dock",
  options: { enabled: boolean; onHelp?: () => void },
): void {
  const { enabled, onHelp } = options;
  const help = useRef(onHelp);
  useEffect(() => {
    help.current = onHelp;
  }, [onHelp]);

  useEffect(() => {
    if (!enabled) return;
    let spaceHeld = false;

    const down = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextEntry(event.target)) return;
      if (event.code === "Space" || event.key === " ") {
        if (isOtherControl(event.target) || inDialog(event)) return;
        event.preventDefault();
        if (event.repeat || spaceHeld) return;
        spaceHeld = true;
        measurePressFeedback(event.timeStamp);
        controller.press();
        return;
      }
      if (scope !== "screen" || event.repeat || inDialog(event)) return;
      if (inReviewSurface(event.target)) return;
      switch (event.key) {
        case "h":
        case "H":
          event.preventDefault();
          controller.toggleHandsFree();
          return;
        case "p":
        case "P":
          event.preventDefault();
          controller.togglePause();
          return;
        case "Escape":
          event.preventDefault();
          void controller.end();
          return;
        case "?":
          event.preventDefault();
          help.current?.();
          return;
        default:
          return;
      }
    };
    const up = (event: KeyboardEvent) => {
      if ((event.code === "Space" || event.key === " ") && spaceHeld) {
        event.preventDefault();
        spaceHeld = false;
        controller.release(event.timeStamp);
      }
    };
    // Letting go of Space in another window must still end the press.
    const blur = () => {
      if (!spaceHeld) return;
      spaceHeld = false;
      controller.release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      if (spaceHeld) controller.release();
    };
  }, [controller, scope, enabled]);
}
