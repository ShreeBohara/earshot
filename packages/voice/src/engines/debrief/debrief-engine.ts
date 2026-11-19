// The Debrief engine (spec WP4 step 8): the cascaded `VoiceEngine`. It composes the capture graph,
// a speech-to-text adapter, and the speech socket machine, and emits partials, finals, and turn
// ends for SessionClient to send on. Only finals and turn ends ever reach SessionDO.
//
// Audio. Capture runs for the whole armed session; pressing push-to-talk gates what enters the
// speech stream (spec decision 11). The stream's sample index is the session's audio clock, and
// its last 60 s stay in a ring buffer. Each socket sends from a cursor into the stream, so a
// reconnect replays from the end of the last final simply by starting its cursor there.
//
// Turns. In push-to-talk, a turn is one press. On release the engine flushes the worklet's
// partial frame, sends the remainder (padded to 20 ms) and the provider's force-finalize, and
// emits `turn_end` once the provider closes the turn, or after a timeout. If no provider turn is
// open and no voiced audio went out recently, it doesn't wait at all. Hands-free turns are the
// provider's own; the VAD only drives the UI state and closes the socket after a long silence.
//
// Socket. Opened on the first press (or on arming hands-free), reused across presses, kept alive
// while idle, and closed after 20 s idle, since AssemblyAI bills open sockets and its free tier
// allows only 5 new streams a minute. A drop while audio is needed reconnects with backoff and a
// fresh credential; the buffered audio goes out faster than real time.
import { type UtteranceFinalV2, uuidv7 } from "@earshot/core";
import { levelFromRms, TARGET_SAMPLE_RATE } from "../../capture/dsp";
import {
  CAPTURE_WORKLET_PATH,
  type CaptureFrame,
  type CaptureSource,
  type CaptureSourceFactory,
  startCaptureGraph,
} from "../../capture/graph";
import { PcmRingBuffer } from "../../capture/ring-buffer";
import { msToSamples, SpeechStream } from "../../capture/speech-stream";
import type { CaptureMode, EngineState, TurnTrigger, VoiceErrorCode } from "../../codes";
import type { VoiceEngine, VoiceEngineStartOptions, VoiceEvent } from "../../engine";
import { isVoiceError, VoiceError } from "../../errors";
import { backoffDelay } from "../../machines/backoff";
import {
  initialSpeechSocket,
  type SpeechSocket,
  type SpeechSocketEffect,
  type SpeechSocketEvent,
  type SpeechSocketPolicy,
  speechSocketTransition,
} from "../../machines/speech-socket";
import {
  type SttAdapter,
  SttConnectError,
  type SttConnection,
  type SttErrorCode,
  type SttEvent,
  type TempCredential,
} from "../../stt/adapter";
import { type Clock, systemClock } from "../../stt/socket";
import {
  type HandsFreeVad,
  type HandsFreeVadFactory,
  loadHandsFreeVad,
} from "../../vad/hands-free";

const SAMPLES_PER_MS = TARGET_SAMPLE_RATE / 1000;

export interface DebriefEngineOptions {
  readonly adapter: SttAdapter;
  /**
   * Mints a temporary credential for every connect (`POST /api/voice/token`). Throw a
   * `VoiceError` to choose the code: `provider_rejected` stops retrying; `credential_failed` and
   * `rate_limited` retry with backoff.
   */
  readonly getCredential: (signal: AbortSignal) => Promise<TempCredential>;
  readonly mode?: CaptureMode;
  /** The built pcm16-capture worklet. */
  readonly workletUrl?: string | URL;
  /** Where frames come from. Defaults to the AudioWorklet graph; tests pass a scripted source. */
  readonly capture?: CaptureSourceFactory;
  /** Hands-free's VAD, loaded on first use. Defaults to vad-web with Silero v6. */
  readonly vad?: HandsFreeVadFactory;
  readonly vadAssetPath?: string;
  /**
   * Read synchronously for every frame: while it returns true, mic audio isn't sent. WP8's
   * autoMute machine sets it while the agent speaks, through a ref rather than React state.
   */
  readonly isMuted?: () => boolean;
  readonly clock?: Clock;
  /** For backoff jitter; tests pass a constant. */
  readonly random?: () => number;
  /** Turn ids. Defaults to UUIDv7. */
  readonly createId?: () => string;
  /** Close an idle socket after this long (target 20 s). */
  readonly idleCloseMs?: number;
  /** Send a keepalive after this long without audio. */
  readonly keepAliveMs?: number;
  /** How long a release waits for the provider's end of turn when speech may be in flight. */
  readonly finalizeTimeoutMs?: number;
  /** The wait when the provider's turn is closed but audio went out in the last `voicedTailMs`. */
  readonly quietReleaseWaitMs?: number;
  readonly voicedTailMs?: number;
  /** A frame at least this loud (RMS) counts as voiced. */
  readonly voicedRms?: number;
  /** How long a release waits for the worklet's partial frame. */
  readonly flushTimeoutMs?: number;
  /** Hands-free: silence after which the socket closes until the VAD hears speech again. */
  readonly handsFreeSilenceMs?: number;
  /** Hands-free: audio from before the VAD fired, prepended when the socket wakes. */
  readonly preRollMs?: number;
  readonly maxConnectAttempts?: number;
  readonly ringSeconds?: number;
}

