"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@earshot/ui/components/dialog";
import { Kbd } from "@earshot/ui/components/kbd";
import { INBOX_SHORTCUTS } from "@/lib/inbox/keys";
import { CaptureLink } from "../capture/link";

/**
 * `?`, or the inbox's "Keyboard shortcuts" button: the inbox's keys, where they work, how a screen
 * reader passes them through (NVDA's browse mode takes several letters and the digits for itself),
 * and where to turn them off.
 */
export function InboxShortcutsDialog({
  open,
  onOpenChange,
  shortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether this device has them on. */
  shortcuts: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Inbox keyboard shortcuts</DialogTitle>
          <DialogDescription>
            {shortcuts
              ? "Single keys act on the card that has focus, while focus is in the list and not in a text field."
              : "Single-key shortcuts are off on this device. Every action is also a button on its card."}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 text-sm">
          {INBOX_SHORTCUTS.map((shortcut) => (
            <div key={shortcut.action} className="contents">
              <dt className="flex gap-1">
                {shortcut.keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </dt>
              <dd>{shortcut.action}</dd>
            </div>
          ))}
        </dl>
        <div className="grid gap-2 text-muted-foreground text-sm">
          <p>
            Using NVDA? Its browse mode keeps letters and numbers for itself. Press NVDA+Space to
            switch to focus mode so these keys reach the inbox, or Tab to each card’s buttons.
          </p>
          <p>
            Turn single-key shortcuts {shortcuts ? "off" : "on"} in{" "}
            <CaptureLink
              href="/settings/review"
              className="rounded-sm text-foreground underline underline-offset-4 outline-none focus-visible:focus-ring"
            >
              Settings → Review
            </CaptureLink>
            .
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
