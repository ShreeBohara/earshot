"use client";

import { UNDO_WINDOW_MS } from "@earshot/core";
import { Button } from "@earshot/ui/components/button";
import { KeyboardIcon } from "lucide-react";
import { Fragment, useEffect, useId, useState } from "react";
import { CAUGHT_UP_COPY, SECTION_TITLES } from "@/lib/inbox/copy";
import { publishInboxCount } from "@/lib/inbox/count-store";
import { type ReviewSink, routeSink } from "@/lib/inbox/sinks";
import type { InboxData } from "@/lib/inbox/types";
import { CaptureLink } from "../capture/link";
import { EvidenceCard } from "../evidence/evidence-card";
import { AcceptAllButton, BatchCheckpoint } from "./accept-all";
import {
  accountName,
  FinishingSection,
  ReviewedSection,
  SnoozedSection,
  When,
} from "./inbox-sections";
import { InboxShortcutsDialog } from "./shortcuts-dialog";
import { useReviewList } from "./use-review-list";

/** How often a finishing debrief is checked again (target). */
export const FINISHING_POLL_MS = 10_000;

/** `GET /api/inbox`: the first page again, or the page before `before`. Null on failure. */
export async function fetchInbox(before?: string): Promise<InboxData | null> {
  const query = before ? `?before=${encodeURIComponent(before)}` : "";
  try {
    const response = await fetch(`/api/inbox${query}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    return response.ok ? ((await response.json()) as InboxData) : null;
  } catch {
    return null;
  }
}

/** The first page read again, with any older pages this view loaded kept after it. */
function merged(current: InboxData, fresh: InboxData): InboxData {
  const ids = new Set(fresh.sessions.map((session) => session.sessionId));
  const older = current.sessions.filter(
    (session) =>
      !ids.has(session.sessionId) &&
      fresh.sessions.every((first) => first.startedAt >= session.startedAt),
  );
  return {
    sessions: [...fresh.sessions, ...older],
    entities: { ...current.entities, ...fresh.entities },
    quotes: { ...current.quotes, ...fresh.quotes },
    older: older.length > 0 ? current.older : fresh.older,
    loadedAt: fresh.loadedAt,
  };
}

export interface InboxViewProps {
  readonly initial: InboxData;
  /** Where reviews go: the web route, unless a story passes another. */
  readonly sink?: ReviewSink;
  /** Reads the inbox again: `GET /api/inbox`, unless a story passes another. */
  readonly reload?: (before?: string) => Promise<InboxData | null>;
}

/**
 * The review inbox (Phase 5 spec WP5, WP6; ADR-0035): the viewer's debriefs as groups of cards,
 * each an `<article>` in an `<ol>`, with roving focus, single-key shortcuts scoped to the list, one
 * polite message per action (an urgent one for a failure), the focus rules after a card leaves,
 * the review clock on every review, "accept all" with its checkpoint in each debrief's header,
 * and Reviewed, Snoozed, and Finishing beside the cards. The review engine is `useReviewList`,
 * which the capture screen's tray shares.
 */
export function InboxView({ initial, sink, reload = fetchInbox }: InboxViewProps) {
  const [data, setData] = useState(initial);
  const [routed] = useState(() => sink ?? routeSink());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const headingId = useId();
  const list = useReviewList({
    sessions: data.sessions,
    entities: data.entities,
    quotes: data.quotes,
    sink: routed,
    surface: "inbox",
    loadedAt: initial.loadedAt,
  });
  const { sections, store, refreshNow, batch, shortcuts } = list;

  // A finishing debrief: read the inbox again every 10 s while the page is visible, until it's
  // sealed and its cards arrive. Each read runs the repair path on the server.
  const finishing = sections.finishing.length > 0;
  useEffect(() => {
    if (!finishing) return;
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      const fresh = await reload();
      if (!fresh) return;
      setData((current) => merged(current, fresh));
      store.reconcile(fresh.sessions.flatMap((session) => session.proposals));
      refreshNow();
    }, FINISHING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [finishing, reload, store, refreshNow]);

  // The header's count follows the page's own reviews, once every debrief is loaded: then the
  // inbox's open cards are exactly what the count query counts.
  const everything = data.older === null;
  useEffect(() => {
    if (everything) publishInboxCount(sections.openCount);
  }, [everything, sections.openCount]);

  async function loadOlder() {
    if (!data.older || loadingOlder) return;
    setLoadingOlder(true);
    const page = await reload(data.older);
    setLoadingOlder(false);
    if (!page) return;
    setData((current) => {
      const ids = new Set(current.sessions.map((session) => session.sessionId));
      return {
        sessions: [...current.sessions, ...page.sessions.filter((s) => !ids.has(s.sessionId))],
        entities: { ...current.entities, ...page.entities },
        quotes: { ...current.quotes, ...page.quotes },
        older: page.older,
        loadedAt: current.loadedAt,
      };
    });
  }

  // Each debrief as its cards' clips need it: recorded on some device, maybe this one.
  const clipSessions = new Map(
    data.sessions.map((session) => [
      session.sessionId,
      {
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        recordedHere: false,
      },
    ]),
  );

  const empty = data.sessions.length === 0;
  const caughtUp = sections.review.length === 0;
  return (
    <div className="flex flex-col gap-10" data-inbox="" data-sending={list.sending}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="font-serif text-4xl tracking-tight">Inbox</h1>
          <p className="max-w-prose text-pretty text-muted-foreground">
            {sections.openCount === 0
              ? "Nothing waits for your review."
              : `${sections.openCount} ${sections.openCount === 1 ? "proposal waits" : "proposals wait"} for your review. Nothing reaches your CRM until you accept it.`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => list.setHelpOpen(true)}>
          <KeyboardIcon aria-hidden="true" data-icon="inline-start" />
          Keyboard shortcuts
        </Button>
      </header>

      <section aria-labelledby={headingId} className="flex flex-col gap-4">
        <h2 id={headingId} className="font-medium text-base">
          {SECTION_TITLES.review}
        </h2>
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
            return (
              <div key={group.sessionId} className="flex flex-col gap-3" data-slot="session-group">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <h3 id={groupHeadingId} className="font-medium text-sm">
                    {accountName(data.entities, group.accountId)}{" "}
                    <span className="text-muted-foreground">
                      · <When iso={group.startedAt} now={list.now} />
                    </span>
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
                            ? accountName(data.entities, account.accountId)
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
                          const session = clipSessions.get(group.sessionId);
                          if (!card || !session) return null;
                          return (
                            <li key={proposal.proposalId}>
                              <EvidenceCard
                                {...card}
                                session={session}
                                headingLevel={group.byAccount ? 5 : 4}
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
                ref={list.roving.registerCaughtUp}
                tabIndex={-1}
                className="rounded-sm font-medium text-base outline-none focus-visible:focus-ring"
                data-slot="caught-up"
              >
                {empty ? CAUGHT_UP_COPY.empty : CAUGHT_UP_COPY.done}
              </h3>
              <p className="text-pretty text-muted-foreground text-sm">
                {empty ? (
                  <>
                    Debrief a call, or load the sample debriefs in{" "}
                    <CaptureLink
                      href="/settings/data"
                      className="rounded-sm text-foreground underline underline-offset-4 outline-none focus-visible:focus-ring"
                    >
                      Settings → Data
                    </CaptureLink>
                    , and their proposals appear here.
                  </>
                ) : (
                  CAUGHT_UP_COPY.doneDetail
                )}
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <FinishingSection groups={sections.finishing} entities={data.entities} now={list.now} />
      <ReviewedSection
        items={sections.reviewed}
        entities={data.entities}
        undoWindowMs={UNDO_WINDOW_MS}
        onReopen={list.reopen}
        onUndoBatch={batch.undo}
      />
      <SnoozedSection
        items={sections.snoozed}
        entities={data.entities}
        now={list.now}
        onWake={list.wake}
      />

      {data.older ? (
        <div>
          <Button variant="outline" size="sm" disabled={loadingOlder} onClick={loadOlder}>
            {loadingOlder ? "Loading…" : "Load older debriefs"}
          </Button>
        </div>
      ) : null}

      <InboxShortcutsDialog
        open={list.helpOpen}
        onOpenChange={list.setHelpOpen}
        shortcuts={shortcuts}
      />
    </div>
  );
}
