"use client";

import type { EntityRef } from "@earshot/core";
import { cn } from "@earshot/ui/lib/utils";
import { type ReactNode, useEffect, useId, useMemo, useRef } from "react";
import { findMentions, segmentText } from "@/lib/capture/mentions";

export interface TranscriptLine {
  readonly id: string;
  readonly text: string;
}

export interface LiveTranscriptProps {
  /** Final utterances, oldest first. */
  lines: readonly TranscriptLine[];
  /** The live partial: shown, never announced. */
  partial: string | null;
  /** The session's CRM records; exact names and aliases are underlined as mentions. */
  entities: readonly EntityRef[];
  /** Quoted character ranges per utterance: the hovered proposal's evidence. */
  highlights?: ReadonlyMap<string, readonly (readonly [number, number])[]> | null;
  emptyText?: string;
  className?: string;
}

const KIND_LABELS: Record<EntityRef["kind"], string> = {
  company: "company",
  contact: "contact",
  deal: "deal",
};

function Line({
  line,
  entities,
  highlights,
}: {
  line: TranscriptLine;
  entities: readonly EntityRef[];
  highlights: readonly (readonly [number, number])[];
}) {
  const segments = useMemo(
    () => segmentText(line.text, findMentions(line.text, entities), highlights),
    [line.text, entities, highlights],
  );
  return (
    <p data-utterance-id={line.id} className="text-pretty leading-relaxed">
      {segments.map((segment) => {
        let content: ReactNode = segment.text;
        if (segment.mention) {
          content = (
            <span
              data-mention={segment.mention.kind}
              title={`Mentions ${segment.mention.name}, a ${KIND_LABELS[segment.mention.kind]} in your CRM`}
              className="underline decoration-dashed decoration-1 decoration-muted-foreground underline-offset-4"
            >
              {content}
            </span>
          );
        }
        if (segment.highlight) {
          content = (
            <mark className="rounded-sm bg-state-proposed-bg text-state-proposed-text">
              {content}
            </mark>
          );
        }
        return <span key={segment.start}>{content}</span>;
      })}
    </p>
  );
}

const NO_HIGHLIGHTS: readonly (readonly [number, number])[] = [];

/**
 * The transcript as evidence: finished utterances in a polite live region, which announces each
 * new line once, and the live partial below it, hidden from assistive tech so nothing is read
 * twice. CRM names are underlined (dashed, so they don't read as links) and labelled as
 * mentions; hovering or focusing a proposal marks the words it quotes.
 */
export function LiveTranscript({
  lines,
  partial,
  entities,
  highlights = null,
  emptyText = "Hold to talk, and your words appear here.",
  className,
}: LiveTranscriptProps) {
  const headingId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const count = lines.length;

  // Follow new lines, unless the rep scrolled up to read.
  useEffect(() => {
    const element = scroller.current;
    if (!element || count === 0) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    if (nearBottom) element.scrollTop = element.scrollHeight;
  }, [count, partial]);

  return (
    <section aria-labelledby={headingId} className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className="font-medium text-sm">
          Transcript
        </h2>
        <p className="text-muted-foreground text-xs">
          <span
            aria-hidden="true"
            className="underline decoration-dashed decoration-muted-foreground underline-offset-4"
          >
            Name
          </span>{" "}
          <span className="sr-only">A dashed underline marks </span>a CRM record, mentioned by name
          (not a link)
        </p>
      </div>
      <div
        ref={scroller}
        // Focusable, so keyboard users can scroll back through a long debrief (WCAG 2.1.1).
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus
        tabIndex={0}
        className="flex max-h-[28rem] min-h-40 flex-col gap-3 overflow-y-auto rounded-xl border bg-card p-4 font-serif text-lg outline-none focus-visible:focus-ring"
      >
        <div
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-labelledby={headingId}
          className="flex flex-col gap-3"
        >
          {lines.map((line) => (
            <Line
              key={line.id}
              line={line}
              entities={entities}
              highlights={highlights?.get(line.id) ?? NO_HIGHLIGHTS}
            />
          ))}
        </div>
        {partial ? (
          <p aria-hidden="true" data-slot="partial" className="text-muted-foreground italic">
            {partial}
          </p>
        ) : null}
        {count === 0 && !partial ? (
          <p className="font-sans text-muted-foreground text-sm">{emptyText}</p>
        ) : null}
      </div>
    </section>
  );
}
