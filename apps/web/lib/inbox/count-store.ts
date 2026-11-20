// The header's inbox count in the page (Phase 5 spec WP6 step 4). The server renders the count
// with each full render (lib/inbox/count.ts), but the header lives in the signed-in layout, which
// client navigation doesn't render again; so the inbox, which knows its own reviews as they land,
// publishes its count here, and the header shows it until the next server render's count arrives.
// A tiny external store for `useSyncExternalStore`: null until the inbox publishes.
import { useEffect, useRef, useSyncExternalStore } from "react";

let published: number | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = (): number | null => published;
const serverSnapshot = (): number | null => null;

/** The inbox's open cards, as the page holds them now. */
export function publishInboxCount(count: number): void {
  if (published === count) return;
  published = count;
  emit();
}

/** Forgets the page's count: a fresh server count supersedes it. */
export function clearInboxCount(): void {
  if (published === null) return;
  published = null;
  emit();
}

/**
 * The count to show: the inbox's own, once it published one, else the server's. `renderedAt`
 * changes with every server render of the header, and a later render (a refresh after a server
 * action) supersedes the page's count; the first one, as the header mounts, doesn't, since the
 * inbox may already have published over it.
 */
export function useInboxCount(server: number | null, renderedAt: string): number | null {
  const seen = useRef(renderedAt);
  useEffect(() => {
    if (seen.current === renderedAt) return;
    seen.current = renderedAt;
    clearInboxCount();
  }, [renderedAt]);
  const live = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return live ?? server;
}
