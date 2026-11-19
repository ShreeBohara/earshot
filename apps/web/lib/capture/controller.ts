// The capture screen's controller (spec WP9): it runs one debrief at a time and outlives the
// /capture page, so the docked mini-session keeps going while the rep browses. Framework-free:
// React reads it through `subscribe` and `getState` (useSyncExternalStore), and tests drive it
// with WP8's fakes.
//
// One debrief, in order (spec WP9 "Wiring"):
// 1. The Start click makes the AudioContext (it must happen inside the gesture), asks for the
//    microphone, and `POST /api/sessions` at once.
// 2. `createSessionClient` with the route's ticket, then `sendStart` with the providers, the
//    start time, the route's entities, and the rep's time zone.
// 3. A Debrief engine whose `getCredential` mints through `/api/voice/token` with the device's
//    speech-to-text key, and `connectEngine` with the device's LLM key, so finals go out as
//    `utterance` and each turn end as `turn_end`.
// 4. The session's events fold into a `SessionStore` (the screen subscribes), and every turn's
//    latency marks (release, last final, first proposal, its paint) go out with `sendMetric`.
//
// Keys: the speech-to-text key is decrypted for each mint and dropped; the LLM key is decrypted
// once at the start (connectEngine reads it synchronously at each turn end), held in memory for
// this session only, and dropped when it ends. Neither reaches the store, a log, or storage.
import type { EntityRef, LlmProvider, SessionProviders } from "@earshot/core";
import type { ProviderId, StoredKeyMeta } from "@earshot/keys";
import {
  type CaptureMode,
  type DebriefEngineOptions,
  type EngineState,
  isVoiceError,
  type Microphone,
  type SttAdapter,
  type TempCredential,
  type VoiceEngine,
  VoiceError,
  type VoiceEvent,
} from "@earshot/voice";
import {
  type Capture,
  type CaptureEvent,
  type ConnectionState,
  captureTransition,
  initialCapture,
  initialSilentResponse,
  isAudioOutputSafe,
  type SilentResponse,
  type SilentResponseEvent,
  silentResponseTransition,
} from "@earshot/voice/machines";
import {
  connectEngine,
  createTicketFetcher,
  type SessionClient,
  type SessionClientOptions,
  type SessionState,
  SessionStore,
} from "@earshot/voice/session";
import type { CreateSessionResponse, VoiceRouteError } from "../voice/types";
import type { ActivityKind, ActivityRow } from "./activity";
import { createSession, mintCredential } from "./api";
import type { SpokenConfirmations } from "./audio-out";
import { turnOutcomeText, VOICE_ERROR_COPY } from "./copy";
import type { FakeVoice } from "./fake";
import type { DeviceKeySource } from "./keys";
import { LevelMeter } from "./levels";
import { TurnMarksRecorder } from "./marks";
import { type ProviderSelection, providerChoices, type SttOption } from "./providers";

export type CapturePhase = "setup" | "starting" | "live" | "ending" | "ended";

export type KeysView =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly keys: readonly StoredKeyMeta[] };

/** Why a debrief couldn't start. */
export type StartProblem =
  /** The device lacks a key for the speech-to-text provider or the LLM picked (or any). */
  | { readonly kind: "missing_key" }
  /** This browser can't store keys (no IndexedDB, as in some private windows). */
  | { readonly kind: "keys_unavailable" }
  | { readonly kind: "offline" }
  /** `POST /api/sessions` refused, or couldn't be reached. */
  | {
      readonly kind: "session";
      readonly error: VoiceRouteError | "network";
      readonly retryAfterSeconds?: number;
    };

