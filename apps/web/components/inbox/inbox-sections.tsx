"use client";

import { Button } from "@earshot/ui/components/button";
import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { reviewedRows } from "@/lib/inbox/batch";
import {
  BATCH_COPY,
  batchRowWords,
  cardWords,
  decisionWords,
  FINISHING_COPY,
  nameFinder,
  SECTION_TITLES,
} from "@/lib/inbox/copy";
import type { FinishingGroup, SessionItem } from "@/lib/inbox/groups";
import type { InputEventLike } from "@/lib/inbox/input";
import { capitalize, utcWords, whenWords } from "@/lib/inbox/time";
import type { InboxEntity } from "@/lib/inbox/types";

const noSubscription = () => () => {};

/** False while the server's HTML is hydrating, true after: the reviewer's time zone is known. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}

/**
 * A time in the reviewer's own zone ("today, 2:14 pm"), in a <time> element. The server can't know
 * the zone, so it renders the time in UTC, said so, and the page swaps it in as it hydrates.
 */
export function When({ iso, now }: { iso: string; now: number }) {
  const hydrated = useHydrated();
  const date = new Date(iso);
  return <time dateTime={iso}>{hydrated ? whenWords(date, new Date(now)) : utcWords(date)}</time>;
}

/** "Acme Dynamics", or "Debrief" for a debrief that names no account. */
export function accountName(
  entities: Readonly<Record<string, InboxEntity>>,
  accountId: string | null,
): string {
  return accountId ? (entities[accountId]?.name ?? "Debrief") : "Debrief";
}

/**
 * "Finishing" (spec WP5 step 10): debriefs that ended but aren't sealed yet, which the inbox can't
 * review until Postgres holds their whole log. The page polls them every 10 s.
 */
