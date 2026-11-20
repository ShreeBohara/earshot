// The fake-microphone eval (spec WP11 steps 4 and 5): each debrief's WAV plays through Chrome's
// fake microphone into the real capture screen, and push-to-talk follows the WAV's timing.json.
//
// - The WAVs and timing come from lab/scripts/render_debriefs.py: Kokoro's in CI (the eval-wavs
//   action), or `--stub` tones locally (EARSHOT_EVAL_WAVS=lab/.cache/wavs-stub; not an
//   evaluation, and CI refuses them).
// - Each run gets its own browser, since the fake microphone's file is fixed at launch.
// - The fake microphone starts the file when getUserMedia opens it, so the test finds the WAV's
//   clock there: an init script wraps getUserMedia, notes when it resolved, and hangs an
//   AnalyserNode on the captured track to measure its RMS and when speech first arrives.
// - The capture screen's fake mode plays the script's scenario from the e2e edge Worker, and the
//   fake speech-to-text adapter hears each press's line on the WAV's own timings.
// - Results come off the session socket: every event the Durable Object commits is sent to the
//   client, `turn.measured` (the latency) included.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { EntityRef, EventEnvelope } from "@earshot/core";
import {
  DEBRIEFS,
  type DebriefScript,
  DebriefTiming,
  datasetIdsFor,
  debrief,
  type EvalScriptResult,
  isStubRender,
  RenderManifest,
  turnProblems,
  turnsFromEvents,
  turnTranscript,
} from "@earshot/evals";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  type PlaywrightWorkerArgs,
} from "@playwright/test";
import {
  FAKE_STATS_GLOBAL,
  FAKE_TIMING_GLOBAL,
  type FakeTiming,
  type FakeVoiceStats,
} from "../../lib/capture/fake";
import { captureStatus } from "../capture/support";
import { signInAsNewUser } from "../support/sign-in";

const REPO = path.resolve(import.meta.dirname, "../../../..");

/** Where the renderer wrote manifest.json and the WAVs; relative paths are from the repo root. */
export const WAVS_DIR = path.resolve(REPO, process.env.EARSHOT_EVAL_WAVS ?? "lab/.cache/wavs");

/** Press this long before each turn's speech starts, and release this long after it ends. */
export const LEAD_MS = 250;
export const TAIL_MS = 200;
/** Never press again sooner than this after a release. */
const MIN_GAP_MS = 150;
/** An RMS this loud on the captured track counts as speech arriving. */
const ONSET_RMS = 0.01;

/** The scripts to run: `EARSHOT_EVAL_SCRIPTS=d001,d010`, or all 30. */
export function evalScripts(): DebriefScript[] {
  const only = process.env.EARSHOT_EVAL_SCRIPTS?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return only?.length ? only.map(debrief) : [...DEBRIEFS];
}

export interface Render {
  readonly manifest: RenderManifest;
  readonly stub: boolean;
}

let render: Render | undefined;

/** The renderer's manifest, read once; fails with what to do when there are no WAVs. */
export function loadRender(): Render {
  if (render) return render;
  const file = path.join(WAVS_DIR, "manifest.json");
  if (!existsSync(file)) {
    throw new Error(
      `No eval WAVs: ${file} doesn't exist. CI renders them with .github/actions/eval-wavs. ` +
        "Locally, render Kokoro's (uv sync --project lab --group tts, then uv run --project lab " +
        "--group tts python lab/scripts/render_debriefs.py), or stub tones to check the plumbing " +
        "(uv run --project lab python lab/scripts/render_debriefs.py --stub, then " +
        "EARSHOT_EVAL_WAVS=lab/.cache/wavs-stub; not an evaluation).",
    );
  }
  const manifest = RenderManifest.parse(JSON.parse(readFileSync(file, "utf8")));
  const stub = isStubRender(manifest);
  if (stub && process.env.CI) {
    throw new Error(
      `${file} is a --stub render (tones, not speech). CI's eval plays Kokoro's WAVs only.`,
    );
  }
  render = { manifest, stub };
  return render;
}

