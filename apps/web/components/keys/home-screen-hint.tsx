"use client";

import { SmartphoneIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { showsHomeScreenHint } from "@/lib/keys/device-storage";

/**
 * Settings → Keys on iOS Safari, outside a Home Screen app (Phase 5 spec WP3b): Safari's 7-day rule
 * can delete the keys kept on this device. A Home Screen app keeps its own storage, apart from
 * Safari's, so the keys have to be added again there.
 *
 * It's decided after mount, since the server can't tell; `show` fixes it, for stories.
 */
export function HomeScreenHint({ show }: { show?: boolean }) {
  const [visible, setVisible] = useState(show ?? false);

  useEffect(() => {
    if (show === undefined) setVisible(showsHomeScreenHint(navigator));
  }, [show]);

  if (!visible) return null;
  return (
    <p className="flex max-w-prose gap-2.5 rounded-lg border px-4 py-3 text-pretty text-sm">
      <SmartphoneIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>
        Safari can delete keys kept on this device if you don&apos;t open Earshot for a week. To
        keep them, add Earshot to your Home Screen, then add your keys there: the Home Screen app
        has its own storage.
      </span>
    </p>
  );
}
