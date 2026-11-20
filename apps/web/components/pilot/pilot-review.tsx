"use client";

import { UNDO_WINDOW_MS } from "@earshot/core";
import { Button } from "@earshot/ui/components/button";
import { KeyboardIcon } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { SECTION_TITLES } from "@/lib/inbox/copy";
import type { ReviewSink } from "@/lib/inbox/sinks";
import type { InboxEntity, InboxSession } from "@/lib/inbox/types";
import { AcceptAllButton, BatchCheckpoint } from "../inbox/accept-all";
import { accountName, ReviewedSection, SnoozedSection } from "../inbox/inbox-sections";
import { ProposalCard } from "../inbox/proposal-card";
import { InboxShortcutsDialog } from "../inbox/shortcuts-dialog";
import { useReviewList } from "../inbox/use-review-list";

/** Every pilot card says so (spec WP7 step 2): the debriefs were written, so there's nothing to play. */
export const NO_AUDIO = "No audio: the pilot's debriefs were written for it, not recorded.";

/** Every session in the set is sealed, so all of them can be reviewed. */
const EVERY_SESSION = () => true;

/** A debrief as the pilot lists it: its session, and the words its heading adds. */
export interface PilotGroup {
  readonly session: InboxSession;
  /** "Debrief 3 of 10". */
  readonly label: string;
  /** When the call was, in the rep's own time zone. */
  readonly when: string;
}

export interface PilotReviewProps {
  readonly groups: readonly PilotGroup[];
  readonly entities: Readonly<Record<string, InboxEntity>>;
  readonly quotes: Readonly<Record<string, string>>;
  readonly sink: ReviewSink;
  /** What "All caught up" says under it: the practice's end, or the 40 cards'. */
  readonly caughtUpDetail: ReactNode;
  /** Called as the number of open cards changes, so the page knows when the list is done. */
  readonly onOpenCount?: (open: number) => void;
  /** What comes right after the cards, before Reviewed: the next step, one Tab from the list. */
  readonly children?: ReactNode;
}

/**
 * The pilot's review list (spec WP7 step 2): the inbox's own engine (`useReviewList`, surface
 * "pilot") over the set's sessions in the participant's order, with the inbox's card, keys, focus
 * rules, messages, "accept all" checkpoint, Reviewed, and Snoozed. Reviews go to the page's local
 * sink. The first card takes focus as the list mounts, so the keys work without a click.
 */
export function PilotReview({
  groups,
  entities,
  quotes,
  sink,
  caughtUpDetail,
  onOpenCount,
  children,
}: PilotReviewProps) {
  const headingId = useId();
  const [loadedAt] = useState(() => new Date().toISOString());
  const [sessions] = useState(() => groups.map((group) => group.session));
  const labels = new Map(groups.map((group) => [group.session.sessionId, group]));
  const list = useReviewList({
    sessions,
    entities,
    quotes,
    sink,
    surface: "pilot",
    reviewable: EVERY_SESSION,
    loadedAt,
  });
  const { sections, batch, shortcuts, roving, order } = list;

  // The first card, or "All caught up" when nothing's open, takes focus once, as the list mounts.
  const focused = useRef(false);
  const first = order.flat()[0];
  useEffect(() => {
    if (focused.current) return;
    focused.current = true;
    roving.focus(first ? { kind: "card", id: first } : { kind: "caught-up" });
  }, [roving, first]);

  useEffect(() => {
    onOpenCount?.(sections.openCount);
  }, [onOpenCount, sections.openCount]);

  const caughtUp = sections.review.length === 0;
  return (
    <div className="flex flex-col gap-10" data-inbox="" data-sending={list.sending}>
      <section aria-labelledby={headingId} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={headingId} className="font-medium text-base">
            {SECTION_TITLES.review}
          </h2>
          <Button variant="outline" size="sm" onClick={() => list.setHelpOpen(true)}>
            <KeyboardIcon aria-hidden="true" data-icon="inline-start" />
            Keyboard shortcuts
          </Button>
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the list's single-key shortcuts, scoped to it (WCAG 2.1.4) */}
        <div
          className="flex flex-col gap-8"
          onKeyDown={list.onKeyDown}
          data-inbox-list=""
          data-review-list=""
        >
          {sections.review.map((group) => {
            const groupHeadingId = `${headingId}-group-${group.sessionId}`;
            const acceptAllId = `${groupHeadingId}-accept-all`;
            const checkpointId = `${groupHeadingId}-checkpoint`;
            const plan = batch.plans.get(group.sessionId);
            const open = batch.open === group.sessionId;
            const label = labels.get(group.sessionId);
            return (
              <div key={group.sessionId} className="flex flex-col gap-3" data-slot="session-group">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <h3 id={groupHeadingId} className="font-medium text-sm">
                    {label ? <span className="text-muted-foreground">{label.label}: </span> : null}
                    {accountName(entities, group.accountId)}
                    {label ? <span className="text-muted-foreground"> · {label.when}</span> : null}
                  </h3>
                  {plan ? (
                    <AcceptAllButton
                      plan={plan}
                      open={open}
                      id={acceptAllId}
                      checkpointId={checkpointId}
                      onToggle={() => batch.toggle(group.sessionId)}
                    />
                  ) : null}
                </div>
                {open && plan ? (
                  <BatchCheckpoint
                    plan={plan}
                    models={list.models}
                    id={checkpointId}
                    buttonId={acceptAllId}
                    onCancel={batch.cancel}
                    onConfirm={batch.confirm}
                  />
                ) : null}
                {group.accounts.map((account) => {
                  const accountHeadingId = `${groupHeadingId}-${account.accountId ?? "none"}`;
                  return (
                    <Fragment key={account.accountId ?? "none"}>
                      {group.byAccount ? (
                        <h4 id={accountHeadingId} className="text-muted-foreground text-xs">
                          {account.accountId
                            ? accountName(entities, account.accountId)
                            : "No account named"}
                        </h4>
                      ) : null}
                      <ol
                        aria-labelledby={
                          group.byAccount ? `${groupHeadingId} ${accountHeadingId}` : groupHeadingId
                        }
                        className="flex flex-col gap-3"
                      >
                        {account.proposals.map((proposal) => {
                          const card = list.card(proposal.proposalId);
                          if (!card) return null;
                          return (
                            <li key={proposal.proposalId}>
                              <ProposalCard
                                {...card}
                                headingLevel={group.byAccount ? 5 : 4}
                                audioNote={NO_AUDIO}
                              />
                            </li>
                          );
                        })}
                      </ol>
                    </Fragment>
                  );
                })}
              </div>
            );
          })}
          {caughtUp ? (
            <div className="flex flex-col gap-1 rounded-xl border border-dashed p-6 text-center">
              <h3
                ref={roving.registerCaughtUp}
                tabIndex={-1}
                className="rounded-sm font-medium text-base outline-none focus-visible:focus-ring"
                data-slot="caught-up"
              >
                All caught up
              </h3>
              <p className="text-pretty text-muted-foreground text-sm">{caughtUpDetail}</p>
            </div>
          ) : null}
        </div>
      </section>

      {children}

      <ReviewedSection
        items={sections.reviewed}
        entities={entities}
        undoWindowMs={UNDO_WINDOW_MS}
        onReopen={list.reopen}
        onUndoBatch={batch.undo}
      />
      <SnoozedSection
        items={sections.snoozed}
        entities={entities}
        now={list.now}
        onWake={list.wake}
      />

      <InboxShortcutsDialog
        open={list.helpOpen}
        onOpenChange={list.setHelpOpen}
        shortcuts={shortcuts}
        settingsLink={false}
      />
    </div>
  );
}
