// Plays a field's words from its evidence clip (Phase 5 spec §4.7, WP9; ADR-0036): Web Audio, not an
// <audio> element, so seeking is sample-exact with no container to parse. Each play builds one
// AudioBuffer at 16 kHz holding the whole clip (the context resamples it) and plays the span with
// `source.start(0, offset, duration)`, padded by 250 ms on each side and clamped to the clip. One
// span plays at a time: starting another stops the first.
//
// Autoplay rules: a context made or resumed outside a user's gesture stays suspended. So `unlock`
// must run synchronously inside the click or key press that asked, before anything awaits; the
// store's read can come after.
import { CLIP_SAMPLE_RATE, type ClipSpan, clipSpan } from "./clip-span";
import type { Clip } from "./clip-store";

/** The parts of an AudioContext the player uses, so unit tests can pass a fake. */
export type ClipAudioContext = Pick<
  AudioContext,
  "state" | "resume" | "createBuffer" | "createBufferSource" | "destination"
>;

export interface ClipPlayerOptions {
  /** Makes the context, inside the gesture that asked to play. Defaults to `new AudioContext()`. */
  readonly createContext?: () => ClipAudioContext;
}

/** PCM16 as Web Audio's floats, in [-1, 1). */
function toFloat(pcm: Int16Array, out: Float32Array): void {
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 32_768;
}

export class ClipPlayer {
  readonly #createContext: () => ClipAudioContext;
  readonly #listeners = new Set<() => void>();
  #context: ClipAudioContext | null = null;
  #source: AudioBufferSourceNode | null = null;
  #playing: string | null = null;

  constructor(options: ClipPlayerOptions = {}) {
    this.#createContext = options.createContext ?? (() => new AudioContext());
  }

  /** The key of the span playing now, or null. */
  get playing(): string | null {
    return this.#playing;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Makes the AudioContext, or resumes it. Call it synchronously in the click or key handler that
   * asked to play. Never throws: a browser without Web Audio just plays nothing.
   */
  unlock(): void {
    try {
      this.#context ??= this.#createContext();
      if (this.#context.state === "suspended") void this.#context.resume().catch(() => {});
    } catch {
      this.#context = null;
    }
  }

  /**
   * Plays evidence `audioMs` of `clip` under `key`, which `playing` reports until it ends. Stops
   * whatever was playing first. Returns the span played, or null when nothing could play (no
   * context, or the span falls outside the clip).
   */
  play(
    key: string,
    clip: Pick<Clip, "startMs" | "pcm">,
    audioMs: readonly [number, number],
  ): ClipSpan | null {
    this.stop();
    if (!this.#context) this.unlock();
    const context = this.#context;
    if (!context || clip.pcm.length === 0) return null;
    const span = clipSpan({ startMs: clip.startMs, samples: clip.pcm.length }, audioMs);
    if (span.end <= span.start) return null;
    try {
      const buffer = context.createBuffer(1, clip.pcm.length, CLIP_SAMPLE_RATE);
      toFloat(clip.pcm, buffer.getChannelData(0));
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (this.#source !== source) return;
        this.#source = null;
        this.#set(null);
      };
      this.#source = source;
      this.#set(key);
      source.start(0, span.offsetSeconds, span.durationSeconds);
      return span;
    } catch {
      this.stop();
      return null;
    }
  }

  /** Stops the span playing, if any. */
  stop(): void {
    const source = this.#source;
    this.#source = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Never started, or already over.
      }
      source.disconnect();
    }
    this.#set(null);
  }

  #set(key: string | null): void {
    if (this.#playing === key) return;
    this.#playing = key;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A listener's bug mustn't stop playback.
      }
    }
  }
}