interface Turn {
  readonly id: string;
  finals: number;
  /** The stream position where the turn's audio ended, once it has. */
  endSample?: number;
}

interface Finalizing {
  readonly turn: Turn;
  readonly trigger: TurnTrigger;
  timer: unknown;
  /** Its force-finalize went out on the current socket. */
  sent: boolean;
  /** Its wait is over; it ends as soon as every earlier turn has. */
  expired: boolean;
}

const TIMER_NAMES = ["idle", "retry", "keepAlive", "flush", "silence"] as const;
type TimerName = (typeof TIMER_NAMES)[number];

const RUNNING: ReadonlySet<EngineState> = new Set([
  "armed",
  "recording",
  "finalizing",
  "reconnecting",
]);

export function createDebriefEngine(options: DebriefEngineOptions): DebriefEngine {
  return new DebriefEngine(options);
}

export class DebriefEngine implements VoiceEngine {
  readonly kind = "cascaded";
  readonly #adapter: SttAdapter;
  readonly #getCredential: (signal: AbortSignal) => Promise<TempCredential>;
  readonly #captureFactory: CaptureSourceFactory;
  readonly #vadFactory: HandsFreeVadFactory;
  readonly #workletUrl: string | URL;
  readonly #clock: Clock;
  readonly #createId: () => string;
  readonly #isMuted: () => boolean;
  readonly #policy: SpeechSocketPolicy;
  readonly #settings: {
    idleCloseMs: number;
    keepAliveMs: number;
    finalizeTimeoutMs: number;
    quietReleaseWaitMs: number;
    voicedTailSamples: number;
    voicedRms: number;
    flushTimeoutMs: number;
    handsFreeSilenceMs: number;
    preRollSamples: number;
    vadAssetPath: string | undefined;
  };
  readonly #listeners = new Set<(event: VoiceEvent) => void>();
  readonly #speech: SpeechStream;
  readonly #preRoll: PcmRingBuffer;

  #state: EngineState = "idle";
  #mode: CaptureMode;
  #keyterms: readonly string[] = [];
  #stream: MediaStream | undefined;
  #capture: CaptureSource | undefined;
  #stopFrames: (() => void) | undefined;
  #stopping: Promise<void> | undefined;

  /** Whether frames enter the speech stream: open, closed, or draining up to a release's flush. */
  #gate: "open" | "closed" | "draining" = "closed";
  #pressed = false;
  /** Hands-free: streaming (the socket wanted), or asleep after a long silence. */
  #streaming = false;
  /** Hands-free: the VAD hears speech. */
  #speaking = false;
  #vad: HandsFreeVad | undefined;
  #vadLoading: Promise<void> | undefined;

  #socket: SpeechSocket = initialSpeechSocket;
  #connection: SttConnection | undefined;
  #connectAbort: AbortController | undefined;
  #lastConnectError: VoiceErrorCode = "provider_unavailable";
  /** After giving up, the socket stays down until the rep acts again. */
  #suspended = false;
  /** The stream position of the next sample the current socket hasn't sent. */
  #cursor = 0;

  #currentTurn: Turn | undefined;
  /**
   * Released turns still waiting on their finals, oldest first. A second release can come before
   * the first one's final lands; each queued turn then takes the finals that arrive until the
   * provider ends it, so transcripts stay with the press they came from.
   */
  #finalizing: Finalizing[] = [];
  /** A release's force-finalize, waiting for an open, caught-up socket. */
  #pendingFinalize = false;
  #providerTurnOpen = false;
  #lastVoicedSample = Number.NEGATIVE_INFINITY;
  #lastFinalEndSample = 0;
  /** Audio before this belongs to turns that have ended; it's never replayed. */
  #committedSample = 0;
  readonly #turnWaiters = new Set<() => void>();
  readonly #socketWaiters = new Set<() => void>();

  readonly #timers: Partial<Record<TimerName, unknown>> = {};

  constructor(options: DebriefEngineOptions) {
    this.#adapter = options.adapter;
    this.#getCredential = options.getCredential;
    this.#captureFactory = options.capture ?? startCaptureGraph;
    this.#vadFactory = options.vad ?? loadHandsFreeVad;
    this.#workletUrl = options.workletUrl ?? CAPTURE_WORKLET_PATH;
    this.#clock = options.clock ?? systemClock;
    this.#createId = options.createId ?? uuidv7;
    this.#isMuted = options.isMuted ?? (() => false);
    this.#mode = options.mode ?? "push_to_talk";
    const random = options.random ?? Math.random;
    this.#policy = {
      maxAttempts: options.maxConnectAttempts ?? 5,
      delay: (attempt) => backoffDelay(attempt, { random }),
    };
    this.#settings = {
      idleCloseMs: options.idleCloseMs ?? 20_000,
      keepAliveMs: options.keepAliveMs ?? 5_000,
      finalizeTimeoutMs: options.finalizeTimeoutMs ?? 1_500,
      quietReleaseWaitMs: options.quietReleaseWaitMs ?? 600,
      voicedTailSamples: (options.voicedTailMs ?? 800) * SAMPLES_PER_MS,
      voicedRms: options.voicedRms ?? 0.01,
      flushTimeoutMs: options.flushTimeoutMs ?? 100,
      handsFreeSilenceMs: options.handsFreeSilenceMs ?? 20_000,
      preRollSamples: (options.preRollMs ?? 1_000) * SAMPLES_PER_MS,
      vadAssetPath: options.vadAssetPath,
    };
    this.#speech = new SpeechStream({
      ringSeconds: options.ringSeconds ?? 60,
      messageSamples: Math.round(options.adapter.limits.chunkMs * SAMPLES_PER_MS),
    });
    this.#preRoll = new PcmRingBuffer(Math.max(1, this.#settings.preRollSamples));
  }

  get state(): EngineState {
    return this.#state;
  }

  get mode(): CaptureMode {
    return this.#mode;
  }

  on(listener: (event: VoiceEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Call from the Arm click, with no await before it, so the AudioContext may start. */
  async start(opts: VoiceEngineStartOptions): Promise<void> {
    if (this.#state !== "idle") throw new Error("a DebriefEngine starts once");
    this.#setState("starting");
    this.#keyterms = [...opts.keyterms];
    this.#stream = opts.stream;
    if (opts.signal.aborted) {
      await this.stop();
      return;
    }
    opts.signal.addEventListener("abort", () => void this.stop(), { once: true });
    let capture: CaptureSource;
    try {
      capture = await this.#captureFactory({
        stream: opts.stream,
        workletUrl: this.#workletUrl,
        ...(opts.audioContext ? { audioContext: opts.audioContext } : {}),
      });
    } catch (error) {
      const failure = isVoiceError(error)
        ? error
        : new VoiceError("audio_unavailable", "capture failed to start", { cause: error });
      this.#emit({ type: "error", code: failure.code, retryable: failure.retryable });
      this.#setState("stopped");
      throw failure;
    }
    if (this.#stopping) {
      await capture.close();
      return;
    }
    this.#capture = capture;
    this.#stopFrames = capture.onFrame((frame) => this.#onFrame(frame));
    this.#setState("armed");
    if (this.#mode === "hands_free") this.#enterHandsFree();
  }

  pushToTalk(down: boolean): void {
    if (this.#mode === "hands_free" || !RUNNING.has(this.#state) || down === this.#pressed) return;
    this.#pressed = down;
    this.#suspended = false;
    if (down) this.#press();
    else this.#release();
  }

  async setKeyterms(terms: readonly string[]): Promise<void> {
    this.#keyterms = [...terms];
    const connection = this.#connection;
    if (!connection || this.#socket.state !== "open") return; // the next connect carries them
    try {
      await connection.updateKeyterms(this.#keyterms);
    } catch (error) {
      throw isVoiceError(error)
        ? error
        : new VoiceError("keyterms_rejected", "the keyterm update failed", { cause: error });
    }
  }

  /** Switches between push-to-talk and hands-free. Before `start()`, it sets the starting mode. */
  async setHandsFree(on: boolean): Promise<void> {
    const next: CaptureMode = on ? "hands_free" : "push_to_talk";
    if (next === this.#mode) return;
    if (!RUNNING.has(this.#state)) {
      if (this.#state === "idle") this.#mode = next;
      return;
    }
    if (on) {
      if (this.#pressed) {
        this.#pressed = false;
        this.#release();
      }
      this.#mode = "hands_free";
      this.#enterHandsFree();
      await this.#vadLoading;
    } else {
      this.#mode = "push_to_talk";
      this.#leaveHandsFree();
    }
  }

  stop(): Promise<void> {
    this.#stopping ??= this.#shutdown();
    return this.#stopping;
  }

  // ---- capture ----

  #onFrame(frame: CaptureFrame): void {
    this.#emit({ type: "level", mic: levelFromRms(frame.rms), agent: 0 });
    const muted = this.#isMuted();
    // Muted audio (the agent speaking) never reaches the provider, not even as the pre-roll a
    // hands-free wake replays: the ring keeps silence in its place, so its timing still lines up.
    this.#preRoll.write(muted ? new Int16Array(frame.pcm.length) : frame.pcm);
    if (this.#gate !== "closed" && !muted) {
      this.#speech.append(frame.pcm);
      if (frame.rms >= this.#settings.voicedRms) this.#lastVoicedSample = this.#speech.end;
      this.#pump(false);
    }
    if (frame.flush) this.#onDrained();
  }

  // ---- push-to-talk ----

  #press(): void {
    if (this.#gate === "draining") this.#onDrained(); // a quick re-press finishes the last release
    this.#currentTurn ??= this.#newTurn();
    this.#gate = "open";
    this.#syncWant();
  }

  #release(): void {
    this.#gate = "draining";
    this.#capture?.flush();
    this.#clearTimer("flush");
    this.#timers.flush = this.#clock.setTimeout(
      () => this.#onDrained(),
      this.#settings.flushTimeoutMs,
    );
    this.#updateState();
  }

  /** The release's partial frame is in (or never came): close the gate and finalize the turn. */
  #onDrained(): void {
    if (this.#gate !== "draining") return;
    this.#clearTimer("flush");
    this.#gate = "closed";
    const turn = this.#currentTurn ?? this.#newTurn();
    this.#currentTurn = undefined;
    this.#beginFinalize(turn, "ptt_release");
  }

  #beginFinalize(turn: Turn, trigger: TurnTrigger): void {
    turn.endSample = this.#speech.end;
    // Queue behind any release still waiting on its finals, rather than ending that one early.
    this.#finalizing.push({ turn, trigger, timer: undefined, sent: false, expired: false });
    this.#pendingFinalize = true;
    this.#syncWant();
    this.#sendFinalize();
  }

  /** Sends the remainder and the force-finalize once the socket is open and caught up. */
  #sendFinalize(): void {
    const connection = this.#connection;
    if (!this.#pendingFinalize || !connection || this.#socket.state !== "open") return;
    this.#pump(true);
    // The socket can drop while the remainder goes out; then the next one sends the finalize.
    if (this.#connection !== connection || this.#socket.state !== "open") return;
    this.#pendingFinalize = false;
    connection.finalize();
    const unsent = this.#finalizing.filter((finalizing) => !finalizing.sent);
    if (unsent.length === 0) return;
    const recentlyVoiced =
      this.#speech.end - this.#lastVoicedSample <= this.#settings.voicedTailSamples;
    const waitMs = this.#providerTurnOpen
      ? this.#settings.finalizeTimeoutMs
      : recentlyVoiced
        ? this.#settings.quietReleaseWaitMs
        : 0;
    for (const finalizing of unsent) {
      finalizing.sent = true;
      this.#clock.clearTimeout(finalizing.timer);
      if (waitMs === 0) finalizing.expired = true;
      else finalizing.timer = this.#clock.setTimeout(() => this.#expire(finalizing), waitMs);
    }
    this.#endExpiredTurns();
  }

  /** A queued turn's wait ran out: end it now if it's first in line, else right after the rest. */
  #expire(finalizing: Finalizing): void {
    if (!this.#finalizing.includes(finalizing)) return;
    finalizing.expired = true;
    this.#endExpiredTurns();
  }

  #endExpiredTurns(): void {
    while (this.#finalizing[0]?.expired) this.#endOldestTurn();
  }

  /** Ends the oldest released turn still waiting on its finals. */
  #endOldestTurn(): void {
    const finalizing = this.#finalizing.shift();
    if (!finalizing) return;
    this.#clock.clearTimeout(finalizing.timer);
    this.#pendingFinalize = this.#finalizing.some((waiting) => !waiting.sent);
    this.#emitTurnEnd(finalizing.turn, finalizing.trigger);
    this.#syncWant();
    for (const resolve of this.#turnWaiters) resolve();
  }

  #endAllWaitingTurns(): void {
    while (this.#finalizing.length > 0) this.#endOldestTurn();
  }

  #emitTurnEnd(turn: Turn, trigger: TurnTrigger): void {
    this.#committedSample = Math.max(
      this.#committedSample,
      turn.endSample ?? this.#lastFinalEndSample,
    );
    this.#emit({ type: "turn_end", turnId: turn.id, trigger });
  }

  #newTurn(): Turn {
    return { id: this.#createId(), finals: 0 };
  }

  // ---- hands-free ----

  #enterHandsFree(): void {
    this.#suspended = false;
    this.#wake(false);
    this.#vadLoading ??= this.#loadVad().finally(() => {
      this.#vadLoading = undefined;
    });
  }

  #leaveHandsFree(): void {
    this.#clearTimer("silence");
    void this.#vad?.pause().catch(() => {});
    this.#speaking = false;
    this.#streaming = false;
    this.#gate = "closed";
    const turn = this.#currentTurn;
    this.#currentTurn = undefined;
    if (turn && (turn.finals > 0 || this.#providerTurnOpen)) this.#beginFinalize(turn, "manual");
    else this.#committedSample = Math.max(this.#committedSample, this.#speech.end);
    this.#syncWant();
  }

  /** Starts streaming: on arming hands-free, or when the VAD hears speech after a silence. */
  #wake(withPreRoll: boolean): void {
    // Waking on the agent's own voice while muted must not replay it either.
    if (withPreRoll && !this.#isMuted()) {
      this.#speech.append(this.#preRoll.read(this.#preRoll.end - this.#settings.preRollSamples));
    }
    this.#clearTimer("silence");
    this.#streaming = true;
    this.#gate = "open";
    this.#syncWant();
  }

  /** After a long silence: stop streaming and close the socket until the VAD hears speech. */
  #sleep(): void {
    this.#streaming = false;
    this.#gate = "closed";
    const turn = this.#currentTurn;
    this.#currentTurn = undefined;
    if (turn && turn.finals > 0) this.#emitTurnEnd(turn, "manual");
    // The silence before now is done with: waking replays the pre-roll, not 20 s of quiet.
    this.#committedSample = Math.max(this.#committedSample, this.#speech.end);
    this.#syncWant();
    this.#socketEvent({ type: "idle_timeout" });
  }

  #armSilenceTimer(): void {
    this.#clearTimer("silence");
    this.#timers.silence = this.#clock.setTimeout(() => {
      if (this.#mode === "hands_free" && this.#streaming && !this.#speaking) this.#sleep();
    }, this.#settings.handsFreeSilenceMs);
  }

  async #loadVad(): Promise<void> {
    const stream = this.#stream;
    if (!stream) return;
    try {
      if (!this.#vad) {
        const vad = await this.#vadFactory({
          stream,
          ...(this.#capture?.audioContext ? { audioContext: this.#capture.audioContext } : {}),
          ...(this.#settings.vadAssetPath ? { assetPath: this.#settings.vadAssetPath } : {}),
          onSpeechStart: () => this.#onSpeechStart(),
          onSpeechEnd: () => this.#onSpeechEnd(),
        });
        if (this.#stopping) {
          await vad.destroy();
          return;
        }
        this.#vad = vad;
      }
      if (this.#mode !== "hands_free") return;
      await this.#vad.start();
      if (!this.#speaking) this.#armSilenceTimer();
    } catch {
      // Hands-free keeps streaming on the provider's endpointing alone, with no silence cutoff.
      this.#emit({ type: "error", code: "vad_unavailable", retryable: true });
    }
  }

  #onSpeechStart(): void {
    if (this.#mode !== "hands_free" || !RUNNING.has(this.#state)) return;
    this.#speaking = true;
    this.#suspended = false;
    this.#clearTimer("silence");
    if (!this.#streaming) this.#wake(true);
    else this.#updateState();
  }

  #onSpeechEnd(): void {
    if (this.#mode !== "hands_free") return;
    this.#speaking = false;
    this.#armSilenceTimer();
    this.#updateState();
  }

  // ---- the speech socket ----

  /** Wants the socket while audio needs sending: a press, a pending release, or hands-free. */
  #syncWant(): void {
    // While stopping, the last turn still needs the socket; the machine's `stop` closes it after.
    const needed =
      !this.#suspended &&
      (this.#pressed ||
        this.#gate === "draining" ||
        this.#finalizing.length > 0 ||
        (this.#mode === "hands_free" && this.#streaming));
    if (needed !== this.#socket.context.wanted) {
      this.#socketEvent({ type: needed ? "want" : "release" });
    } else {
      this.#updateState();
    }
  }

  #socketEvent(event: SpeechSocketEvent): void {
    const { socket, effects } = speechSocketTransition(this.#socket, event, this.#policy);
    this.#socket = socket;
    for (const effect of effects) this.#runEffect(effect);
    this.#updateState();
    if (this.#socket.state === "closed") for (const resolve of this.#socketWaiters) resolve();
  }

  #runEffect(effect: SpeechSocketEffect): void {
    switch (effect.type) {
      case "connect":
        void this.#connect();
        return;
      case "close":
        void this.#closeConnection();
        return;
      case "schedule_retry":
        this.#clearTimer("retry");
        this.#timers.retry = this.#clock.setTimeout(
          () => this.#socketEvent({ type: "retry_due" }),
          effect.delayMs,
        );
        return;
      case "cancel_retry":
        this.#clearTimer("retry");
        return;
      case "start_idle_timer":
        this.#clearTimer("idle");
        this.#timers.idle = this.#clock.setTimeout(
          () => this.#socketEvent({ type: "idle_timeout" }),
          this.#settings.idleCloseMs,
        );
        return;
      case "cancel_idle_timer":
        this.#clearTimer("idle");
        return;
      case "give_up":
        this.#giveUp(effect.reason);
        return;
    }
  }

  async #connect(): Promise<void> {
    const abort = new AbortController();
    this.#connectAbort = abort;
    // Replay from the end of the last final, never from a turn that has already ended. The
    // offset may be a fractional ms; adapters round the session times they report.
    const replayFrom = Math.max(
      this.#lastFinalEndSample,
      this.#committedSample,
      this.#speech.start,
    );
    try {
      const credential = await this.#getCredential(abort.signal);
      if (abort.signal.aborted) {
        this.#socketEvent({ type: "closed" });
        return;
      }
      const connection = await this.#adapter.connect({
        credential,
        keyterms: this.#keyterms,
        baseOffsetMs: replayFrom / SAMPLES_PER_MS,
        signal: abort.signal,
      });
      if (abort.signal.aborted || this.#socket.state !== "connecting") {
        connection.on((event) => this.#onSttEvent(connection, event));
        await connection.close();
        this.#socketEvent({ type: "closed" });
        return;
      }
      this.#connection = connection;
      this.#cursor = replayFrom;
      this.#providerTurnOpen = false;
      connection.on((event) => this.#onSttEvent(connection, event));
      this.#socketEvent({ type: "opened" });
      this.#pump(false);
      this.#sendFinalize();
      this.#armKeepAlive();
    } catch (error) {
      if (abort.signal.aborted) {
        this.#socketEvent({ type: "closed" });
        return;
      }
      const failure = classifyConnectError(error);
      this.#lastConnectError = failure.code;
      this.#socketEvent({
        type: "connect_failed",
        retryable: failure.retryable,
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      });
    } finally {
      if (this.#connectAbort === abort) this.#connectAbort = undefined;
    }
  }

  async #closeConnection(): Promise<void> {
    this.#clearTimer("keepAlive");
    if (this.#connectAbort) {
      this.#connectAbort.abort(); // the pending connect reports `closed` itself
      return;
    }
    const connection = this.#connection;
    if (!connection) {
      this.#socketEvent({ type: "closed" });
      return;
    }
    await connection.close(); // its `closed` event reaches the machine
  }

  #onSttEvent(connection: SttConnection, event: SttEvent): void {
    if (event.type === "closed") {
      this.#emit({
        type: "usage",
        provider: event.usage.provider,
        model: event.usage.model,
        audioMs: event.usage.audioMs,
        socketMs: event.usage.socketMs,
      });
      if (connection === this.#connection) this.#onConnectionClosed(event.expected);
      return;
    }
    if (connection !== this.#connection) return;
    switch (event.type) {
      case "partial":
        this.#providerTurnOpen = true;
        if (this.#mode === "hands_free") this.#currentTurn ??= this.#newTurn();
        this.#emit({
          type: "partial",
          text: event.text,
          startMs: event.startMs,
          endMs: event.endMs,
        });
        return;
      case "final":
        this.#onFinal(event.utterance);
        return;
      case "end_of_turn":
        this.#providerTurnOpen = false;
        this.#onProviderEndOfTurn();
        return;
      case "error":
        if (!event.fatal) {
          const code = voiceCodeFor(event.code);
          this.#emit({ type: "error", code, retryable: code !== "keyterms_rejected" });
        }
        return;
    }
  }

  #onConnectionClosed(expected: boolean): void {
    this.#connection = undefined;
    this.#providerTurnOpen = false;
    this.#clearTimer("keepAlive");
    // A force-finalize sent on the lost socket must go again on the next one, after the replay.
    for (const finalizing of this.#finalizing) {
      if (!finalizing.sent || finalizing.expired) continue;
      this.#clock.clearTimeout(finalizing.timer);
      finalizing.sent = false;
      this.#pendingFinalize = true;
    }
    this.#socketEvent({ type: expected ? "closed" : "dropped" });
  }

  #onFinal(utterance: UtteranceFinalV2): void {
    // Finals arrive in audio order, so they belong to the oldest release still waiting.
    let turn = this.#finalizing[0]?.turn ?? this.#currentTurn;
    const orphan = turn === undefined && this.#mode === "push_to_talk";
    if (!turn) {
      turn = this.#newTurn();
      if (this.#mode === "hands_free") this.#currentTurn = turn;
    }
    turn.finals += 1;
    this.#lastFinalEndSample = Math.max(this.#lastFinalEndSample, msToSamples(utterance.endMs));
    this.#emit({ type: "final", turnId: turn.id, utterance });
    // A late final after its press already ended: deliver it as a turn of its own.
    if (orphan) this.#emitTurnEnd(turn, "manual");
  }

  #onProviderEndOfTurn(): void {
    if (this.#finalizing.length > 0) {
      // The provider answers releases in order: this end of turn closes the oldest one.
      this.#endOldestTurn();
      this.#endExpiredTurns();
      return;
    }
    if (this.#mode === "hands_free" && this.#currentTurn) {
      const turn = this.#currentTurn;
      this.#currentTurn = undefined;
      if (turn.finals > 0) this.#emitTurnEnd(turn, "provider_eot");
    }
    // Push-to-talk, still pressed: the provider's endpointing split the press; it's one turn.
  }

  #giveUp(reason: "attempts_exhausted" | "rejected"): void {
    this.#suspended = true;
    this.#emit({ type: "error", code: this.#lastConnectError, retryable: reason !== "rejected" });
    this.#endAllWaitingTurns();
  }

  /** Sends whole messages from the cursor; with `flush`, the remainder too. */
  #pump(flush: boolean): void {
    const connection = this.#connection;
    if (!connection || this.#socket.state !== "open") return;
    const { messages, cursor } = this.#speech.take(this.#cursor, flush);
    this.#cursor = cursor;
    if (messages.length === 0) return;
    for (const message of messages) connection.send(message);
    this.#armKeepAlive();
  }

  #armKeepAlive(): void {
    this.#clearTimer("keepAlive");
    this.#timers.keepAlive = this.#clock.setTimeout(() => {
      const connection = this.#connection;
      if (!connection || this.#socket.state !== "open") return;
      connection.keepAlive();
      this.#armKeepAlive();
    }, this.#settings.keepAliveMs);
  }

  // ---- shutdown ----

  async #shutdown(): Promise<void> {
    if (this.#state === "idle" || this.#state === "stopped") {
      this.#setState("stopped");
      return;
    }
    if (this.#pressed) {
      this.#pressed = false;
      this.#release();
    }
    if (this.#mode === "hands_free") {
      this.#clearTimer("silence");
      this.#streaming = false;
      const turn = this.#currentTurn;
      this.#currentTurn = undefined;
      if (turn && (turn.finals > 0 || this.#providerTurnOpen)) this.#beginFinalize(turn, "manual");
    }
    await this.#waitForTurnEnd(this.#settings.flushTimeoutMs + this.#settings.finalizeTimeoutMs);
    if (this.#gate === "draining") this.#onDrained();
    this.#endAllWaitingTurns();
    this.#gate = "closed";
    for (const key of TIMER_NAMES) this.#clearTimer(key);
    await this.#vad?.destroy().catch(() => {});
    const closed = this.#waitForSocketClosed();
    this.#socketEvent({ type: "stop" });
    await closed;
    this.#stopFrames?.();
    await this.#capture?.close().catch(() => {});
    this.#setState("stopped");
  }

  #waitForTurnEnd(timeoutMs: number): Promise<void> {
    if (this.#gate !== "draining" && this.#finalizing.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (this.#gate === "draining" || this.#finalizing.length > 0) return;
        this.#clock.clearTimeout(timer);
        this.#turnWaiters.delete(done);
        resolve();
      };
      const timer = this.#clock.setTimeout(() => {
        this.#turnWaiters.delete(done);
        resolve();
      }, timeoutMs);
      this.#turnWaiters.add(done);
    });
  }

  /** Resolves once the socket machine reaches `closed`, or after a backstop delay. */
  #waitForSocketClosed(): Promise<void> {
    if (this.#socket.state === "closed") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.#clock.clearTimeout(timer);
        this.#socketWaiters.delete(done);
        resolve();
      };
      const timer = this.#clock.setTimeout(done, 5_000);
      this.#socketWaiters.add(done);
    });
  }

  // ---- state and events ----

  #updateState(): void {
    if (!RUNNING.has(this.#state)) return;
    const { wanted, recovering } = this.#socket.context;
    let next: EngineState;
    if (recovering && wanted) next = "reconnecting";
    else if (this.#pressed || (this.#mode === "hands_free" && this.#speaking)) next = "recording";
    else if (this.#gate === "draining" || this.#finalizing.length > 0) next = "finalizing";
    else next = "armed";
    this.#setState(next);
  }

  #setState(state: EngineState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#emit({ type: "state", state });
  }

  #emit(event: VoiceEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A listener's bug mustn't stall capture.
      }
    }
  }

  #clearTimer(key: TimerName): void {
    const handle = this.#timers[key];
    if (handle !== undefined) this.#clock.clearTimeout(handle);
    delete this.#timers[key];
  }
}

function voiceCodeFor(code: SttErrorCode): VoiceErrorCode {
  switch (code) {
    case "keyterms_rejected":
      return "keyterms_rejected";
    case "rate_limited":
      return "rate_limited";
    case "unauthorized":
      return "provider_rejected";
    case "connection_failed":
    case "connection_lost":
    case "timeout":
      return "provider_unavailable";
    default:
      return "provider_error";
  }
}

function classifyConnectError(error: unknown): {
  code: VoiceErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
} {
  if (isVoiceError(error)) {
    return error.code === "rate_limited"
      ? { code: error.code, retryable: true, retryAfterMs: 12_000 }
      : { code: error.code, retryable: error.retryable };
  }
  if (error instanceof SttConnectError) {
    // A rate limit with no stated pause gets AssemblyAI's free-tier spacing: 5 streams a minute.
    const retryAfterMs = error.retryAfterMs ?? (error.code === "rate_limited" ? 12_000 : undefined);
    return {
      code: voiceCodeFor(error.code),
      retryable: error.retryable,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  return { code: "provider_unavailable", retryable: true };
}