export function FinishingSection({
  groups,
  entities,
  now,
}: {
  groups: readonly FinishingGroup[];
  entities: Readonly<Record<string, InboxEntity>>;
  now: number;
}) {
  const headingId = useId();
  if (groups.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-medium text-base">
        {SECTION_TITLES.finishing}
      </h2>
      <ul className="flex flex-col gap-2">
        {groups.map((group) => (
          <li
            key={group.sessionId}
            className="flex items-start gap-3 rounded-xl border border-dashed p-4"
            data-slot="finishing"
          >
            <LoaderCircleIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground motion-safe:animate-spin"
            />
            <div className="grid gap-1">
              <h3 className="font-medium text-sm">
                {accountName(entities, group.accountId)} ·{" "}
                <When iso={group.endedAt ?? group.startedAt} now={now} />
              </h3>
              <p className="text-muted-foreground text-sm">
                {group.endedAt === null ? FINISHING_COPY.live : FINISHING_COPY.ended}
                {group.waiting > 0
                  ? `. ${group.waiting} ${group.waiting === 1 ? "proposal waits" : "proposals wait"} for it.`
                  : "."}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Re-renders when the earliest undo window among `items` closes, so Undo turns into Reopen. */
function useWindowClock(deadlines: readonly number[]): number {
  const [now, setNow] = useState(() => Date.now());
  const next = deadlines.filter((deadline) => deadline > now).sort((a, b) => a - b)[0];
  useEffect(() => {
    if (next === undefined) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [next]);
  return now;
}

/** When a decision's Undo turns into Reopen: its `syncEligibleAt`, or 30 s after a rejection. */
export function undoDeadline(item: SessionItem, undoWindowMs: number): number {
  const review = item.proposal.review;
  if (!review) return 0;
  return review.syncEligibleAt
    ? Date.parse(review.syncEligibleAt)
    : Date.parse(review.ts) + undoWindowMs;
}

/**
 * "Reviewed" (spec decision 7, WP5 step 7): every decision stays here with Undo until its sync
 * window closes (`syncEligibleAt`), then Reopen, which does the same: the card comes back and
 * takes focus. Undo never lives only in a toast. A batch's cards share one row, and its one Undo
 * reverses the batch (spec WP6).
 */
export function ReviewedSection({
  items,
  entities,
  undoWindowMs,
  onReopen,
  onUndoBatch,
  headingLevel = 2,
}: {
  items: readonly SessionItem[];
  entities: Readonly<Record<string, InboxEntity>>;
  undoWindowMs: number;
  onReopen: (proposalId: string, event: InputEventLike) => void;
  onUndoBatch: (batchId: string, event: InputEventLike) => void;
  /** 2 in the inbox, 3 in the capture screen's tray. */
  headingLevel?: 2 | 3;
}) {
  const now = useWindowClock(items.map((item) => undoDeadline(item, undoWindowMs)));
  const headingId = useId();
  if (items.length === 0) return null;
  const nameOf = nameFinder(entities);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <Heading
        id={headingId}
        className={headingLevel === 2 ? "font-medium text-base" : "font-medium text-sm"}
      >
        {SECTION_TITLES.reviewed}
      </Heading>
      <ul className="flex flex-col divide-y rounded-xl border">
        {reviewedRows(items).map((row) => {
          if (row.kind === "batch") {
            const [first] = row.items;
            const label = first && undoDeadline(first, undoWindowMs) > now ? "Undo" : "Reopen";
            const words = batchRowWords(
              row.items.map((item) =>
                cardWords(item.proposal, nameOf, item.proposal.review?.target),
              ),
            );
            const count = row.items.length;
            return (
              <li
                key={`batch:${row.batchId}`}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5"
                data-slot="reviewed"
                data-batch-id={row.batchId}
              >
                <p className="min-w-0 text-sm">
                  <span className="font-medium">{BATCH_COPY.decided}</span>
                  <span className="text-muted-foreground">: {words}</span>
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`${label}: ${BATCH_COPY.decided.toLowerCase()}, ${count} ${count === 1 ? "proposal" : "proposals"}`}
                  onClick={(event) => onUndoBatch(row.batchId, event)}
                >
                  {label}
                </Button>
              </li>
            );
          }
          const { item } = row;
          const { proposal } = item;
          const what = cardWords(proposal, nameOf, proposal.review?.target);
          const decision = decisionWords(proposal);
          const canReopen = proposal.review !== null;
          const label = undoDeadline(item, undoWindowMs) > now ? "Undo" : "Reopen";
          return (
            <li
              key={proposal.proposalId}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5"
              data-slot="reviewed"
              data-proposal-id={proposal.proposalId}
            >
              <p className="min-w-0 text-sm">
                <span className="font-medium">{decision}</span>
                <span className="text-muted-foreground">: {capitalize(what)}</span>
              </p>
              {canReopen ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`${label}: ${decision.toLowerCase()}, ${what}`}
                  onClick={(event) => onReopen(proposal.proposalId, event)}
                >
                  {label}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Snoozed": proposals set aside, each until its time, with a way to bring it back now. */
export function SnoozedSection({
  items,
  entities,
  now,
  onWake,
  headingLevel = 2,
}: {
  items: readonly SessionItem[];
  entities: Readonly<Record<string, InboxEntity>>;
  now: number;
  onWake: (proposalId: string, event: InputEventLike) => void;
  /** 2 in the inbox, 3 in the capture screen's tray. */
  headingLevel?: 2 | 3;
}) {
  const headingId = useId();
  if (items.length === 0) return null;
  const nameOf = nameFinder(entities);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <Heading
        id={headingId}
        className={headingLevel === 2 ? "font-medium text-base" : "font-medium text-sm"}
      >
        {SECTION_TITLES.snoozed}
      </Heading>
      <ul className="flex flex-col divide-y rounded-xl border">
        {items.map((item) => {
          const { proposal } = item;
          const what = cardWords(proposal, nameOf);
          return (
            <li
              key={proposal.proposalId}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5"
              data-slot="snoozed"
              data-proposal-id={proposal.proposalId}
            >
              <p className="min-w-0 text-sm">
                <span className="font-medium">{capitalize(what)}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · until <When iso={proposal.snoozedUntil ?? proposal.ts} now={now} />
                </span>
              </p>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Review now: ${what}`}
                onClick={(event) => onWake(proposal.proposalId, event)}
              >
                Review now
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
