"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@earshot/ui/components/dialog";
import { Kbd } from "@earshot/ui/components/kbd";

export const CAPTURE_SHORTCUTS = [
  { keys: ["Space"], action: "Hold to talk (when you’re not typing)" },
  { keys: ["H"], action: "Switch between push-to-talk and hands-free" },
  { keys: ["P"], action: "Pause or resume live updates on screen" },
  { keys: ["Esc"], action: "End the debrief" },
  { keys: ["?"], action: "Show these shortcuts" },
] as const;

/** `?`: the capture screen's keyboard shortcuts. */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Everything on the capture screen works from the keyboard.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 text-sm">
          {CAPTURE_SHORTCUTS.map((shortcut) => (
            <div key={shortcut.action} className="contents">
              <dt>
                {shortcut.keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </dt>
              <dd>{shortcut.action}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
