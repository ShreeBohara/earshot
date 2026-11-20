"use client";

import { Switch } from "@earshot/ui/components/switch";
import { useEffect, useId, useState } from "react";
import { browserEvidence } from "@/lib/evidence/browser";
import { CLIPS_COPY } from "@/lib/evidence/copy";
import { requestPersistenceOnce } from "@/lib/keys/device-storage";
import { useClipsSetting } from "./use-clips-setting";

/**
 * Settings → Capture's "Evidence clips" (Phase 5 spec WP9 step 5): on by default, per device.
 *
 * - **On:** each turn's audio is kept on this device for 24 hours, and the browser is asked once
 *   to keep the site's storage (`persist()`, through WP3b's flag, so a browser already asked after
 *   a key was stored isn't asked again).
 * - **Off:** no turn's audio is kept from then on, and the clips already here are deleted, with
 *   their key: the safer of the two.
 * - **Can't:** where this browser can't keep audio (no IndexedDB, as in iOS Lockdown Mode), it
 *   says so and the switch stays off.
 */
export function ClipsSettings({ labelledBy }: { labelledBy: string }) {
  const [setting, save] = useClipsSetting();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [saved, setSaved] = useState("");
  const descriptionId = useId();

  useEffect(() => {
    let cancelled = false;
    browserEvidence()
      .store()
      .then(
        () => !cancelled && setAvailable(true),
        () => !cancelled && setAvailable(false),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const on = setting === "on" && available !== false;
  const change = async (checked: boolean) => {
    if (checked) {
      save("on");
      setSaved("Saved on this device: evidence clips on.");
      void requestPersistenceOnce();
      return;
    }
    save("off");
    setSaved("Saved on this device: evidence clips off.");
    await browserEvidence().clear();
    setSaved("Saved on this device: evidence clips off, and the clips here deleted.");
  };

  return (
    <div className="grid gap-4">
      <div className="flex items-start justify-between gap-4 rounded-lg border px-4 py-3">
        <div id={descriptionId} className="grid gap-1">
          <p className="max-w-prose text-pretty text-sm">{CLIPS_COPY.line}</p>
          <p className="max-w-prose text-pretty text-muted-foreground text-sm">
            {CLIPS_COPY.offDeletes}
          </p>
        </div>
        <Switch
          checked={on}
          disabled={available === false}
          onCheckedChange={(checked) => void change(checked)}
          aria-labelledby={labelledBy}
          aria-describedby={descriptionId}
          className="mt-0.5"
        />
      </div>
      {available === false ? (
        <p className="text-muted-foreground text-sm">{CLIPS_COPY.unavailable}</p>
      ) : null}
      <p aria-live="polite" className="text-muted-foreground text-sm">
        {saved}
      </p>
    </div>
  );
}
