"use client";

import "./capture.css";
import type { EntityRef, FieldValue } from "@earshot/core";
import type { ProposalView } from "@earshot/events";
import { Badge } from "@earshot/ui/components/badge";
import { StatePill } from "@earshot/ui/components/state-pill";
import { cn } from "@earshot/ui/lib/utils";
import { CheckIcon, PencilIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useDeferredValue, useId, useLayoutEffect, ViewTransition } from "react";
import { fieldLabel, PROPOSAL_TYPE_LABELS, RISK_LABELS } from "@/lib/capture/copy";
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

function targetName(proposal: ProposalView, entities: readonly EntityRef[]): string {
  if (proposal.targetEntityId === null) return "New";
  return entities.find((entity) => entity.id === proposal.targetEntityId)?.name ?? "A CRM record";
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
          <span className="text-muted-foreground">· {targetName(proposal, entities)}</span>
        </h3>
        {showReview ? <ReviewStatus status={proposal.status} /> : <StatePill state="proposed" />}
      </header>
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
                {RISK_LABELS[flag.kind] ?? flag.kind}
                {flag.field ? `: ${fieldLabel(flag.field).toLowerCase()}` : ""}
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
 * with reduced motion: capture.css), shows its type, its target (a record's name, or "New"),
 * its fields with the words they came from, and its risk badges, in the proposed state's blue.
 * Replays show review status instead.
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
