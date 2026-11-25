"use client";

import "./capture.css";
import { type EntityRef, type FieldValue, UNDO_WINDOW_MS } from "@earshot/core";
import type { ProposalView } from "@earshot/events";
import { Badge } from "@earshot/ui/components/badge";
import { StatePill } from "@earshot/ui/components/state-pill";
import { cn } from "@earshot/ui/lib/utils";
import { tierOf } from "@earshot/understanding/tiers";
import { CheckIcon, PencilIcon, ReplaceIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import {
  type FocusEvent,
  Fragment,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  ViewTransition,
} from "react";
import {
  askCandidates,
  CONFLICT_COPY,
  fieldLabel,
  NAME_NOTES,
  PROPOSAL_TYPE_LABELS,
  riskLabel,
  targetHeading,
} from "@/lib/capture/copy";
import { afterNextPaint } from "@/lib/capture/feedback";
import { CAUGHT_UP_COPY } from "@/lib/inbox/copy";
import {
  type CorrectionWriter,
  type SpokenCorrections,
  socketCorrectionSink,
} from "@/lib/inbox/corrections";
import { type ReviewWriter, socketSink } from "@/lib/inbox/sinks";
import type { InboxEntity, InboxSession } from "@/lib/inbox/types";
import { EvidenceCard } from "../evidence/evidence-card";
import { FollowupCard } from "../inbox/followup-card";
import { ReviewedSection, SnoozedSection } from "../inbox/inbox-sections";
import { InboxShortcutsDialog } from "../inbox/shortcuts-dialog";
import { useReviewList } from "../inbox/use-review-list";
import { CaptureLink } from "./link";

/** The live session, for the tray's reviews (Phase 5 WP6). */
export interface TrayReview {
  /**
   * The session client: reviews go over the socket until SessionDO seals the session, then to the
   * web route under the same ids.
   */
  readonly writer: ReviewWriter;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Set once SessionDO's `session.sealed` arrives: the tray hands over to the inbox. */
  readonly sealedAt: string | null;
  /**
   * Where the cards' corrections and follow-up skips go (WP13): the session client too. Without
   * it, the panel keeps only the candidates and no question shows.
   */
  readonly corrections?: CorrectionWriter;
  /** The cards' microphone (WP13), while the session captures in push-to-talk. */
  readonly speech?: SpokenCorrections;
}

export interface ProposalsTrayProps {
  proposals: readonly ProposalView[];
  /** The session's CRM records, to name each proposal's target. */
  entities: readonly EntityRef[];
  /** Utterance texts by id, to quote each field's evidence. */
  quotes?: ReadonlyMap<string, string>;
  /** Replays show each proposal's review status; the live screen shows them all as proposed. */
  showReview?: boolean;
  /**
   * The live screen's session: then the cards are the inbox's, reviewed here over the socket.
   * Without it the tray only shows (a replay, a story).
   */
  review?: TrayReview;
  /** Hovering or focusing a card marks its quoted words in the transcript. */
  onHighlight?: (proposalId: string | null) => void;
  highlightedId?: string | null;
  /** A card's first paint, for the turn's latency marks. */
  onPainted?: (proposalId: string, at: number) => void;
  className?: string;
}

function show(value: FieldValue): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function ReviewStatus({ status }: { status: ProposalView["status"] }) {
  switch (status) {
    case "proposed":
      return <StatePill state="proposed" />;
    case "approved":
      return (
        <Badge variant="outline" className="h-6 gap-1.5 px-2.5">
          <CheckIcon aria-hidden="true" data-icon="inline-start" />
          Approved
        </Badge>
      );
    case "edited":
      return (
        <Badge variant="outline" className="h-6 gap-1.5 px-2.5">
          <PencilIcon aria-hidden="true" data-icon="inline-start" />
          Edited, then approved
        </Badge>
      );
    case "rejected":
      return (
        <Badge variant="outline" className="h-6 gap-1.5 px-2.5 text-muted-foreground">
          <XIcon aria-hidden="true" data-icon="inline-start" />
          Rejected
        </Badge>
      );
    case "superseded":
      return (
        <Badge variant="outline" className="h-6 gap-1.5 px-2.5 text-muted-foreground">
          <ReplaceIcon aria-hidden="true" data-icon="inline-start" />
          Replaced by a correction
        </Badge>
      );
  }
}

function nameIn(entities: readonly EntityRef[]): (entityId: string) => string {
  return (entityId) => entities.find((entity) => entity.id === entityId)?.name ?? "A CRM record";
}

/** A probability as a whole percentage, at least 1% when it isn't 0. */
function percent(p: number): string {
  return `${p > 0 && p < 0.01 ? 1 : Math.round(p * 100)}%`;
}

/**
 * Under the heading: the words that named the record, and for a question its candidates with
 * their probabilities. Read-only in Phase 4: choosing one is Phase 5's.
 */
function TargetDetails({
  proposal,
  entities,
}: {
  proposal: ProposalView;
  entities: readonly EntityRef[];
}) {
  const { target } = proposal;
  const candidates = target.decision === "ask" ? askCandidates(target) : [];
  if (target.mention === null && candidates.length === 0) return null;
  const nameOf = nameIn(entities);
  return (
    <div className="grid gap-1 text-xs" data-slot="target">
      {target.mention ? (
        <p className="font-mono text-muted-foreground">
          <span className="sr-only">Record named as: </span>“{target.mention.quote}”
        </p>
      ) : null}
      {candidates.length > 0 ? (
        <ul aria-label="Candidates" className="flex flex-wrap gap-1.5">
          {candidates.map((candidate) => (
            <li
              key={candidate.entityId ?? "new"}
              className="rounded-md border px-2 py-0.5 text-foreground"
            >
              {candidate.entityId === null ? "A new record" : nameOf(candidate.entityId)}{" "}
              <span className="font-mono text-muted-foreground tabular-nums">
                {percent(candidate.p)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Where the two witnesses disagreed (Phase 4 WP9): a conflict pill, the words the live transcript
 * has, and what the second witness heard over the same audio. Read-only; Phase 5 resolves it.
 */
function ConflictDetails({ conflicts }: { conflicts: ProposalView["conflicts"] }) {
  if (conflicts.length === 0) return null;
  return (
    <ul aria-label={CONFLICT_COPY.list} className="grid gap-1.5 text-xs" data-slot="conflicts">
      {conflicts.map((conflict) => (
        <li
          key={`${conflict.field}:${conflict.biased.evidence.utteranceId}:${conflict.biased.evidence.span[0]}`}
          className="flex flex-wrap items-center gap-x-2 gap-y-1"
        >
          <StatePill state="conflict">{CONFLICT_COPY.pill}</StatePill>
          <span className="text-muted-foreground">
            {CONFLICT_COPY.biased}:{" "}
            <span className="font-mono text-foreground">“{conflict.biased.text}”</span>
          </span>
          <span className="text-muted-foreground">
            {CONFLICT_COPY.unbiased}:{" "}
            <span className="font-mono text-foreground" data-slot="unbiased-reading">
              {conflict.unbiased ? `“${conflict.unbiased.text}”` : CONFLICT_COPY.unheard}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function ReadOnlyCard({
  proposal,
  entities,
  quotes,
  showReview,
  highlighted,
  onHighlight,
  onPainted,
}: {
  proposal: ProposalView;
  entities: readonly EntityRef[];
  quotes: ReadonlyMap<string, string> | undefined;
  showReview: boolean;
  highlighted: boolean;
  onHighlight: ((proposalId: string | null) => void) | undefined;
  onPainted: ((proposalId: string, at: number) => void) | undefined;
}) {
  const titleId = useId();
  const { proposalId } = proposal;

  // Once per card: its first paint is the turn's last latency mark.
  useLayoutEffect(() => {
    if (onPainted) afterNextPaint((at) => onPainted(proposalId, at));
  }, [proposalId]);

  const fields = Object.entries(proposal.fields);
  // An uncertain link is a note beside the record's name, not a badge (ADR-0031's option 2).
  const { nameNote } = tierOf(proposal);
  const risks = proposal.riskFlags.filter((flag) => flag.kind !== "link_uncertain");
  return (
    <article
      aria-labelledby={titleId}
      data-proposal-id={proposalId}
      data-highlighted={highlighted ? "" : undefined}
      // Focusable, so the keyboard can do what hovering does: mark the evidence.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: focus marks the card's quoted words
      tabIndex={0}
      onPointerEnter={() => onHighlight?.(proposalId)}
      onPointerLeave={() => onHighlight?.(null)}
      onFocus={() => onHighlight?.(proposalId)}
      onBlur={() => onHighlight?.(null)}
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-l-4 border-l-state-proposed bg-card p-4 text-card-foreground outline-none focus-visible:focus-ring",
        highlighted && "border-state-proposed-border",
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <h3 id={titleId} className="font-medium text-sm">
          {PROPOSAL_TYPE_LABELS[proposal.type]}{" "}
          <span className="text-muted-foreground">
            · {targetHeading(proposal.target, nameIn(entities))}
          </span>
          {nameNote ? (
            <span className="font-normal text-muted-foreground text-xs" data-slot="name-note">
              , {NAME_NOTES[nameNote]}
            </span>
          ) : null}
        </h3>
        {showReview ? <ReviewStatus status={proposal.status} /> : <StatePill state="proposed" />}
      </header>
      <TargetDetails proposal={proposal} entities={entities} />
      <ConflictDetails conflicts={proposal.conflicts} />
      {fields.length > 0 ? (
        <dl className="grid gap-2 text-sm">
          {fields.map(([name, field]) => {
            const quote = quotes
              ?.get(field.evidence.utteranceId)
              ?.slice(field.evidence.span[0], field.evidence.span[1]);
            // In a replay, a reviewer's edit replaces the value; the original stays, struck through.
            const edit = showReview ? proposal.review?.editDiff?.[name] : undefined;
            return (
              <div key={name} className="grid gap-0.5">
                <dt className="text-muted-foreground text-xs">{fieldLabel(name)}</dt>
                <dd className="text-pretty" data-edited={edit ? "" : undefined}>
                  {edit ? (
                    <>
                      {show(edit.after)}
                      <span className="block text-muted-foreground text-xs">
                        <span className="sr-only">Changed from: </span>
                        <del>{show(edit.before)}</del>
                      </span>
                    </>
                  ) : (
                    show(field.value)
                  )}
                  {quote ? (
                    <span className="block font-mono text-muted-foreground text-xs">
                      <span className="sr-only">Heard: </span>“{quote}”
                    </span>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      {risks.length > 0 ? (
        <ul aria-label="Check before approving" className="flex flex-wrap gap-1.5">
          {risks.map((flag) => (
            <li key={`${flag.kind}:${flag.field ?? ""}`}>
              <Badge variant="conflict" className="h-6 gap-1 px-2">
                <TriangleAlertIcon aria-hidden="true" data-icon="inline-start" />
                {riskLabel(flag)}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

/** Marks a card's first paint, the turn's last latency mark, once per card it renders beside. */
function PaintMark({
  proposalId,
  onPainted,
}: {
  proposalId: string;
  onPainted: ((proposalId: string, at: number) => void) | undefined;
}) {
  useLayoutEffect(() => {
    if (onPainted) afterNextPaint((at) => onPainted(proposalId, at));
  }, [proposalId]);
  return null;
}

/** The session's records as the inbox's card reads them: each with its account, no CRM values. */
function trayEntities(entities: readonly EntityRef[]): Record<string, InboxEntity> {
  const out: Record<string, InboxEntity> = {};
  for (const entity of entities) {
    out[entity.id] = {
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      accountId: entity.kind === "company" ? entity.id : (entity.parentId ?? null),
      values: {},
    };
  }
  return out;
}

/** The tray reviews its own debrief whether or not it's sealed: the socket, then the route. */
const ALWAYS = () => true;

/**
 * The live tray (Phase 5 WP6): the inbox's card in tray mode, through the review engine the inbox
 * uses, with the socket as its sink (`socketSink` on the session client). The same keys, focus
 * rules, messages, undo, Reviewed, and Snoozed as the inbox, scoped to this list (the capture
 * screen's own shortcuts ignore keys from it). After `end` it keeps working until the seal; then
 * it says the debrief is done, links to the inbox, and its reviews go to the web route.
 */
function LiveTray({
  proposals,
  entities,
  quotes,
  review,
  onHighlight,
  highlightedId,
  onPainted,
  className,
}: ProposalsTrayProps & { review: TrayReview }) {
  const headingId = useId();
  const [sink] = useState(() => socketSink(review.writer));
  const corrections = useMemo(
    () =>
      review.corrections ? socketCorrectionSink(review.corrections, review.speech) : undefined,
    [review.corrections, review.speech],
  );
  const [loadedAt] = useState(() => new Date().toISOString());
  // New cards render in a transition, which is what lets <ViewTransition> animate them.
  const shown = useDeferredValue(proposals);
  const records = useMemo(() => trayEntities(entities), [entities]);
  const words = useMemo(() => Object.fromEntries(quotes ?? []), [quotes]);
  const sessions = useMemo<InboxSession[]>(
    () => [
      {
        sessionId: review.writer.sessionId,
        startedAt: review.startedAt,
        endedAt: review.endedAt,
        sealedAt: review.sealedAt,
        focusEntityId: null,
        proposals: shown,
      },
    ],
    [review.writer.sessionId, review.startedAt, review.endedAt, review.sealedAt, shown],
  );
  const list = useReviewList({
    sessions,
    entities: records,
    quotes: words,
    sink,
    surface: "tray",
    reviewable: ALWAYS,
    loadedAt,
    ...(corrections ? { corrections } : {}),
  });
  const { store, sections, sending } = list;
  // The debrief this page is recording: its clips are kept here as each turn ends.
  const clipSession = useMemo(
    () => ({
      sessionId: review.writer.sessionId,
      startedAt: review.startedAt,
      endedAt: review.endedAt,
      recordedHere: true,
    }),
    [review.writer.sessionId, review.startedAt, review.endedAt],
  );

  // The session's own events catch up with the page's reviews: forget the page's state for them,
  // so a later event (a reopen after a flag) shows through. Against what the list renders (the
  // deferred proposals), so a card never drops out for the moment the two disagree.
  useEffect(() => {
    store.reconcile(shown);
  }, [store, shown, sending]);

  const open = sections.review.flatMap((group) =>
    group.accounts.flatMap((account) => account.proposals),
  );
  const highlight = (proposalId: string) => ({
    onPointerEnter: () => onHighlight?.(proposalId),
    onPointerLeave: () => onHighlight?.(null),
    onFocus: () => onHighlight?.(proposalId),
    onBlur: (event: FocusEvent<HTMLLIElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHighlight?.(null);
    },
  });

  return (
    <section aria-labelledby={headingId} className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={headingId} className="font-medium text-sm">
          Proposals
        </h2>
        <p className="text-muted-foreground text-xs">
          <span className="font-mono tabular-nums">{proposals.length}</span>{" "}
          {proposals.length === 1 ? "proposal" : "proposals"}
        </p>
      </div>
      {review.sealedAt !== null ? (
        <p
          className="rounded-xl border bg-muted/40 p-3 text-pretty text-sm"
          data-slot="handed-over"
        >
          This debrief is done. Review what&apos;s left in the{" "}
          <CaptureLink
            href="/inbox"
            className="rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:focus-ring"
          >
            inbox
          </CaptureLink>
          .
        </p>
      ) : review.endedAt !== null && proposals.length > 0 ? (
        <p className="text-pretty text-muted-foreground text-xs" data-slot="finishing">
          Keep reviewing here: Earshot saves this debrief about a minute after your last review, and
          the inbox has the rest after that.
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-muted-foreground text-sm">
          Proposed CRM changes appear here, each with the words it came from.
        </p>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: the list's single-key shortcuts, scoped to it (WCAG 2.1.4)
        <div className="flex flex-col gap-3" onKeyDown={list.onKeyDown} data-review-list="">
          {open.length > 0 ? (
            <ol aria-labelledby={headingId} className="flex flex-col gap-3">
              {open.map((proposal) => {
                const card = list.card(proposal.proposalId);
                if (!card) return null;
                return (
                  <Fragment key={proposal.proposalId}>
                    <ViewTransition enter="proposal-enter" default="none">
                      <li
                        {...highlight(proposal.proposalId)}
                        data-highlighted={highlightedId === proposal.proposalId ? "" : undefined}
                      >
                        <PaintMark proposalId={proposal.proposalId} onPainted={onPainted} />
                        <EvidenceCard {...card} session={clipSession} headingLevel={3} />
                      </li>
                    </ViewTransition>
                    {list.followups(proposal.proposalId).map((followup) => (
                      <li key={followup.id}>
                        <FollowupCard binding={followup} />
                      </li>
                    ))}
                  </Fragment>
                );
              })}
            </ol>
          ) : (
            <div className="flex flex-col gap-1 rounded-xl border border-dashed p-4 text-center">
              <h3
                ref={list.roving.registerCaughtUp}
                tabIndex={-1}
                className="rounded-sm font-medium text-sm outline-none focus-visible:focus-ring"
                data-slot="caught-up"
              >
                {CAUGHT_UP_COPY.done}
              </h3>
              <p className="text-pretty text-muted-foreground text-xs">
                Every proposal from this debrief has a decision.
              </p>
            </div>
          )}
        </div>
      )}
      <ReviewedSection
        items={sections.reviewed}
        entities={records}
        undoWindowMs={UNDO_WINDOW_MS}
        onReopen={list.reopen}
        onUndoBatch={list.batch.undo}
        headingLevel={3}
      />
      <SnoozedSection
        items={sections.snoozed}
        entities={records}
        now={list.now}
        onWake={list.wake}
        headingLevel={3}
      />
      <InboxShortcutsDialog
        open={list.helpOpen}
        onOpenChange={list.setHelpOpen}
        shortcuts={list.shortcuts}
      />
    </section>
  );
}

/**
 * The proposals as they arrive: each card slides in over 200 ms with a View Transition (none
 * with reduced motion: capture.css). On the live screen (`review`) the cards are the inbox's, and
 * the rep reviews them here (Phase 5 WP6). Without it the tray only shows: each card's type, the
 * linker's decision on its record (the record's name, with "matched by sound" or "matched in
 * context" beside a link that wasn't by the exact name; "Ask: Acme Dynamics or Akme Dynamics?"
 * with the candidates and their odds; "New"; "No record"), the words that named it, a conflict
 * pill where the second witness heard them differently, its fields with the words they came from,
 * and its risk badges, in the proposed state's blue. Replays show review status instead.
 */
export function ProposalsTray(props: ProposalsTrayProps) {
  if (props.review && !props.showReview) {
    return <LiveTray key={props.review.writer.sessionId} {...props} review={props.review} />;
  }
  return <ReadOnlyTray {...props} />;
}

function ReadOnlyTray({
  proposals,
  entities,
  quotes,
  showReview = false,
  onHighlight,
  highlightedId = null,
  onPainted,
  className,
}: ProposalsTrayProps) {
  const headingId = useId();
  // New cards render in a transition, which is what lets <ViewTransition> animate them.
  const shown = useDeferredValue(proposals);
  return (
    <section aria-labelledby={headingId} className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={headingId} className="font-medium text-sm">
          Proposals
        </h2>
        <p className="text-muted-foreground text-xs">
          <span className="font-mono tabular-nums">{proposals.length}</span>{" "}
          {proposals.length === 1 ? "proposal" : "proposals"}
        </p>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-muted-foreground text-sm">
          Proposed CRM changes appear here, each with the words it came from.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {shown.map((proposal) => (
            <ViewTransition key={proposal.proposalId} enter="proposal-enter" default="none">
              <li>
                <ReadOnlyCard
                  proposal={proposal}
                  entities={entities}
                  quotes={quotes}
                  showReview={showReview}
                  highlighted={highlightedId === proposal.proposalId}
                  onHighlight={onHighlight}
                  onPainted={onPainted}
                />
              </li>
            </ViewTransition>
          ))}
        </ol>
      )}
    </section>
  );
}
