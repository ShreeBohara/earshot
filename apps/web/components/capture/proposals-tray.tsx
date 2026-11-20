"use client";

import "./capture.css";
import type { EntityRef, FieldValue } from "@earshot/core";
import type { ProposalView } from "@earshot/events";
import { Badge } from "@earshot/ui/components/badge";
import { StatePill } from "@earshot/ui/components/state-pill";
import { cn } from "@earshot/ui/lib/utils";
import { CheckIcon, PencilIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useDeferredValue, useId, useLayoutEffect, ViewTransition } from "react";
import {
  askCandidates,
  CONFLICT_COPY,
  fieldLabel,
  PROPOSAL_TYPE_LABELS,
  riskLabel,
  targetHeading,
} from "@/lib/capture/copy";
import { afterNextPaint } from "@/lib/capture/feedback";

export interface ProposalsTrayProps {
  proposals: readonly ProposalView[];
  /** The session's CRM records, to name each proposal's target. */
  entities: readonly EntityRef[];
  /** Utterance texts by id, to quote each field's evidence. */
  quotes?: ReadonlyMap<string, string>;
  /** Replays show each proposal's review status; the live screen shows them all as proposed. */
  showReview?: boolean;
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

function ProposalCard({
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
  const risks = proposal.riskFlags;
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

/**
 * The proposals as they arrive: each card slides in over 200 ms with a View Transition (none
 * with reduced motion: capture.css), shows its type, the linker's decision on its record (the
 * record's name; "Ask: Acme Dynamics or Akme Dynamics?" with the candidates and their odds;
 * "New"; "No record"), the words that named it, a conflict pill where the second witness heard
 * them differently, its fields with the words they came from, and its risk badges, in the
 * proposed state's blue. Read-only: Phase 5 answers the questions. Replays show review status
 * instead.
 */
export function ProposalsTray({
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
                <ProposalCard
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
