"use client";

import { Button } from "@earshot/ui/components/button";
import { Kbd } from "@earshot/ui/components/kbd";
import { Orb } from "@earshot/ui/components/orb";
import { captureErrorKind } from "@earshot/voice/machines";
import { FlaskConicalIcon, PauseIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { linkButton } from "@/components/link-button";
import type { WitnessView } from "@/lib/capture/controller";
import type { FakeVoice, FakeVoiceSetup } from "@/lib/capture/fake";
import { defaultSelection, type ProviderSelection, providerChoices } from "@/lib/capture/providers";
import { WITNESS_COPY, witnessPromptDue } from "@/lib/capture/witness";
import {
  CaptureNotice,
  FakeEdgeNotice,
  MicrophoneNotice,
  NoKeyNotice,
  OfflineNotice,
  ProviderNotice,
  StartProblemNotice,
  VoiceNotice,
} from "./capture-notice";
import { CostMeter } from "./cost-meter";
import { CaptureLink } from "./link";
import { ProviderPickers } from "./provider-pickers";
import { PushToTalkButton } from "./push-to-talk";
import { SessionPanels } from "./session-panels";
import {
  captureStatus,
  useCaptureController,
  useCaptureUi,
  useSessionState,
} from "./session-provider";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { useCaptureShortcuts } from "./use-capture-shortcuts";
import { useWitnessSetting } from "./use-witness-setting";
import { WitnessPrompt } from "./witness-prompt";

/** The rep's choice to hear confirmations, per device. Off unless they turn it on. */
const SPEAK_PREFERENCE = "earshot.capture.speak";

const RUNNING = new Set([
  "armed",
  "recording",
  "finalizing",
  "reconnecting",
  "provider_unavailable",
]);

/** The session's second witness in a line (Phase 4 WP9), and how many names it disagreed on. */
function WitnessStatus({ witness, conflicts }: { witness: WitnessView; conflicts: number }) {
  const text =
    witness.status === "on"
      ? witness.source === "fake"
        ? WITNESS_COPY.status.fake
        : WITNESS_COPY.status.on
      : WITNESS_COPY.status[witness.status];
  return (
    <p className="text-muted-foreground text-xs" data-slot="witness-status">
      {text}
      {witness.status === "on" && conflicts > 0 ? (
        <>
          {" "}
          · <span className="font-mono tabular-nums">{conflicts}</span>{" "}
          {conflicts === 1 ? "name heard two ways" : "names heard two ways"}
        </>
      ) : null}
      {witness.source === "groq" ? (
        <>
          {" "}
          ·{" "}
          <CaptureLink
            href="/settings/capture"
            className="rounded-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:focus-ring"
          >
            Change
          </CaptureLink>
        </>
      ) : null}
    </p>
  );
}

/**
 * The capture screen (spec WP9): pick providers from the keys on this device, start, and hold to
 * talk. Proposals arrive in the tray with the words they came from; the feed says what the agent
 * is doing; the cost runs as you go. `fake` is set only under `next dev` with `?voice=fake`.
 */
export function CaptureScreen({ fake: fakeSetup }: { fake: FakeVoiceSetup | null }) {
  const controller = useCaptureController();
  const ui = useCaptureUi();
  const live = useSessionState(ui.store);
  const state = ui.paused ? ui.frozen : live;
  const [helpOpen, setHelpOpen] = useState(false);
  const [picked, setPicked] = useState<ProviderSelection | null>(null);
  const [fakeVoice, setFakeVoice] = useState<FakeVoice | null>(null);
  const [witnessSetting, saveWitnessSetting] = useWitnessSetting();
  const mounts = useRef(0);

  // Leaving the screen: an ended debrief's client stops waiting for the seal (spec WP6 step 3).
  // React's development double mount unmounts and remounts in one go, so only an unmount with no
  // remount after it counts.
  useEffect(() => {
    mounts.current += 1;
    return () => {
      mounts.current -= 1;
      queueMicrotask(() => {
        if (mounts.current === 0) controller.leaveScreen();
      });
    };
  }, [controller]);

  useEffect(() => {
    void controller.loadKeys();
    if (window.localStorage.getItem(SPEAK_PREFERENCE) === "on") {
      controller.setSpokenConfirmations(true);
    }
  }, [controller]);

  // Development only: the fake adapter loads before the Start click, which must stay synchronous.
  // Production builds replace the condition with false and drop the import with it.
  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      if (fakeSetup?.status !== "ready") return;
      let cancelled = false;
      void import("@/lib/capture/dev/fake-voice").then(({ createFakeVoice }) => {
        if (!cancelled) setFakeVoice(createFakeVoice(fakeSetup.scenario));
      });
      return () => {
        cancelled = true;
      };
    }
  }, [fakeSetup]);

  const sessionOn = ui.phase === "live" || ui.phase === "ending";
  useCaptureShortcuts(controller, "screen", {
    enabled: sessionOn,
    onHelp: () => setHelpOpen(true),
  });

  const keys = ui.keys.status === "ready" ? ui.keys.keys : [];
  const choices = useMemo(() => providerChoices(keys), [keys]);
  // Turns the second witness disagreed on, from SessionDO's `turn.witnessed` events.
  const witnessConflicts = useMemo(
    () =>
      (state?.events ?? []).reduce(
        (sum, event) => (event.type === "turn.witnessed" ? sum + event.payload.conflicts : sum),
        0,
      ),
    [state],
  );
  const selection = picked ?? defaultSelection(choices);
  const fakeMode = fakeSetup !== null;
  const canStart =
    (ui.phase === "setup" || ui.phase === "ended") &&
    ui.online &&
    (fakeMode ? fakeVoice !== null : selection !== null);
  const running = ui.phase === "live" && RUNNING.has(ui.capture.state);
  const error = ui.capture.context.error;
  const errorKind = error ? captureErrorKind(error) : null;

  const start = () => controller.start({ selection: fakeMode ? null : selection, fake: fakeVoice });
  const holdMs = ui.fake?.holdMs ?? fakeVoice?.holdMs ?? 1_600;
  const nextLine = ui.fake
    ? ui.fake.nextLine
    : fakeSetup?.status === "ready"
      ? (fakeSetup.scenario.turns[0]?.text ?? null)
      : null;
  const setSpeak = (enabled: boolean) => {
    controller.setSpokenConfirmations(enabled);
    window.localStorage.setItem(SPEAK_PREFERENCE, enabled ? "on" : "off");
  };

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-wider">
            Capture
          </p>
          <h1 className="font-serif text-4xl tracking-tight">Debrief</h1>
        </div>
        {state ? <CostMeter costUsd={state.meter.costUsd} final={ui.phase === "ended"} /> : null}
      </header>

      {fakeMode && fakeSetup.status === "ready" ? (
        <CaptureNotice tone="info" icon={FlaskConicalIcon} title="Fake voice (development)">
          No keys and no provider calls: each press says the next line of the scripted demo session,
          and the edge Worker&apos;s cassettes answer. Hold for about {Math.ceil(holdMs / 100) / 10}{" "}
          s per line.
          {nextLine ? (
            <span className="mt-1 block font-serif" data-slot="fake-next-line">
              Next line: “{nextLine}”
            </span>
          ) : (
            <span className="mt-1 block">The script is done: end the debrief to see its cost.</span>
          )}
        </CaptureNotice>
      ) : null}

      {ui.phase === "setup" || ui.phase === "starting" ? (
        <section
          aria-labelledby="capture-setup"
          className="flex flex-col gap-6 rounded-xl border bg-card p-6 text-card-foreground"
        >
          <div className="flex flex-col gap-2">
            <h2 id="capture-setup" className="font-medium text-lg">
              Start a debrief
            </h2>
            <p className="max-w-prose text-pretty text-muted-foreground text-sm">
              Talk through the call while it&apos;s fresh. Earshot drafts CRM changes, each with the
              words it came from, and nothing reaches your CRM until you approve it.
            </p>
          </div>
          {ui.problem ? <StartProblemNotice problem={ui.problem} /> : null}
          {!ui.online && !ui.problem ? <OfflineNotice live={false} /> : null}
          {fakeSetup?.status === "unavailable" ? (
            <FakeEdgeNotice scenarioUrl={fakeSetup.scenarioUrl} />
          ) : null}
          {fakeMode ? null : ui.keys.status === "loading" ? (
            <p className="text-muted-foreground text-sm">Loading the keys on this device…</p>
          ) : ui.keys.status === "unavailable" ? (
            <StartProblemNotice problem={{ kind: "keys_unavailable" }} />
          ) : choices.stt.length === 0 || choices.llm.length === 0 ? (
            <NoKeyNotice
              missing={
                choices.stt.length === 0 && choices.llm.length === 0
                  ? "both"
                  : choices.stt.length === 0
                    ? "stt"
                    : "llm"
              }
            />
          ) : (
            <ProviderPickers
              choices={choices}
              value={selection}
              onChange={setPicked}
              disabled={ui.phase === "starting"}
            />
          )}
          {!fakeMode && witnessPromptDue(witnessSetting, keys) ? (
            <WitnessPrompt onAnswer={saveWitnessSetting} />
          ) : null}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <Button size="lg" onClick={start} disabled={!canStart}>
              {ui.phase === "starting" ? "Starting…" : "Start debrief"}
            </Button>
            {ui.speak.available ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={ui.speak.enabled}
                  onChange={(event) => setSpeak(event.target.checked)}
                  className="size-4 accent-foreground"
                />
                Read confirmations aloud once the microphone is off
              </label>
            ) : null}
          </div>
        </section>
      ) : (
        <>
          <section
            aria-label="Capture controls"
            className="flex flex-col items-center gap-6 rounded-xl border bg-card p-6 text-card-foreground sm:flex-row sm:items-center"
          >
            <Orb levels={controller.levels} size={128} label="Microphone level" />
            <PushToTalkButton
              pressed={ui.pressed}
              mode={ui.mode}
              disabled={!running}
              onPress={() => controller.press()}
              onRelease={(at) => controller.release(at)}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <p className="font-medium" data-slot="capture-status">
                {captureStatus(ui)}
              </p>
              {ui.witness ? (
                <WitnessStatus witness={ui.witness} conflicts={witnessConflicts} />
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={ui.mode === "hands_free"}
                  disabled={ui.phase !== "live"}
                  onClick={() => controller.toggleHandsFree()}
                >
                  Hands-free <Kbd>H</Kbd>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={ui.paused}
                  disabled={ui.phase !== "live"}
                  onClick={() => controller.togglePause()}
                >
                  {ui.paused ? "Resume live updates" : "Pause live updates"} <Kbd>P</Kbd>
                </Button>
                <Button variant="outline" size="sm" onClick={() => setHelpOpen(true)}>
                  Shortcuts <Kbd>?</Kbd>
                </Button>
                {ui.phase === "ended" ? null : (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={ui.phase !== "live"}
                    onClick={() => void controller.end()}
                  >
                    End debrief <Kbd>Esc</Kbd>
                  </Button>
                )}
              </div>
            </div>
          </section>

          {!ui.online && ui.phase === "live" ? <OfflineNotice live /> : null}
          {ui.suspended && ui.phase === "live" ? (
            <CaptureNotice
              tone="info"
              icon={PauseIcon}
              title="Capture is paused"
              action={
                <Button size="sm" onClick={() => controller.resumeCapture()}>
                  Resume capture
                </Button>
              }
            >
              The session is still open. On an iPhone, Earshot pauses when you leave this screen,
              because Safari stops the microphone.
            </CaptureNotice>
          ) : null}
          {error && errorKind === "microphone" ? (
            <MicrophoneNotice
              code={
                error as
                  | "permission_denied"
                  | "permission_stuck"
                  | "device_unavailable"
                  | "audio_unavailable"
              }
              onRetry={() => controller.resumeCapture()}
            />
          ) : null}
          {error && errorKind === "provider" ? (
            <ProviderNotice code={error} onRetry={() => controller.retryProvider()} />
          ) : null}
          {ui.capture.context.notice ? <VoiceNotice code={ui.capture.context.notice} /> : null}
          {ui.paused ? (
            <p className="text-muted-foreground text-sm">
              Live updates are paused; capture carries on. Press <Kbd>P</Kbd> to catch up.
            </p>
          ) : null}

          <SessionPanels
            state={state}
            entities={ui.entities}
            partial={ui.paused ? null : ui.partial}
            activity={ui.activity}
            reviews={ui.reviews}
            onPainted={(proposalId, at) => controller.cardPainted(proposalId, at)}
          />

          {ui.phase === "ended" ? (
            <section
              aria-labelledby="capture-ended"
              className="flex flex-col gap-4 rounded-xl border bg-card p-6"
            >
              <h2 id="capture-ended" className="font-medium text-lg">
                Debrief ended
              </h2>
              {state ? <CostMeter costUsd={state.meter.costUsd} final /> : null}
              <p className="max-w-prose text-pretty text-muted-foreground text-sm">
                {ui.sealed
                  ? "Earshot has saved this debrief, and the inbox has whatever you haven't reviewed. Nothing has been written to your CRM."
                  : "Review the proposals here while Earshot finishes saving the debrief; anything you leave waits in the inbox. Nothing has been written to your CRM."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => controller.reset()}>Start another debrief</Button>
                <CaptureLink href="/inbox" className={linkButton({ variant: "outline" })}>
                  Open the inbox
                </CaptureLink>
                <CaptureLink href="/home" className={linkButton({ variant: "ghost" })}>
                  Back to home
                </CaptureLink>
              </div>
            </section>
          ) : null}
        </>
      )}

      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