export interface CaptureUiState {
  readonly phase: CapturePhase;
  readonly keys: KeysView;
  readonly problem: StartProblem | null;
  /** WP8's capture machine: idle, asking for the mic, armed, recording, finalizing, errors. */
  readonly capture: Capture;
  readonly mode: CaptureMode;
  readonly pressed: boolean;
  /** The live partial transcript: on screen only, never sent anywhere. */
  readonly partial: string | null;
  /** Live updates paused (`P`): the screen shows `frozen` until they resume. */
  readonly paused: boolean;
  readonly frozen: SessionState | null;
  /** Capture stopped without ending the session: a pause, a hidden iOS page, or navigation. */
  readonly suspended: boolean;
  readonly online: boolean;
  readonly speak: { readonly available: boolean; readonly enabled: boolean };
  /** The screen's own feed rows: voice errors, connection changes, waits. */
  readonly activity: readonly ActivityRow[];
  readonly store: SessionStore | null;
  readonly sessionId: string | null;
  readonly entities: readonly EntityRef[];
  readonly providers: SessionProviders | null;
  /** Turns sent so far (each `turn_end`). */
  readonly turnsSent: number;
  /** Development fake mode: how long to hold, and the line the next press says. */
  readonly fake: { readonly holdMs: number; readonly nextLine: string | null } | null;
}

/** Everything the controller touches outside itself, so tests can swap any of it. */
export interface CaptureDeps {
  readonly fetch: typeof fetch;
  readonly keys: DeviceKeySource;
  readonly openMicrophone: () => Promise<Microphone>;
  /** Called inside the click or key press that starts capture, so the context may start. */
  readonly createAudioContext: () => AudioContext | undefined;
  readonly createEngine: (options: DebriefEngineOptions) => VoiceEngine;
  readonly createClient: (options: SessionClientOptions) => SessionClient;
  readonly createAdapter: (option: SttOption) => SttAdapter;
  /** The page's monotonic clock (`performance.now()`), for marks and feed rows. */
  readonly clock: () => number;
  readonly now: () => Date;
  readonly timeZone: () => string;
  readonly online: () => boolean;
  readonly ios: boolean;
  readonly speech: SpokenConfirmations;
  readonly chime: () => void;
  readonly timers?: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  /** Extra SessionClient options; tests pass WP8's fake socket and clock. */
  readonly clientOptions?: Partial<SessionClientOptions>;
  /** Extra engine options; tests pass a scripted capture source and clock. */
  readonly engineOptions?: Partial<DebriefEngineOptions>;
}

export interface StartInput {
  /** The device keys picked, or null in fake mode. */
  readonly selection: ProviderSelection | null;
  /** Development only: run on the fake adapter and the e2e Worker's cassettes. */
  readonly fake?: FakeVoice | null;
}

/** How one session runs: its providers, its adapter, its credentials, and its `start`. */
interface SessionPlan {
  readonly providers: SessionProviders;
  readonly llm: { readonly provider: LlmProvider; readonly model: string };
  readonly turnKey: string;
  readonly createAdapter: (fromTurn: number) => SttAdapter;
  readonly getCredential: (sessionId: string) => (signal: AbortSignal) => Promise<TempCredential>;
  readonly keyterms: (created: CreateSessionResponse) => readonly string[];
  readonly start: (created: CreateSessionResponse) => {
    readonly entities: readonly EntityRef[];
    readonly startedAt: string;
    readonly timeZone: string;
  };
  readonly fake: FakeVoice | null;
}

interface LiveSession {
  readonly sessionId: string;
  readonly store: SessionStore;
  readonly client: SessionClient;
  readonly plan: SessionPlan;
  readonly keyterms: readonly string[];
  readonly marks: TurnMarksRecorder;
  unsubscribe: () => void;
  /** This session's LLM key, until it ends. */
  turnKey: string | undefined;
  /** Events already looked at. */
  seen: number;
  connection: ConnectionState;
  everOpen: boolean;
  silent: SilentResponse;
  silentTimer: unknown;
  stopTimer: unknown;
}

/** After `end` is acknowledged, late events (the last turn's LLM usage) still arrive this long. */
const LATE_EVENTS_MS = 5_000;
/** How long an ended session keeps trying to deliver what's still unacknowledged. */
const MAX_DELIVERY_WAIT_MS = 60_000;
const END_ACK_TIMEOUT_MS = 6_000;
const MAX_LOCAL_ROWS = 100;

