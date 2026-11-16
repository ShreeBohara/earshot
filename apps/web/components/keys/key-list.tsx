"use client";

import { Button } from "@earshot/ui/components/button";
import { cn } from "@earshot/ui/lib/utils";
import { KeyRoundIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { describeProblem } from "@/lib/keys/reasons";
import { type KeyStatus, KeyStatusPill } from "./key-status";

/** A key as a list shows it: never the key itself, only what identifies it. */
export type KeyListItem = {
  /** Unique within the list, for example `openai:work`. */
  id: string;
  providerName: string;
  label: string;
  /** The key's last four characters. */
  last4: string;
  /** A line of dates, for example "Added Nov 15, 2026 · last passed a check 3 minutes ago". */
  meta: string;
  status: KeyStatus;
};

/**
 * Keys as rows: provider, label, last four characters, dates, and one status pill. Each row can
 * be checked again (when `onCheck` is given) and removed, with a confirmation step. Presentational:
 * the caller owns the keys and does the work.
 */
export function KeyList({
  items,
  label,
  empty,
  busyId,
  onCheck,
  onRemove,
}: {
  items: readonly KeyListItem[];
  /** The list's accessible name, for example "Keys on this device". */
  label: string;
  /** Shown instead of the list when there are no keys. */
  empty: ReactNode;
  /** A row whose work is in progress; its buttons are disabled. */
  busyId?: string | null;
  onCheck?: (item: KeyListItem) => void;
  onRemove: (item: KeyListItem) => Promise<void> | void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  // Bumped to move focus to the list, or to the empty note once the last key is gone.
  const [refocus, setRefocus] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Asking to remove swaps the row's button for a confirmation: move focus with it.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  // A removal takes the focused button away: keep focus in the list instead of dropping it to
  // the page.
  useEffect(() => {
    if (refocus) (listRef.current ?? emptyRef.current)?.focus();
  }, [refocus]);

  async function remove(item: KeyListItem) {
    setConfirming(null);
    setRefocus((n) => n + 1);
    await onRemove(item);
    // The row, or the whole list, is gone now; focus what replaced it.
    setRefocus((n) => n + 1);
  }

  if (items.length === 0) {
    return (
      <p
        ref={emptyRef}
        tabIndex={-1}
        className="rounded-lg border border-dashed px-4 py-3 text-muted-foreground text-sm outline-none focus-visible:focus-ring"
      >
        {empty}
      </p>
    );
  }

  return (
    <ul
      ref={listRef}
      aria-label={label}
      tabIndex={-1}
      className="flex flex-col divide-y rounded-lg border outline-none focus-visible:focus-ring"
    >
      {items.map((item) => {
        const busy = busyId === item.id;
        const name = `${item.providerName} key “${item.label}”`;
        const problem =
          item.status.kind === "problem"
            ? describeProblem(item.status.problem, {
                provider: item.providerName,
                ...(item.status.retryAfterSeconds === undefined
                  ? {}
                  : { retryAfterSeconds: item.status.retryAfterSeconds }),
              })
            : null;
        return (
          <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
            <KeyRoundIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {/* Wide enough that on a phone the pill and buttons wrap below, not the text. */}
            <div className="min-w-52 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium">{item.providerName}</span>
                <span className="min-w-0 truncate text-muted-foreground">{item.label}</span>
                <span className="font-mono text-muted-foreground text-xs">
                  <span className="sr-only">ending in </span>
                  <span aria-hidden="true">••••</span>
                  {item.last4}
                </span>
              </p>
              {/* Relative times ("3 minutes ago") can tick over between the server render and
                  hydration. */}
              <p suppressHydrationWarning className="text-muted-foreground text-xs">
                {item.meta}
              </p>
              {problem && (
                <p
                  className={cn(
                    "mt-2 w-fit rounded-md border px-2 py-1 text-xs",
                    problem.state === "failed"
                      ? "border-state-failed-border bg-state-failed-bg text-state-failed-text"
                      : "border-state-conflict-border bg-state-conflict-bg text-state-conflict-text",
                  )}
                >
                  {problem.message}
                </p>
              )}
            </div>
            <KeyStatusPill status={item.status} provider={item.providerName} />
            <div className="flex items-center gap-1">
              {confirming === item.id ? (
                <>
                  <Button
                    ref={confirmRef}
                    size="sm"
                    variant="destructive"
                    onClick={() => remove(item)}
                    aria-label={`Yes, remove the ${name}`}
                  >
                    Remove
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  {onCheck && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || item.status.kind === "checking"}
                      onClick={() => onCheck(item)}
                      aria-label={`Check again: ${name}`}
                    >
                      Check again
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirming(item.id)}
                    aria-label={`Remove the ${name}`}
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
