"use client";

import type { KeyboardEvent } from "react";
import { followupStopId } from "@/lib/inbox/focus";
import { type InboxKeyAction, inboxKeyAction } from "@/lib/inbox/keys";

export interface InboxKeyHandlers {
  /** Whether the shortcuts are on (Settings → Review). Off, no key acts. */
  readonly enabled: boolean;
  /**
   * A shortcut pressed in the list: the action, and the card focus is in (null on the list's
   * other parts, such as the "All caught up" heading). A follow-up question's card (WP13) is
   * `followup:<questionId>`. Return false when it did nothing, so the key keeps its default.
   */
  readonly onAction: (
    action: InboxKeyAction,
    cardId: string | null,
    event: KeyboardEvent<HTMLElement>,
  ) => boolean;
}

/**
 * The list's key handler (spec decision 7, WP5 step 6), for `onKeyDown` on the element holding the
 * inbox's list and its "All caught up" heading, so a key acts only while focus is in it. It
 * ignores keys:
 * - with the shortcuts off;
 * - from outside the element's own DOM (React passes keys up from portals, such as a card's menu);
 * - from a text field, or anywhere in an open editor, which keeps Enter and Esc for itself;
 * - from "accept all"'s checkpoint, whose buttons take Enter and Space, and Esc closes;
 * - in an open correction panel, but for the digits that choose there (Esc closes it itself);
 * - in a follow-up question's answer box, which keeps Enter and Esc for itself (WP13).
 */
export function useInboxKeys({ enabled, onAction }: InboxKeyHandlers) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (!enabled || event.defaultPrevented) return;
    const container = event.currentTarget;
    const target = event.target;
    if (!(target instanceof Element) || !container.contains(target)) return;
    if (target.closest("[data-inbox-editor], [data-inbox-checkpoint], [data-followup-answer]")) {
      return;
    }
    const action = inboxKeyAction({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
      target,
    });
    if (!action) return;
    if (target.closest("[data-inbox-correction]") && action.kind !== "choose") return;
    const card = target.closest<HTMLElement>("[data-inbox-card]");
    const question = card ? null : target.closest<HTMLElement>("[data-inbox-followup]");
    const cardId =
      card?.dataset.proposalId ??
      (question?.dataset.followupId ? followupStopId(question.dataset.followupId) : null);
    if (onAction(action, cardId, event)) event.preventDefault();
  };
}
