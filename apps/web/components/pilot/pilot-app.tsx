"use client";

import { Button } from "@earshot/ui/components/button";
import { Toaster } from "@earshot/ui/components/toast";
import { DownloadIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ConsentBlock } from "@/lib/pilot/consent";
import type { PilotData } from "@/lib/pilot/data";
import { participantOf } from "@/lib/pilot/participant";
import {
  LocalReviewLog,
  type PilotEvent,
  type PilotProgress,
  readProgress,
  writeProgress,
} from "@/lib/pilot/progress";
import { browserOf, resultsFile, resultsFileName, resultsText } from "@/lib/pilot/results";
import { ConsentText } from "./consent-text";
import { PilotReview } from "./pilot-review";

/** True when a key comes from a field that takes text. */
function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/**
 * The app's theme hotkey (d) flips light and dark, and remembers it in localStorage. On /pilot a
 * stray d would change the screen mid-session and leave a write behind, so the page stops it on
 * its way up to the window, where that hotkey listens. React's own handlers have run by then.
 */
function useNoThemeHotkey(): void {
  useEffect(() => {
    const stop = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "d" && !typing(event.target)) event.stopPropagation();
    };
    document.addEventListener("keydown", stop);
    return () => document.removeEventListener("keydown", stop);
  }, []);
}

function Practice({
  data,
  progress,
  onChange,
  onStart,
}: {
  data: PilotData;
  progress: PilotProgress;
  onChange: (events: readonly PilotEvent[]) => void;
  onStart: () => void;
}) {
  const [log] = useState(
    () =>
      new LocalReviewLog([data.practice.session], progress.practice, {
        participant: progress.participant,
        onChange,
      }),
  );
  const [sink] = useState(() => log.sink());
  const [session] = useState(() => log.sessions()[0]);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-serif text-4xl tracking-tight">Practice</h1>
        <p className="max-w-prose text-pretty text-muted-foreground">
          Three cards to try the buttons and keys on before the 40. They aren&apos;t counted.
        </p>
      </header>
      {session ? (
        <PilotReview
          groups={[{ session, label: "Practice", when: data.practice.when }]}
          entities={data.entities}
          quotes={data.quotes}
          sink={sink}
          onOpenCount={setOpen}
          caughtUpDetail="That's the practice. Start the 40 cards when you're ready."
        >
          {open === 0 ? (
            <div>
              <Button onClick={onStart}>Start the 40 cards</Button>
            </div>
          ) : null}
        </PilotReview>
      ) : null}
    </div>
  );
}