export interface Fixture {
  readonly script: DebriefScript;
  readonly wav: string;
  readonly timing: DebriefTiming;
  readonly stub: boolean;
}

/** A script's WAV and timing, checked against the script itself. */
export function fixture(scriptId: string): Fixture {
  const { manifest, stub } = loadRender();
  const script = debrief(scriptId);
  const entry = manifest.scripts[scriptId];
  if (!entry) throw new Error(`${WAVS_DIR}/manifest.json has no WAV for ${scriptId}`);
  const timing = DebriefTiming.parse(
    JSON.parse(readFileSync(path.join(WAVS_DIR, entry.timing), "utf8")),
  );
  const said = timing.turns.map((turn) => turnTranscript(turn));
  if (said.join("\n") !== script.turns.map(turnTranscript).join("\n")) {
    throw new Error(`${entry.timing} doesn't say ${scriptId}'s lines: render the WAVs again`);
  }
  return { script, wav: path.join(WAVS_DIR, entry.wav), timing, stub };
}

export interface EvalBrowser {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
}

/**
 * A browser whose fake microphone plays `fx`'s WAV once (`%noloop`; the renderer's silent tail
 * keeps the last buffer quiet), on a page in the script's time zone, with the probes installed.
 * EARSHOT_EVAL_CHANNEL=chromium picks Chromium's new headless mode over the headless shell.
 */
