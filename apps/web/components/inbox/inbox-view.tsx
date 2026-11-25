"use client";

import { UNDO_WINDOW_MS } from "@earshot/core";
import { Button } from "@earshot/ui/components/button";
import { KeyboardIcon } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { InboxDemoInput, InboxDemoResult } from "@/app/actions/inbox-demo";
import { CAUGHT_UP_COPY, SECTION_TITLES } from "@/lib/inbox/copy";
import { type CorrectionSink, routeCorrectionSink } from "@/lib/inbox/corrections";
import { publishInboxCount } from "@/lib/inbox/count-store";
import { readPageOf, withFirstPage, withOlderPage } from "@/lib/inbox/pages";
import { type ReviewSink, routeSink } from "@/lib/inbox/sinks";
import type { InboxData } from "@/lib/inbox/types";
import { wordsFrom } from "@/lib/recap/view";
import { CaptureLink } from "../capture/link";
import { EvidenceCard } from "../evidence/evidence-card";
import { RecapPanel } from "../recap/recap-panel";
import { AcceptAllButton, BatchCheckpoint } from "./accept-all";
import { FollowupCard } from "./followup-card";
import {
  accountName,
  FinishingSection,
  ReviewedSection,
  SnoozedSection,
  When,
} from "./inbox-sections";
import { InboxShortcutsDialog } from "./shortcuts-dialog";
import { type DemoControls, useReviewList } from "./use-review-list";

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

/**
 * The demo controls' actions (WP12): the server actions, which the page passes in (so this module
 * never imports server code), or a story's.
 */
export interface DemoActions {
  readonly simulate: (input: InboxDemoInput) => Promise<InboxDemoResult>;
  readonly addMatching: (input: InboxDemoInput) => Promise<InboxDemoResult>;
}

export interface InboxViewProps {
  readonly initial: InboxData;
  /** Where reviews go: the web route, unless a story passes another. */
  readonly sink?: ReviewSink;
  /** Where corrections and follow-up skips go (WP13): the web route, unless a story passes another. */
  readonly corrections?: CorrectionSink;
  /** Reads the inbox again: `GET /api/inbox`, unless a story passes another. */
  readonly reload?: (before?: string) => Promise<InboxData | null>;
  /** The demo controls' actions (WP12); without them, no card offers a demo control. */
  readonly demoActions?: DemoActions;
}

/**
 * The review inbox (Phase 5 spec WP5, WP6; ADR-0035): the viewer's debriefs as groups of cards,
 * each an `<article>` in an `<ol>`, with roving focus, single-key shortcuts scoped to the list, one
 * polite message per action (an urgent one for a failure), the focus rules after a card leaves,
 * the review clock on every review, "accept all" with its checkpoint in each debrief's header,
 * and Reviewed, Snoozed, and Finishing beside the cards. The review engine is `useReviewList`,
 * which the capture screen's tray shares.
 */
export function InboxView({
  initial,
  sink,
  corrections,
  reload = fetchInbox,
  demoActions,
}: InboxViewProps) {
  const [data, setData] = useState(initial);
  const [routed] = useState(() => sink ?? routeSink());
  const [correctionSink] = useState(() => corrections ?? routeCorrectionSink());
  // A correction's card comes from the server (WP13): the page reads the inbox again once it lands.
  // Read from a ref, so the list's options stay one object.
  const readAgain = useRef<(sessionId: string) => Promise<void>>(async () => {});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const headingId = useId();
  // The demo controls (WP12) act on the server, then the page reads the inbox again, so a card
  // shows its three values or its offer. Read from a ref, so the list's options stay one object.
  const runDemo = useRef<(action: keyof DemoActions, input: InboxDemoInput) => void>(() => {});
  const [demo] = useState<Omit<DemoControls, "demoCrm">>(() => ({
    simulate: (sessionId, proposalId) => runDemo.current("simulate", { sessionId, proposalId }),
    addMatching: (sessionId, proposalId) =>
      runDemo.current("addMatching", { sessionId, proposalId }),
  }));
  const list = useReviewList({
    sessions: data.sessions,
    entities: data.entities,
    quotes: data.quotes,
    sink: routed,
    surface: "inbox",
    loadedAt: initial.loadedAt,
    ...(demoActions ? { demo: { ...demo, demoCrm: data.demoCrm === true } } : {}),
    corrections: correctionSink,
    onCorrected: (sessionId) => readAgain.current(sessionId),
  });
  const { sections, store, refreshNow, batch, shortcuts } = list;

  useEffect(() => {
    readAgain.current = async (sessionId) => {
      // The page holding the corrected card's debrief, which "Load older" may have brought in.
      const read = await readPageOf(data, sessionId, reload);
      if (!read) return;
      setData(read.apply);
      store.reconcile(read.fresh.sessions.flatMap((session) => session.proposals));
      refreshNow();
    };
  });

  useEffect(() => {
    runDemo.current = async (action, input) => {
      if (!demoActions) return;
      const result = await demoActions[action](input);
      if (result.status === "error") {
        list.warn(result.message);
        return;
      }
      list.say(result.message);
      if (result.status !== "done") return;
      // The page holding the card's debrief, which "Load older" may have brought in.
      const read = await readPageOf(data, input.sessionId, reload);
      if (!read) return;
      setData(read.apply);
      store.reconcile(read.fresh.sessions.flatMap((session) => session.proposals));
      refreshNow();
    };
  });

  // A finishing debrief: read the inbox again every 10 s while the page is visible, until it's
  // sealed and its cards arrive. Each read runs the repair path on the server.
  const finishing = sections.finishing.length > 0;
  useEffect(() => {
    if (!finishing) return;
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      const fresh = await reload();
      if (!fresh) return;
      setData((current) => withFirstPage(current, fresh));
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
    setData((current) => withOlderPage(current, page));
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

  // The words each recap sentence quotes, from the same texts the cards quote.
  const wordsOf = wordsFrom(data.quotes);

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
                {group.recap ? (
                  <RecapPanel
                    recap={group.recap}
                    wordsOf={wordsOf}
                    headingLevel={4}
                    {...(clipSessions.get(group.sessionId)
                      ? { session: clipSessions.get(group.sessionId) }
                      : {})}
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
                            <Fragment key={proposal.proposalId}>
                              <li>
                                <EvidenceCard
                                  {...card}
                                  session={session}
                                  headingLevel={group.byAccount ? 5 : 4}
                                />
                              </li>
                              {list.followups(proposal.proposalId).map((followup) => (
                                <li key={followup.id}>
                                  <FollowupCard binding={followup} />
                                </li>
                              ))}
                            </Fragment>
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
