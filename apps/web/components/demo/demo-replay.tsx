"use client";

import type { EventEnvelope } from "@earshot/core";
import { Button } from "@earshot/ui/components/button";
import { Kbd } from "@earshot/ui/components/kbd";
import { Orb } from "@earshot/ui/components/orb";
import { PauseIcon, PlayIcon, RotateCcwIcon, SkipForwardIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { CostMeter } from "@/components/capture/cost-meter";
import { SessionPanels } from "@/components/capture/session-panels";
import { clock } from "@/lib/demo";
import {
  buildReplayTimeline,
  DEMO_ENTITIES,
  REPLAY_SPEEDS,
  ReplayDriver,
  type ReplaySpeed,
  type ReplayView,
  replayActivity,
  TEST_SPEED,
} from "@/lib/demo-replay";

const noSubscription = () => () => {};

/** False in the static HTML and while hydrating, then true: the controls wait for it. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}

/** `/demo?speed=8` adds the speed tests use. Read in the browser, since the page is static. */
function useTestSpeed(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => new URLSearchParams(window.location.search).get("speed") === String(TEST_SPEED),
    () => false,
  );
}

function statusText(view: ReplayView, sessionEnded: boolean): string {
  switch (view.status) {
    case "ready":
      return "Ready to play";
    case "paused":
      return "Paused";
    case "ended":
      return "Replay finished";
    case "playing":
      return sessionEnded ? "Playing the review" : "Playing the debrief";
  }
}

function playLabel(view: ReplayView): string {
  if (view.status === "playing") return "Pause";
  return view.status === "ended" ? "Play again" : "Play";
}

/**
 * The recorded session, played over time (spec WP10) through the capture screen's own panels:
 * the transcript fills in as the rep spoke, proposals arrive when they did, then the review
 * marks each one. Play, pause, restart, speed, and skip to the end are buttons; with focus in the
 * controls, `K`, `Home`, `End`, and the speed's digit do the same. "Show the whole session" swaps
 * in the static summary (`wholeSession`, rendered on the server) for readers who'd rather read.
 */
export function DemoReplay({
  log,
  wholeSession,
}: {
  log: readonly EventEnvelope[];
  wholeSession: ReactNode;
}) {
  const [driver] = useState(() => new ReplayDriver(buildReplayTimeline(log)));
  const view = useSyncExternalStore(driver.subscribe, driver.getView, driver.getView);
  const { store } = view;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const hydrated = useHydrated();
  const testSpeed = useTestSpeed();
  const [whole, setWhole] = useState(false);

  useEffect(() => {
    if (testSpeed) driver.setSpeed(TEST_SPEED);
  }, [driver, testSpeed]);
  useEffect(() => () => driver.dispose(), [driver]);

  const activity = useMemo(() => replayActivity(state), [state]);
  const session = state.projections.session;
  const sessionEnded = session?.status === "ended";
  const speeds: readonly ReplaySpeed[] = testSpeed ? [...REPLAY_SPEEDS, TEST_SPEED] : REPLAY_SPEEDS;
  const progress = view.durationMs > 0 ? Math.min(1, view.positionMs / view.durationMs) : 0;
  const PlayPauseIcon = view.status === "playing" ? PauseIcon : PlayIcon;

  // Only while focus is in the controls, so the letter never fires elsewhere (WCAG 2.1.4).
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "k" || event.key === "K") driver.toggle();
    else if (event.key === "Home") driver.restart();
    else if (event.key === "End") driver.skipToEnd();
    else {
      const speed = speeds.find((candidate) => String(candidate) === event.key);
      if (speed === undefined) return;
      driver.setSpeed(speed);
    }
    event.preventDefault();
  };

  const showWhole = (on: boolean) => {
    if (on) driver.pause();
    setWhole(on);
  };

  return (
    <div className="flex flex-col gap-6">
      <label className="flex items-center gap-2 self-start text-sm">
        <input
          type="checkbox"
          checked={whole}
          disabled={!hydrated}
          onChange={(event) => showWhole(event.target.checked)}
          className="size-4 accent-foreground"
        />
        Show the whole session
      </label>

      {whole ? (
        wholeSession
      ) : (
        <>
          <section
            aria-label="Replay controls"
            onKeyDown={onKeyDown}
            className="flex flex-col items-center gap-6 rounded-xl border bg-card p-6 text-card-foreground sm:flex-row sm:items-center"
          >
            <Orb levels={driver.levels} size={128} label="Microphone level" />
            <div className="flex w-full min-w-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p role="status" className="font-medium" data-slot="replay-status">
                  {statusText(view, sessionEnded)}
                </p>
                {sessionEnded ? (
                  <CostMeter costUsd={session?.costUsd ?? state.meter.costUsd} final />
                ) : state.meter.records > 0 ? (
                  <CostMeter costUsd={state.meter.costUsd} final={false} />
                ) : null}
              </div>
              <div
                data-slot="replay-clock"
                className="flex items-center gap-3 font-mono text-muted-foreground text-xs tabular-nums"
              >
                <span>
                  <span className="sr-only">Replay position </span>
                  {clock(view.positionMs)}
                </span>
                <span
                  aria-hidden="true"
                  className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
                >
                  <span
                    className="block h-full rounded-full bg-state-proposed"
                    style={{ width: `${(progress * 100).toFixed(2)}%` }}
                  />
                </span>
                <span>
                  <span className="sr-only">of </span>
                  {clock(view.durationMs)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={!hydrated} aria-keyshortcuts="K" onClick={() => driver.toggle()}>
                  <PlayPauseIcon aria-hidden="true" data-icon="inline-start" />
                  {playLabel(view)} <Kbd>K</Kbd>
                </Button>
                <Button
                  variant="outline"
                  disabled={!hydrated}
                  aria-keyshortcuts="Home"
                  onClick={() => driver.restart()}
                >
                  <RotateCcwIcon aria-hidden="true" data-icon="inline-start" />
                  Restart <Kbd>Home</Kbd>
                </Button>
                <Button
                  variant="outline"
                  disabled={!hydrated}
                  aria-keyshortcuts="End"
                  onClick={() => driver.skipToEnd()}
                >
                  <SkipForwardIcon aria-hidden="true" data-icon="inline-start" />
                  Skip to the end <Kbd>End</Kbd>
                </Button>
                <fieldset className="flex items-center gap-1">
                  <legend className="sr-only">Speed</legend>
                  {speeds.map((speed) => (
                    <Button
                      key={speed}
                      variant="outline"
                      size="sm"
                      disabled={!hydrated}
                      aria-pressed={view.speed === speed}
                      aria-keyshortcuts={String(speed)}
                      onClick={() => driver.setSpeed(speed)}
                      className="aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:hover:bg-foreground/90 aria-pressed:hover:text-background"
                    >
                      {speed}×
                    </Button>
                  ))}
                </fieldset>
              </div>
            </div>
          </section>

          <SessionPanels
            state={state}
            entities={DEMO_ENTITIES}
            partial={view.partial}
            activity={activity}
            showReview
            transcriptEmptyText="Press Play, and the rep’s words appear here as they said them."
          />
        </>
      )}
    </div>
  );
}
