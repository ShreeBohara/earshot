"use client";

import { Kbd } from "@earshot/ui/components/kbd";
import { Switch } from "@earshot/ui/components/switch";
import { useId, useState } from "react";
import { INBOX_SHORTCUTS } from "@/lib/inbox/keys";
import { useShortcutsSetting } from "./use-shortcuts-setting";

/**
 * Settings → Review's shortcuts switch (spec decision 7, WP5 step 6; WCAG 2.2 SC 2.1.4): the inbox's
 * single-key shortcuts, on by default, turned off per device. Off, no single key acts in the
 * inbox; every action stays a button.
 */
export function ReviewShortcutsSetting() {
  const [on, save] = useShortcutsSetting();
  const [saved, setSaved] = useState(false);
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div className="grid gap-4">
      <div className="flex items-start justify-between gap-4 rounded-lg border px-4 py-3">
        <div className="grid gap-1">
          <p id={labelId} className="font-medium text-sm">
            Single-key shortcuts
          </p>
          <p id={descriptionId} className="max-w-prose text-pretty text-muted-foreground text-sm">
            J and K move between cards, A accepts, R rejects, and so on. They work only while focus
            is in the inbox’s list and not in a text field. Turn them off if you use speech input,
            or keys that a screen reader doesn’t pass through.
          </p>
        </div>
        <Switch
          checked={on}
          onCheckedChange={(checked) => {
            save(checked);
            setSaved(true);
          }}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          className="mt-0.5"
        />
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
        {INBOX_SHORTCUTS.map((shortcut) => (
          <div key={shortcut.action} className="contents">
            <dt className="flex gap-1">
              {shortcut.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd className="text-muted-foreground">{shortcut.action}</dd>
          </div>
        ))}
      </dl>
      <p aria-live="polite" className="text-muted-foreground text-sm">
        {saved ? `Saved on this device: shortcuts ${on ? "on" : "off"}.` : ""}
      </p>
    </div>
  );
}
