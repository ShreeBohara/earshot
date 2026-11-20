"use client";

import Link from "next/link";
import { useInboxCount } from "@/lib/inbox/count-store";

/**
 * "Inbox" in the header, with its count (spec WP6 step 4): "Inbox 3", named "Inbox, 3 to review",
 * so the visible words are the start of the name (WCAG 2.5.3) and the number isn't read alone. The
 * server's count, from one query per render (lib/inbox/count.ts), or the inbox page's own once it
 * has one: the header isn't rendered again on client navigation.
 */
export function InboxNavLink({
  count,
  renderedAt,
}: {
  /** The server's count; null while it streams in, or when it can't be read. */
  count: number | null;
  /** When the server rendered it: a later render supersedes the page's own count. */
  renderedAt: string;
}) {
  const shown = useInboxCount(count, renderedAt);
  const waiting = shown !== null && shown > 0;
  return (
    <Link
      href="/inbox"
      // The name, spelled out: the visible "Inbox 3" starts it, and the number says what it counts.
      aria-label={waiting ? `Inbox, ${shown} to review` : undefined}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-muted-foreground text-sm outline-none hover:bg-muted hover:text-foreground focus-visible:focus-ring"
      data-slot="inbox-link"
    >
      Inbox
      {waiting ? (
        <span
          aria-hidden="true"
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 font-medium font-mono text-primary-foreground text-xs tabular-nums"
          data-slot="inbox-count"
        >
          {shown}
        </span>
      ) : null}
    </Link>
  );
}