const CAPTURE_RUNNING: ReadonlySet<Capture["state"]> = new Set([
  "armed",
  "recording",
  "finalizing",
  "reconnecting",
  "provider_unavailable",
]);

function sameCapture(a: Capture, b: Capture): boolean {
  return (
    a.state === b.state &&
    a.context.error === b.context.error &&
    a.context.notice === b.context.notice
  );
}

export class CaptureController {
  readonly levels = new LevelMeter();
  readonly #deps: CaptureDeps;
  readonly #listeners = new Set<() => void>();
  readonly #timers: NonNullable<CaptureDeps["timers"]>;
  #state: CaptureUiState;
  #generation = 0;
  #live: LiveSession | null = null;
  #sessionReady: Promise<LiveSession | null> = Promise.resolve(null);
  #engine: VoiceEngine | null = null;
  #engineState: EngineState = "idle";
  #detachEngine: (() => void) | null = null;
  #detachBridge: (() => void) | null = null;
  #mic: Microphone | null = null;
  #releasing: Promise<void> = Promise.resolve();
  #rowCount = 0;

  constructor(deps: CaptureDeps) {
    this.#deps = deps;
    this.#timers = deps.timers ?? {
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.#state = {
      phase: "setup",
      keys: { status: "loading" },
      problem: null,
      capture: initialCapture,
      mode: "push_to_talk",
      pressed: false,
      partial: null,
      paused: false,
      frozen: null,
      suspended: false,
      online: true,
      // Known once mounted: server rendering has no speech synthesis, and hydration must match.
      speak: { available: false, enabled: false },
      activity: [],
      store: null,
      sessionId: null,
      entities: [],
      providers: null,
      turnsSent: 0,
      fake: null,
    };
  }

  // ─── React's view ──────────────────────────────────────────────────────────────────────────

  readonly getState = (): CaptureUiState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #update(patch: Partial<CaptureUiState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A subscriber's bug mustn't stop capture.
      }
    }
  }

  #log(kind: ActivityKind, text: string): void {
    const row: ActivityRow = {
      id: `local-${++this.#rowCount}`,
      kind,
      text,
      at: this.#deps.clock(),
    };
    this.#update({ activity: [...this.#state.activity, row].slice(-MAX_LOCAL_ROWS) });
  }

  // ─── Setup ─────────────────────────────────────────────────────────────────────────────────

  /** Reads the device's key list for the pickers. Metadata only. */
  async loadKeys(): Promise<void> {
    try {
      const keys = await this.#deps.keys.list();
      this.#update({ keys: { status: "ready", keys } });
    } catch {
      this.#update({ keys: { status: "unavailable" } });
    }
  }

  /** The page mounted: read what only the browser knows. */
  mount(): void {
    this.#update({
      online: this.#deps.online(),
      speak: { available: this.#deps.speech.available, enabled: this.#deps.speech.enabled },
    });
  }

  setOnline(online: boolean): void {
    if (online !== this.#state.online) this.#update({ online });
  }

  setSpokenConfirmations(enabled: boolean): void {
    this.#deps.speech.setEnabled(enabled);
    this.#update({
      speak: { available: this.#deps.speech.available, enabled: this.#deps.speech.enabled },
    });
  }

  /**
   * Starts a debrief. Call it from the click (or key press) itself: the AudioContext is made
   * here, synchronously, while the gesture's activation lasts.
   */
  start(input: StartInput): void {
    if (this.#state.phase !== "setup" && this.#state.phase !== "ended") return;
    this.#teardownSession();
    const generation = ++this.#generation;
    const audioContext = this.#deps.createAudioContext();
    this.#update({
      phase: "starting",
      problem: null,
      capture: initialCapture,
      pressed: false,
      partial: null,
      paused: false,
      frozen: null,
      suspended: false,
      activity: [],
      store: null,
      sessionId: null,
      entities: [],
      providers: null,
      turnsSent: 0,
      fake: input.fake
        ? { holdMs: input.fake.holdMs, nextLine: input.fake.scenario.turns[0]?.text ?? null }
        : null,
    });
    this.#sessionReady = this.#openSession(generation, input);
    void this.#arm(generation, audioContext);
  }

  async #plan(input: StartInput): Promise<SessionPlan | StartProblem> {
    const { fake } = input;
    if (fake) {
      const { scenario } = fake;
      return {
        providers: fake.providers,
        llm: scenario.llm,
        turnKey: fake.turnKey,
        createAdapter: (fromTurn) => fake.createAdapter(fromTurn),
        getCredential: () => async () => fake.credential(),
        keyterms: () => scenario.entities.map((entity) => entity.name),
        // The cassettes were recorded with these, so each turn's request matches its recording.
        start: () => ({
          entities: scenario.entities,
          startedAt: scenario.startedAt,
          timeZone: scenario.timeZone,
        }),
        fake,
      };
    }

    let keys: readonly StoredKeyMeta[];
    try {
      keys = await this.#deps.keys.list();
    } catch {
      return { kind: "keys_unavailable" };
    }
    this.#update({ keys: { status: "ready", keys } });
    const choices = providerChoices(keys);
    const stt = choices.stt.find((choice) => choice.value === input.selection?.stt);
    const llm = choices.llm.find((choice) => choice.value === input.selection?.llm);
    if (!stt || !llm) return { kind: "missing_key" };
    let turnKey: string | undefined;
    try {
      turnKey = await this.#deps.keys.reveal(llm.option.keyProvider, llm.keyLabel);
    } catch {
      return { kind: "keys_unavailable" };
    }
    if (!turnKey) return { kind: "missing_key" };
    const sttKey: { provider: ProviderId; label: string } = {
      provider: stt.option.keyProvider,
      label: stt.keyLabel,
    };
    const startedAt = this.#deps.now().toISOString();
    return {
      providers: {
        speechToText: { provider: stt.option.keyProvider, model: stt.option.model },
        llm: { provider: llm.option.id, model: llm.option.model },
      },
      llm: { provider: llm.option.id, model: llm.option.model },
      turnKey,
      createAdapter: () => this.#deps.createAdapter(stt.option),
      getCredential: (sessionId) => async (signal) => {
        const key = await this.#deps.keys.reveal(sttKey.provider, sttKey.label);
        if (!key) throw new VoiceError("provider_rejected", "the key is no longer on this device");
        return mintCredential(this.#deps.fetch, {
          sessionId,
          provider: stt.option.keyProvider,
          key,
          signal,
        });
      },
      keyterms: (created) => created.keyterms[stt.option.keyProvider],
      start: (created) => ({
        entities: created.entities,
        startedAt,
        timeZone: this.#deps.timeZone(),
      }),
      fake: null,
    };
  }

  async #openSession(generation: number, input: StartInput): Promise<LiveSession | null> {
    try {
      if (!this.#deps.online()) return this.#fail(generation, { kind: "offline" });
      const plan = await this.#plan(input);
      if (generation !== this.#generation) return null;
      if ("kind" in plan) return this.#fail(generation, plan);
      const created = await createSession(this.#deps.fetch, plan.providers);
      if (generation !== this.#generation) return null;
      if (!created.ok) {
        return this.#fail(generation, {
          kind: "session",
          error: created.error,
          ...(created.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: created.retryAfterSeconds }),
        });
      }
      const store = new SessionStore(created.sessionId, { now: this.#deps.clock });
      const begin = plan.start(created);
      const client = this.#deps.createClient({
        sessionId: created.sessionId,
        url: created.edgeUrl,
        getTicket: createTicketFetcher({ sessionId: created.sessionId, fetch: this.#deps.fetch }),
        initialTicket: {
          ticket: created.ticket,
          ticketExpiresAt: created.ticketExpiresAt,
          edgeUrl: created.edgeUrl,
        },
        store,
        // A hidden iOS page: stop capture first, so the last turn reaches the outbox.
        onSuspend: () => this.#suspendCapture(),
        ...this.#deps.clientOptions,
      });
      const live: LiveSession = {
        sessionId: created.sessionId,
        store,
        client,
        plan,
        keyterms: plan.keyterms(created),
        marks: new TurnMarksRecorder((turnId, marks) => client.sendMetric(turnId, marks)),
        unsubscribe: () => {},
        turnKey: plan.turnKey,
        seen: 0,
        connection: store.getState().connection.state,
        everOpen: false,
        silent: initialSilentResponse,
        silentTimer: null,
        stopTimer: null,
      };
      live.unsubscribe = store.subscribe(() => this.#onStore(live));
      this.#live = live;
      client.start();
      client.sendStart({ providers: plan.providers, ...begin });
      this.#update({
        phase: "live",
        store,
        sessionId: created.sessionId,
        entities: begin.entities,
        providers: plan.providers,
      });
      return live;
    } catch {
      return this.#fail(generation, { kind: "session", error: "server_error" });
    }
  }

  #fail(generation: number, problem: StartProblem): null {
    if (generation === this.#generation) {
      this.#capture({ type: "reset" });
      void this.#releaseCapture();
      this.#teardownSession();
      this.#update({ phase: "setup", problem, store: null, sessionId: null });
    }
    return null;
  }

  // ─── Capture ───────────────────────────────────────────────────────────────────────────────

  /** Applies a capture-machine event and performs its `release` effect. */
  #capture(event: CaptureEvent): void {
    const step = captureTransition(this.#state.capture, event);
    if (!sameCapture(step.capture, this.#state.capture)) this.#update({ capture: step.capture });
    for (const effect of step.effects) {
      if (effect.type === "release") void this.#releaseCapture();
    }
  }

  /** Asks for the microphone, waits for the session, and starts the engine on both. */
  async #arm(generation: number, audioContext: AudioContext | undefined): Promise<void> {
    const discard = () => void audioContext?.close().catch(() => {});
    this.#capture({ type: "arm" });
    let mic: Microphone;
    try {
      mic = await this.#deps.openMicrophone();
    } catch (error) {
      discard();
      if (generation !== this.#generation) return;
      const code = isVoiceError(error) ? error.code : "device_unavailable";
      this.#capture({ type: "mic_failed", code });
      this.#log("error", VOICE_ERROR_COPY[code].title);
      return;
    }
    if (generation !== this.#generation) {
      mic.close();
      discard();
      return;
    }
    this.#mic = mic;
    this.#capture({ type: "mic_granted" });
    const live = await this.#sessionReady;
    if (!live || generation !== this.#generation || this.#mic !== mic) {
      if (this.#mic === mic) this.#mic = null;
      mic.close();
      discard();
      return;
    }
    await this.#startEngine(live, mic, audioContext, generation);
  }

  async #startEngine(
    live: LiveSession,
    mic: Microphone,
    audioContext: AudioContext | undefined,
    generation: number,
  ): Promise<void> {
    const engine = this.#deps.createEngine({
      adapter: live.plan.createAdapter(this.#state.turnsSent),
      getCredential: live.plan.getCredential(live.sessionId),
      mode: this.#state.mode,
      ...this.#deps.engineOptions,
    });
    this.#engine = engine;
    this.#engineState = "idle";
    this.#detachEngine = engine.on((event) => this.#onEngineEvent(live, engine, event));
    this.#detachBridge = connectEngine(engine, live.client, {
      llm: () => live.plan.llm,
      key: () => live.turnKey,
    });
    try {
      await engine.start({
        stream: mic.stream,
        keyterms: live.keyterms,
        signal: new AbortController().signal,
        ...(audioContext ? { audioContext } : {}),
      });
    } catch (error) {
      if (generation !== this.#generation || this.#engine !== engine) return;
      const code = isVoiceError(error) ? error.code : "audio_unavailable";
      this.#capture({ type: "engine_error", code, retryable: false });
    }
  }

  /** Stops the engine (its last turn end and usage still go out), then the microphone. */
  #releaseCapture(): Promise<void> {
    const engine = this.#engine;
    const mic = this.#mic;
    const detachEngine = this.#detachEngine;
    const detachBridge = this.#detachBridge;
    this.#engine = null;
    this.#mic = null;
    this.#detachEngine = null;
    this.#detachBridge = null;
    this.levels.reset();
    if (this.#state.pressed || this.#state.partial !== null) {
      this.#update({ pressed: false, partial: null });
    }
    if (!engine && !mic) return this.#releasing;
    this.#releasing = (async () => {
      if (engine) {
        try {
          await engine.stop();
        } catch {
          // Stopping is best effort; the microphone still closes.
        }
      }
      detachEngine?.();
      detachBridge?.();
      mic?.close();
      this.#outputSafe();
    })();
    return this.#releasing;
  }

  /** The microphone is off: play anything that was waiting for silence. */
  #outputSafe(): void {
    const live = this.#live;
    const safe = isAudioOutputSafe({ ios: this.#deps.ios, micTrackLive: false, recording: false });
    if (live) this.#silent(live, { type: "output", safe });
    this.#deps.speech.flush(safe);
  }

  #onEngineEvent(live: LiveSession, engine: VoiceEngine, event: VoiceEvent): void {
    if (this.#live !== live || this.#engine !== engine) return;
    const at = this.#deps.clock();
    switch (event.type) {
      case "state": {
        const previous = this.#engineState;
        this.#engineState = event.state;
        if (previous === "recording" && event.state !== "recording") live.marks.speechStopped(at);
        this.#capture({ type: "engine_state", state: event.state });
        this.#silent(live, {
          type: "output",
          safe: isAudioOutputSafe({
            ios: this.#deps.ios,
            micTrackLive: this.#mic !== null,
            recording: event.state === "recording",
          }),
        });
        return;
      }
      case "error":
        this.#capture({ type: "engine_error", code: event.code, retryable: event.retryable });
        this.#log("error", VOICE_ERROR_COPY[event.code].title);
        return;
      case "partial":
        this.#update({ partial: event.text });
        return;
      case "final":
        live.marks.final(event.turnId, at);
        this.#update({ partial: null });
        return;
      case "turn_end": {
        live.marks.turnEnded(event.turnId, event.trigger, this.#state.mode, at);
        const turnsSent = this.#state.turnsSent + 1;
        const fake = this.#state.fake;
        this.#update({
          turnsSent,
          partial: null,
          fake: fake
            ? { ...fake, nextLine: live.plan.fake?.scenario.turns[turnsSent]?.text ?? null }
            : null,
        });
        this.#silent(live, { type: "turn_sent", turnId: event.turnId });
        return;
      }
      case "level":
        this.levels.set(event.mic, event.agent);
        return;
      default:
        return;
    }
  }

  /** Push-to-talk down. `at` is the DOM event's timestamp, on the page's clock. */
  press(): void {
    const { capture, mode, pressed } = this.#state;
    if (pressed || mode !== "push_to_talk" || !this.#engine) return;
    if (!CAPTURE_RUNNING.has(capture.state)) return;
    if (capture.state === "provider_unavailable") this.#capture({ type: "retry" });
    this.#update({ pressed: true });
    this.#engine.pushToTalk(true);
  }

  /** Push-to-talk up: the turn's speech is over. */
  release(at: number = this.#deps.clock()): void {
    if (!this.#state.pressed) return;
    this.#update({ pressed: false });
    this.#live?.marks.released(at);
    this.#engine?.pushToTalk(false);
  }

  /**
   * `H`: switches between push-to-talk and hands-free. The engine's mode is fixed when it starts,
   * so a running engine is replaced on the same microphone. Call it from the key press itself.
   */
  toggleHandsFree(): void {
    if (this.#state.pressed) this.release();
    const mode: CaptureMode = this.#state.mode === "push_to_talk" ? "hands_free" : "push_to_talk";
    this.#update({ mode });
    this.#log("action", mode === "hands_free" ? "Hands-free on." : "Push-to-talk on.");
    const live = this.#live;
    const mic = this.#mic;
    const engine = this.#engine;
    if (!live || !mic || !engine) return;
    const audioContext = this.#deps.createAudioContext();
    const generation = this.#generation;
    const detachBridge = this.#detachBridge;
    // The old engine's states mustn't reach the machine; its last turn end still goes out.
    this.#detachEngine?.();
    this.#engine = null;
    this.#detachEngine = null;
    this.#detachBridge = null;
    this.#releasing = (async () => {
      try {
        await engine.stop();
      } catch {
        // Replaced either way.
      }
      detachBridge?.();
      if (generation !== this.#generation || this.#mic !== mic) {
        void audioContext?.close().catch(() => {});
        return;
      }
      await this.#startEngine(live, mic, audioContext, generation);
    })();
  }

  /** Stops capture but keeps the session: a pause, a hidden iOS page, or navigation on iOS. */
  #suspendCapture(): Promise<void> {
    if (!this.#engine && !this.#mic) return this.#releasing;
    this.#update({ suspended: true });
    this.#capture({ type: "disarm" });
    return this.#releasing;
  }

  pauseCapture(): void {
    if (this.#state.phase === "live") void this.#suspendCapture();
  }

  /**
   * Arms again after a pause or a microphone error. Call it from the click itself: it makes a
   * new AudioContext.
   */
  resumeCapture(): void {
    if (this.#state.phase !== "live" || this.#engine || this.#mic) return;
    const audioContext = this.#deps.createAudioContext();
    this.#update({ suspended: false });
    if (this.#state.capture.state !== "idle") this.#capture({ type: "disarm" });
    void this.#arm(this.#generation, audioContext);
  }

  /** "Try again" after a provider error: the next press reconnects too. */
  retryProvider(): void {
    this.#capture({ type: "retry" });
  }

  /** `P`: pauses and resumes live updates on screen (WCAG 2.2.2). Capture carries on. */
  togglePause(): void {
    const paused = !this.#state.paused;
    this.#update({ paused, frozen: paused ? (this.#live?.store.getState() ?? null) : null });
  }

  /** `Esc` or End: stops capture, sends `end`, and shows the final cost. */
  async end(): Promise<void> {
    const live = this.#live;
    if (!live || this.#state.phase !== "live") return;
    this.#update({ phase: "ending", paused: false, frozen: null, suspended: false });
    this.#capture({ type: "disarm" });
    await this.#releasing;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = this.#timers.setTimeout(
          () => reject(new Error("timeout")),
          END_ACK_TIMEOUT_MS,
        );
        live.client.end(this.#deps.now().toISOString()).then(
          () => {
            this.#timers.clearTimeout(timer);
            resolve();
          },
          (error: unknown) => {
            this.#timers.clearTimeout(timer);
            reject(error);
          },
        );
      });
    } catch {
      this.#log("connection", "The session didn’t confirm the end yet; it keeps trying.");
    }
    if (this.#live !== live) return;
    live.turnKey = undefined;
    this.#update({ phase: "ended" });
    this.#stopWhenDelivered(live, 0);
  }

  /**
   * Keeps the ended session's socket open for late events (the last turn's LLM usage), and until
   * the outbox has delivered everything, `end` included, for up to a minute; then closes it.
   */
  #stopWhenDelivered(live: LiveSession, waitedMs: number): void {
    live.stopTimer = this.#timers.setTimeout(() => {
      live.stopTimer = null;
      const waited = waitedMs + LATE_EVENTS_MS;
      if (live.store.getState().pending > 0 && waited < MAX_DELIVERY_WAIT_MS) {
        this.#stopWhenDelivered(live, waited);
        return;
      }
      live.client.stop();
    }, LATE_EVENTS_MS);
  }

  /** Back to the pickers after a debrief ended (or failed to start). */
  reset(): void {
    if (this.#state.phase !== "ended" && this.#state.phase !== "setup") return;
    this.#generation += 1;
    this.#teardownSession();
    this.#update({
      phase: "setup",
      problem: null,
      capture: initialCapture,
      store: null,
      sessionId: null,
      entities: [],
      providers: null,
      activity: [],
      partial: null,
      paused: false,
      frozen: null,
      turnsSent: 0,
      fake: null,
    });
  }

  /** A proposal's card was painted: the turn's last latency mark. */
  cardPainted(proposalId: string, at: number): void {
    this.#live?.marks.painted(proposalId, at);
  }

  /**
   * Stops everything: the provider unmounted (the rep left the signed-in app). The microphone
   * closes at once; SessionDO keeps what it already acknowledged.
   */
  dispose(): void {
    this.#generation += 1;
    this.#capture({ type: "reset" });
    void this.#releaseCapture();
    this.#teardownSession();
    this.#deps.speech.clear();
  }

  #teardownSession(): void {
    const live = this.#live;
    if (!live) return;
    this.#live = null;
    live.unsubscribe();
    live.turnKey = undefined;
    if (live.silentTimer) this.#timers.clearTimeout(live.silentTimer);
    if (live.stopTimer) this.#timers.clearTimeout(live.stopTimer);
    live.client.stop();
  }

  // ─── Session events ────────────────────────────────────────────────────────────────────────

  #onStore(live: LiveSession): void {
    if (this.#live !== live) return;
    const state = live.store.getState();
    for (let index = live.seen; index < state.events.length; index++) {
      const event = state.events[index];
      const at = state.receivedAt[index] ?? this.#deps.clock();
      if (event?.type === "proposal.created") {
        live.marks.proposalArrived(event.payload.proposalId, at);
      } else if (event?.type === "turn.completed") {
        const { turnId, outcome, proposalIds } = event.payload;
        live.marks.turnCompleted(turnId, proposalIds);
        this.#silent(live, { type: "completed", turnId, outcome });
        if (outcome === "proposals") {
          const types = state.projections.proposals
            .filter((proposal) => proposalIds.includes(proposal.proposalId))
            .map((proposal) => proposal.type);
          this.#deps.speech.say(turnOutcomeText(outcome, types));
          if (!this.#mic) this.#deps.speech.flush(true);
        }
      }
    }
    live.seen = state.events.length;
    this.#followConnection(live, state);
  }

  #followConnection(live: LiveSession, state: SessionState): void {
    const { connection } = state;
    if (connection.online !== this.#state.online) this.#update({ online: connection.online });
    const previous = live.connection;
    if (connection.state === previous) return;
    live.connection = connection.state;
    switch (connection.state) {
      case "open":
        if (live.everOpen) this.#log("connection", "Reconnected. Nothing was lost.");
        live.everOpen = true;
        return;
      case "backoff":
        if (previous !== "offline") this.#log("connection", "Connection lost. Reconnecting…");
        return;
      case "offline":
        this.#log("connection", "You’re offline. Earshot reconnects when you’re back.");
        return;
      case "closed":
        if (connection.reason && connection.reason !== "stopped") {
          this.#log("connection", "The session connection closed and won’t reopen.");
        }
        return;
      default:
        return;
    }
  }

  #silent(live: LiveSession, event: SilentResponseEvent): void {
    const step = silentResponseTransition(live.silent, event);
    live.silent = step.silentResponse;
    for (const effect of step.effects) {
      switch (effect.type) {
        case "start_timer":
          if (live.silentTimer) this.#timers.clearTimeout(live.silentTimer);
          live.silentTimer = this.#timers.setTimeout(() => {
            live.silentTimer = null;
            if (this.#live === live) this.#silent(live, { type: "timeout" });
          }, effect.delayMs);
          break;
        case "cancel_timer":
          if (live.silentTimer) this.#timers.clearTimeout(live.silentTimer);
          live.silentTimer = null;
          break;
        case "notify":
          if (effect.chime) this.#deps.chime();
          if (effect.reason === "timeout")
            this.#log("action", "No answer for that turn yet. Still waiting…");
          break;
      }
    }
  }
}
