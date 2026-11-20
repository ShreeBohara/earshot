"use client";

import { Button } from "@earshot/ui/components/button";
import { AudioLinesIcon } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { CLIPS_COPY } from "@/lib/evidence/copy";
import { browserStorage, clipsNoticeDue, markClipsNoticeSeen } from "@/lib/evidence/setting";
import { CaptureLink } from "../capture/link";
import { useEvidenceHub } from "./evidence-provider";
import { useClipsSetting } from "./use-clips-setting";

const noSubscription = () => () => {};

/**
 * Whether the capture screen owes this device the clips notice, and a way to settle it: while clips
 * are on, this browser can keep audio, and the notice hasn't been dismissed, or a debrief started
 * with it on screen. Read after mount, so the server's HTML and the first render agree.
 */
export function useClipsNotice(): { readonly due: boolean; readonly seen: () => void } {
  const hub = useEvidenceHub();
  const [setting] = useClipsSetting();
  const [owed, setOwed] = useState(false);
  const unavailable = useSyncExternalStore(
    hub?.subscribe ?? noSubscription,
    () => hub?.unavailable ?? false,
    () => false,
  );
  useEffect(() => {
    setOwed(clipsNoticeDue(browserStorage()));
  }, []);
  const seen = useCallback(() => {
    markClipsNoticeSeen(browserStorage());
    setOwed(false);
  }, []);
  return { due: owed && setting === "on" && hub !== null && !unavailable, seen };
}

/**
 * The capture screen's one-time notice (Phase 5 spec WP9 step 5): evidence clips are on, what they
 * keep, for how long, that they're never uploaded, and where to turn them off. Shown once per
 * device, until it's dismissed or a debrief starts with it on screen.
 */
export function ClipsNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div data-slot="clips-notice" className="grid gap-3 rounded-lg border border-dashed p-4">
      <div className="flex gap-3">
        <AudioLinesIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div className="grid gap-1">
          <h3 className="font-medium text-sm">{CLIPS_COPY.notice.title}</h3>
          <p className="max-w-prose text-pretty text-muted-foreground text-sm">
            {CLIPS_COPY.line} You can turn them off in{" "}
            <CaptureLink
              href="/settings/capture"
              className="rounded-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:focus-ring"
            >
              Settings → Capture
            </CaptureLink>
            .
          </p>
        </div>
      </div>
      <div className="pl-7">
        <Button type="button" size="sm" variant="outline" onClick={onDismiss}>
          {CLIPS_COPY.notice.dismiss}
        </Button>
      </div>
    </div>
  );
}