function Review({
  data,
  progress,
  order,
  onChange,
}: {
  data: PilotData;
  progress: PilotProgress;
  order: readonly string[];
  onChange: (events: readonly PilotEvent[]) => void;
}) {
  const ordered = order.flatMap((id) => data.sessions.filter((session) => session.id === id));
  const [log] = useState(
    () =>
      new LocalReviewLog(
        ordered.map((pilot) => pilot.session),
        progress.events,
        { participant: progress.participant, onChange },
      ),
  );
  const [groups] = useState(() => {
    const folded = new Map(log.sessions().map((session) => [session.sessionId, session]));
    return ordered.map((pilot, index) => ({
      session: folded.get(pilot.session.sessionId) ?? pilot.session,
      label: `Debrief ${index + 1} of ${ordered.length}`,
      when: pilot.when,
    }));
  });
  const [sink] = useState(() => log.sink());
  const [open, setOpen] = useState<number | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const resultsHeading = useId();
  const total = ordered.reduce((sum, pilot) => sum + pilot.session.proposals.length, 0);

  function download() {
    const finishedAt = new Date();
    const file = resultsFile({
      set: data.set,
      setSha256: data.setSha256,
      participant: progress.participant,
      order,
      startedAt: progress.startedAt,
      finishedAt: finishedAt.toISOString(),
      browser: browserOf(window.navigator),
      reviews: log.reviews(),
      practice: progress.practice.flatMap((event) =>
        event.type === "proposal.reviewed" ? [event.payload] : [],
      ),
    });
    const name = resultsFileName(progress.participant, finishedAt);
    // A blob in the page: the file goes to the participant's downloads, and nowhere else.
    const url = URL.createObjectURL(new Blob([resultsText(file)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setSaved(name);
  }

  const done = open === 0;
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-serif text-4xl tracking-tight">Review</h1>
        <p className="max-w-prose text-pretty text-muted-foreground">
          {total} proposed CRM changes from {ordered.length} sales debriefs. Review them as if they
          were your own.
        </p>
      </header>
      <PilotReview
        groups={groups}
        entities={data.entities}
        quotes={data.quotes}
        sink={sink}
        onOpenCount={setOpen}
        caughtUpDetail="That's every card. Download your results below."
      >
        <section aria-labelledby={resultsHeading} className="flex flex-col gap-3 border-t pt-8">
          <h2 id={resultsHeading} className="font-medium text-base">
            Results
          </h2>
          <p className="max-w-prose text-pretty text-muted-foreground text-sm">
            {done
              ? "Download your results and give the file to the person running your session. It holds your decisions, timings, and the cards as shown, and nothing about you."
              : `${open ?? total} ${open === 1 ? "card waits" : "cards wait"} for a decision. If you stop here, you can still download what you've done.`}
          </p>
          <div>
            <Button variant={done ? "default" : "outline"} onClick={download}>
              <DownloadIcon aria-hidden="true" data-icon="inline-start" />
              {done ? "Download results" : "Stop and download results"}
            </Button>
          </div>
          {saved ? (
            <p role="status" className="text-sm">
              Saved {saved}. Give it to the person running your session.
            </p>
          ) : null}
        </section>
      </PilotReview>
    </div>
  );
}

/**
 * The pilot page (spec WP7 step 2; ADR-0039): consent first, then 3 practice cards, then the 40
 * in the participant's order (`?p=1` to `?p=5`, or `?p=ci`), on the inbox's own card and keys,
 * and at the end a results file to download. Static: no account, no server, and nothing kept but
 * the participant's place in this tab's `sessionStorage`, written only after "I agree".
 */
export function PilotApp({ data, consent }: { data: PilotData; consent: readonly ConsentBlock[] }) {
  const [ready, setReady] = useState(false);
  const [participant, setParticipant] = useState<{ label: string; key: string } | null>(null);
  const [phase, setPhase] = useState<PilotProgress["phase"] | null>(null);
  const progress = useRef<PilotProgress | null>(null);
  useNoThemeHotkey();

  useEffect(() => {
    const found = participantOf(new URLSearchParams(window.location.search).get("p"));
    setParticipant(found);
    if (found) {
      const stored = readProgress(window.sessionStorage, found.label, data.setSha256);
      progress.current = stored;
      setPhase(stored?.phase ?? null);
    }
    setReady(true);
  }, [data.setSha256]);

  const keep = useCallback((next: PilotProgress) => {
    progress.current = next;
    writeProgress(window.sessionStorage, next);
  }, []);

  const agree = () => {
    if (!participant) return;
    keep({
      v: 1,
      setSha256: data.setSha256,
      participant: participant.label,
      startedAt: new Date().toISOString(),
      phase: "practice",
      practice: [],
      events: [],
    });
    setPhase("practice");
  };

  const onPractice = useCallback(
    (events: readonly PilotEvent[]) => {
      if (progress.current) keep({ ...progress.current, practice: [...events] });
    },
    [keep],
  );
  const onReview = useCallback(
    (events: readonly PilotEvent[]) => {
      if (progress.current) keep({ ...progress.current, events: [...events] });
    },
    [keep],
  );
  const start = () => {
    if (!progress.current) return;
    keep({ ...progress.current, phase: "review" });
    setPhase("review");
  };

  const order = participant ? data.orders[participant.key] : undefined;
  let body: ReactNode;
  if (ready && (!participant || !order)) {
    body = (
      <div className="flex flex-col gap-3">
        <h1 className="font-serif text-4xl tracking-tight">Review pilot</h1>
        <p className="max-w-prose text-pretty text-muted-foreground">
          This page needs a participant number. Open it as /pilot?p=1 through /pilot?p=5, one number
          per participant.
        </p>
      </div>
    );
  } else if (ready && phase === "practice" && progress.current) {
    body = (
      <Practice data={data} progress={progress.current} onChange={onPractice} onStart={start} />
    );
  } else if (ready && phase === "review" && progress.current && order) {
    body = <Review data={data} progress={progress.current} order={order} onChange={onReview} />;
  } else {
    body = (
      <div className="flex max-w-prose flex-col gap-8">
        <ConsentText blocks={consent} />
        <div className="flex flex-wrap items-center gap-3 border-t pt-6">
          <Button disabled={!ready} onClick={agree}>
            I agree
          </Button>
          <p className="text-muted-foreground text-sm">
            If you don&apos;t, close this tab: nothing has been kept.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh flex-col">
      <a
        href="#main"
        className="sr-only rounded-md bg-background px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus-visible:focus-ring"
      >
        Skip to content
      </a>
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-6">
          <p className="font-serif text-xl tracking-tight">Earshot</p>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          <p className="text-sm">Review pilot</p>
          {participant && phase ? (
            <p className="ms-auto font-mono text-muted-foreground text-xs">{participant.label}</p>
          ) : null}
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        {body}
      </main>
      <Toaster />
    </div>
  );
}
