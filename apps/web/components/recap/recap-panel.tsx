"use client";

import type { RecapCreatedV1 } from "@earshot/core";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@earshot/ui/components/collapsible";
import { cn } from "@earshot/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import { type EvidenceSession, type PlayableSpan, spanState } from "@/lib/evidence/state";
import { RECAP_COPY } from "@/lib/recap/copy";
import { type RecapLine, type RecapView, recapView, type WordsOf } from "@/lib/recap/view";
import { useEvidenceHub } from "../evidence/evidence-provider";
import { PlayEvidenceButton } from "../evidence/play-evidence";
import { useClipsSetting } from "../evidence/use-clips-setting";

const noSubscription = () => () => {};

export interface RecapPanelProps {
  readonly recap: Pick<RecapCreatedV1, "outcome" | "reason" | "sentences" | "dropped" | "lens">;
  /** The words each piece of evidence points at: the inbox's loaded quotes, the session's log. */
  readonly wordsOf: WordsOf;
  /** Under an inbox debrief's heading (4), or under the capture screen's "Debrief ended" (3). */
  readonly headingLevel: 3 | 4;
  /**
   * The debrief, for evidence clips (Phase 5 WP9): a sentence's words get a play button where this
   * device holds their audio. Without it, or without clips, the words show without one.
   */
  readonly session?: EvidenceSession;
}

/** Each span a sentence's words can play on this device, by `${line}:${evidence}`. */
function usePlayable(
  session: EvidenceSession | undefined,
  view: RecapView,
): ReadonlyMap<string, PlayableSpan> {
  const hub = useEvidenceHub();
  const [setting] = useClipsSetting();
  const subscribe = hub?.subscribe ?? noSubscription;
  const sessionId = session?.sessionId ?? "";
  const index = useSyncExternalStore(
    subscribe,
    () => (hub && session ? hub.index(sessionId) : null),
    () => null,
  );
  const now = useSyncExternalStore(
    subscribe,
    () => hub?.now() ?? 0,
    () => 0,
  );
  const startedAt = session?.startedAt ?? "";
  const endedAt = session?.endedAt ?? null;
  const recordedHere = session?.recordedHere ?? false;
  useEffect(() => {
    if (!hub || !sessionId) return;
    return hub.watch({ sessionId, startedAt, endedAt, recordedHere });
  }, [hub, sessionId, startedAt, endedAt, recordedHere]);
  return useMemo(() => {
    const playable = new Map<string, PlayableSpan>();
    if (!hub || !index || !session || view.kind !== "created") return playable;
    const lines = [view.headline, ...view.nextSteps, ...view.commitments].filter(
      (item): item is RecapLine => item !== null,
    );
    for (const item of lines) {
      item.heard.forEach((heard, at) => {
        const state = spanState(
          { setting, index, session: { sessionId, startedAt, endedAt, recordedHere }, now },
          heard.evidence.audioMs,
        );
        if (state.kind !== "playable") return;
        playable.set(`${item.index}:${at}`, {
          key: `recap:${item.index}:${at}`,
          sessionId,
          audioMs: heard.evidence.audioMs,
          seconds: state.seconds,
        });
      });
    }
    return playable;
  }, [hub, index, session, view, setting, sessionId, startedAt, endedAt, recordedHere, now]);
}

/** One sentence: a button that opens the words it quotes, each with its play button where kept. */
function Sentence({
  line,
  playable,
  emphasis = false,
}: {
  line: RecapLine;
  playable: ReadonlyMap<string, PlayableSpan>;
  emphasis?: boolean;
}) {
  return (
    <Collapsible data-slot="recap-sentence">
      <CollapsibleTrigger
        className={cn(
          "w-full items-start py-0.5 text-sm hover:underline hover:underline-offset-4",
          emphasis && "font-medium text-base",
        )}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/collapsible:rotate-90 motion-reduce:transition-none"
        />
        <span>{line.text}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="ms-5.5 mt-1 mb-2 grid gap-1">
          <ul className="grid gap-1">
            {line.heard.map((heard, at) => {
              const play = playable.get(`${line.index}:${at}`);
              return (
                <li
                  key={`${heard.evidence.utteranceId}:${heard.evidence.span.join("-")}`}
                  className="font-mono text-muted-foreground text-xs"
                  data-slot="recap-heard"
                >
                  <span className="sr-only">{RECAP_COPY.heard} </span>“{heard.words}”
                  {play ? <PlayEvidenceButton span={play} /> : null}
                </li>
              );
            })}
          </ul>
          {line.weakSupport ? (
            <p className="text-muted-foreground text-xs" data-slot="recap-weak">
              {RECAP_COPY.weakSupport}
            </p>
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * The debrief's recap (Phase 5 spec §4.9, WP10; ADR-0037): the headline, the next steps, and the
 * commitments, each sentence a button that opens the rep's own words behind it (with a play button
 * where this device kept the audio); how many sentences were left out for quoting words that
 * aren't in the transcript; and the methodology lens, collapsed ("MEDDIC: 2 of 6 mentioned"). A
 * recap that failed or was skipped is one line saying why. Nothing here speaks on its own: no live
 * region, so the inbox's toaster and the capture screen's transcript stay the only ones.
 */
export function RecapPanel({ recap, wordsOf, headingLevel, session }: RecapPanelProps) {
  const headingId = useId();
  const view = useMemo(() => recapView(recap, wordsOf), [recap, wordsOf]);
  const playable = usePlayable(session, view);
  const Heading = headingLevel === 3 ? "h3" : "h4";
  const Sub = headingLevel === 3 ? "h4" : "h5";
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground"
      data-slot="recap"
    >
      <Heading id={headingId} className="font-medium text-sm">
        {RECAP_COPY.title}
      </Heading>
      {view.kind === "none" ? (
        <p className="text-muted-foreground text-sm" data-slot="recap-none">
          {view.line}
        </p>
      ) : (
        <>
          {view.headline ? <Sentence line={view.headline} playable={playable} emphasis /> : null}
          {view.nextSteps.length > 0 ? (
            <div className="grid gap-1">
              <Sub className="font-medium text-muted-foreground text-xs">
                {RECAP_COPY.nextSteps}
              </Sub>
              <ul className="grid gap-0.5">
                {view.nextSteps.map((line) => (
                  <li key={line.index}>
                    <Sentence line={line} playable={playable} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.commitments.length > 0 ? (
            <div className="grid gap-1">
              <Sub className="font-medium text-muted-foreground text-xs">
                {RECAP_COPY.commitments}
              </Sub>
              <ul className="grid gap-0.5">
                {view.commitments.map((line) => (
                  <li key={line.index}>
                    <Sentence line={line} playable={playable} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-muted-foreground text-xs">
            {RECAP_COPY.promise}
            {view.dropped ? ` ${view.dropped}` : ""}
          </p>
          {view.lens ? (
            <Collapsible data-slot="recap-lens">
              <CollapsibleTrigger className="font-medium text-sm">
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/collapsible:rotate-90 motion-reduce:transition-none"
                />
                {view.lens.summary}
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <dl className="ms-5.5 mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  {view.lens.fields.map((field) => (
                    <div key={field.id} className="contents" data-slot="recap-lens-field">
                      <dt className="font-medium">{field.label}</dt>
                      <dd
                        className={cn(field.words ? "font-mono text-xs" : "text-muted-foreground")}
                      >
                        {field.words ? (
                          <>
                            <span className="sr-only">{RECAP_COPY.heard} </span>“{field.words}”
                          </>
                        ) : (
                          RECAP_COPY.notMentioned
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </>
      )}
    </section>
  );
}