export async function launchWithWav(
  playwright: PlaywrightWorkerArgs["playwright"],
  baseURL: string | undefined,
  fx: Fixture,
): Promise<EvalBrowser> {
  const browser = await playwright.chromium.launch({
    ...(process.env.EARSHOT_EVAL_CHANNEL ? { channel: process.env.EARSHOT_EVAL_CHANNEL } : {}),
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${fx.wav}%noloop`,
      // The probe's AudioContext starts without a gesture of its own.
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const context = await browser.newContext({
    ...(baseURL ? { baseURL } : {}),
    permissions: ["microphone"],
    timezoneId: fx.script.timeZone,
    viewport: { width: 1280, height: 720 },
  });
  await context.addInitScript(installProbe, ONSET_RMS);
  const timing: FakeTiming = { turns: fx.timing.turns };
  await context.addInitScript(
    ({ name, value }) => {
      (globalThis as Record<string, unknown>)[name] = value;
    },
    { name: FAKE_TIMING_GLOBAL, value: timing },
  );
  return { browser, context, page: await context.newPage() };
}

/** What the probe saw: when getUserMedia resolved, the track's settings, and its loudness. */
export interface Probe {
  opens: { at: number; settings: MediaTrackSettings | null }[];
  peakRms: number;
  onsetAt: number | null;
  error: string | null;
}

declare global {
  interface Window {
    __earshotEvalProbe?: Probe;
  }
}

/** Runs in the page before its own scripts (an init script): it can't close over anything. */
function installProbe(onsetRms: number): void {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) return;
  const probe: Probe = { opens: [], peakRms: 0, onsetAt: null, error: null };
  window.__earshotEvalProbe = probe;
  const getUserMedia = devices.getUserMedia.bind(devices);
  devices.getUserMedia = async (constraints) => {
    const stream = await getUserMedia(constraints);
    const at = performance.now();
    const track = stream.getAudioTracks()[0];
    probe.opens.push({ at, settings: track?.getSettings() ?? null });
    if (!track) return stream;
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const timer = setInterval(() => {
        if (track.readyState === "ended") {
          clearInterval(timer);
          void context.close();
          return;
        }
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const rms = Math.sqrt(sum / samples.length);
        probe.peakRms = Math.max(probe.peakRms, rms);
        if (probe.onsetAt === null && rms >= onsetRms) probe.onsetAt = performance.now();
      }, 10);
    } catch (error) {
      probe.error = String(error);
    }
    return stream;
  };
}

export function readProbe(page: Page): Promise<Probe | null> {
  return page.evaluate(() => window.__earshotEvalProbe ?? null);
}

export function readFakeStats(page: Page): Promise<FakeVoiceStats | null> {
  return page.evaluate(
    (name) =>
      ((globalThis as Record<string, unknown>)[name] as (() => FakeVoiceStats) | undefined)?.() ??
      null,
    FAKE_STATS_GLOBAL,
  );
}

const SESSION_SOCKET = /^\/v1\/sessions\/[^/]+\/ws$/;

export interface SessionTap {
  /** Every event the session socket has delivered so far, once each. */
  events(): EventEnvelope[];
  /** The entities the client sent in `start`: database ids in live runs, dataset ids in CI. */
  entities(): EntityRef[];
}

/** Listens to the session socket (and any that replace it) for the events it delivers. */
export function tapSession(page: Page): SessionTap {
  const events = new Map<string, EventEnvelope>();
  let entities: EntityRef[] = [];
  page.on("websocket", (socket) => {
    if (!SESSION_SOCKET.test(new URL(socket.url()).pathname)) return;
    socket.on("framesent", ({ payload }) => {
      try {
        const message = JSON.parse(
          typeof payload === "string" ? payload : payload.toString("utf8"),
        );
        if (message?.t === "start" && Array.isArray(message.entities)) entities = message.entities;
      } catch {
        // Heartbeats and other non-JSON frames.
      }
    });
    socket.on("framereceived", ({ payload }) => {
      let message: { t?: unknown; event?: EventEnvelope } | null = null;
      try {
        message = JSON.parse(typeof payload === "string" ? payload : payload.toString("utf8"));
      } catch {
        return;
      }
      if (message?.t === "event" && message.event?.id) events.set(message.event.id, message.event);
    });
  });
  return { events: () => [...events.values()], entities: () => entities };
}

/** Signs up a new user and loads the demo CRM, whose records every script names. */
export async function signInWithDemoCrm(page: Page): Promise<void> {
  await signInAsNewUser(page);
  await page.getByRole("button", { name: "Load the demo CRM" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Loaded the demo CRM" })).toBeVisible({
    timeout: 30_000,
  });
}

/** Opens the capture screen in fake mode on the script's scenario, ready to start. */
export async function openFakeCapture(page: Page, fx: Fixture, llm: string): Promise<void> {
  await page.goto(`/capture?voice=fake&script=${fx.script.id}&llm=${llm}`);
  await expect(page.getByRole("heading", { level: 1, name: "Debrief" })).toBeVisible();
  await expect(page.getByText("Fake voice (development)")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start debrief" })).toBeEnabled({
    timeout: 30_000,
  });
  const stats = await readFakeStats(page);
  expect(stats?.timing, "the capture screen should hear each line on the WAV's timing").toBe("wav");
}

/** Starts the debrief and waits until it's ready to hear a press. */
export async function startDebrief(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Start debrief" }).click();
  await expect(captureStatus(page)).toHaveText("Ready: hold to talk", { timeout: 30_000 });
  // Space is push-to-talk anywhere but a text field or another control.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function sleepUntil(at: number): Promise<void> {
  const wait = at - performance.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

export interface Playback {
  /** When getUserMedia resolved, on the page's clock: the WAV's time zero. */
  readonly micAt: number;
  /** How late each press went down after its scheduled time. */
  readonly pressLateMs: readonly number[];
}

/**
 * Holds Space for the first `count` turns, on the WAV's clock: down `LEAD_MS` before each turn's
 * speech starts, up `TAIL_MS` after it ends. A press that comes late (the engine wasn't ready)
 * is held as long as an on-time one, so the fake adapter still hears every word.
 */
export async function playTurns(
  page: Page,
  timing: DebriefTiming,
  count = timing.turns.length,
): Promise<Playback> {
  const probe = await readProbe(page);
  const micAt = probe?.opens[0]?.at;
  if (micAt === undefined) throw new Error("the capture screen never opened the microphone");
  // The page's clock on Node's: one round trip, split down the middle.
  const before = performance.now();
  const pageNow = await page.evaluate(() => performance.now());
  const nodeNow = (before + performance.now()) / 2;
  const onNode = (pageMs: number) => nodeNow + (pageMs - pageNow);
  const pressLateMs: number[] = [];
  let releasedAt = Number.NEGATIVE_INFINITY;
  for (const turn of timing.turns.slice(0, count)) {
    const scheduled = onNode(micAt + turn.startMs - LEAD_MS);
    await sleepUntil(Math.max(scheduled, releasedAt + MIN_GAP_MS));
    await page.keyboard.down("Space");
    const pressedAt = performance.now();
    pressLateMs.push(Math.max(0, Math.round(pressedAt - scheduled)));
    const hold = LEAD_MS + (turn.endMs - turn.startMs) + TAIL_MS;
    await sleepUntil(Math.max(onNode(micAt + turn.endMs + TAIL_MS), pressedAt + hold));
    await page.keyboard.up("Space");
    releasedAt = performance.now();
  }
  return { micAt, pressLateMs };
}

/** Waits until `count` turns have completed and every turn with proposals has its latency. */
export async function waitForTurns(tap: SessionTap, count: number, timeoutMs = 30_000) {
  const done = () => {
    const turns = turnsFromEvents(tap.events());
    return (
      turns.length >= count &&
      turns.every((turn) => turn.outcome !== "proposals" || turn.latency !== null)
    );
  };
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  return turnsFromEvents(tap.events());
}

export interface RunFacts {
  readonly mode: EvalScriptResult["mode"];
  readonly stt: string;
  readonly llm: string;
  readonly retry: number;
  readonly playback: Playback | null;
  readonly probe: Probe | null;
  readonly events: readonly EventEnvelope[];
  /** What the client sent in `start`, to map live database ids to the scripts' dataset ids. */
  readonly entities: readonly EntityRef[];
  readonly problems: readonly string[];
}

/** The run's result: each turn checked against the script, with its latency. */
export function scriptResult(fx: Fixture, facts: RunFacts): EvalScriptResult {
  const turns = turnsFromEvents(facts.events);
  const settings = facts.probe?.opens[0]?.settings ?? null;
  const onsetAt = facts.probe?.onsetAt ?? null;
  const first = fx.timing.turns[0];
  const flag = (value: unknown) => (typeof value === "boolean" ? value : null);
  const problems = [...facts.problems];
  if (turns.length > fx.script.turns.length) {
    problems.push(`${turns.length} turns completed for ${fx.script.turns.length} presses`);
  }
  return {
    script: fx.script.id,
    mode: facts.mode,
    stt: facts.stt,
    llm: facts.llm,
    wavs: fx.stub ? "stub" : "kokoro",
    wav: fx.timing.hash,
    durationMs: fx.timing.durationMs,
    audioProcessing: settings
      ? {
          echoCancellation: flag(settings.echoCancellation),
          noiseSuppression: flag(settings.noiseSuppression),
          autoGainControl: flag(settings.autoGainControl),
        }
      : null,
    onsetMs:
      onsetAt !== null && facts.playback && first
        ? Math.round(onsetAt - facts.playback.micAt - first.startMs)
        : null,
    peakRms: facts.probe ? Math.round(facts.probe.peakRms * 10_000) / 10_000 : null,
    retry: facts.retry,
    turns: fx.script.turns.map((turn, index) => {
      const actual = turns[index];
      return {
        index,
        expected: turn.expect.length,
        outcome: actual?.outcome ?? null,
        proposals: actual?.proposals.length ?? 0,
        transcript: actual?.transcript ?? null,
        pressLateMs: facts.playback?.pressLateMs[index] ?? 0,
        latency: actual?.latency ?? null,
        problems: turnProblems(turn, actual, {
          exactTranscript: facts.mode === "ci",
          targetIds: datasetIdsFor(facts.entities),
        }),
      };
    }),
    problems,
  };
}

/** The attachment the eval reporter (reporter.ts) collects. */
export const RESULT_ATTACHMENT = "eval-result";
