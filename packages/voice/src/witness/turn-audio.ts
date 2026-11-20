// Each turn's audio, kept for the second witness (Phase 4 spec WP9 step 2): from the press to the
// release plus 200 ms, capped at 120 s. Phase 3's 60 s replay ring is too short to rely on, and it
// holds only gated audio, so this keeps a buffer per turn instead.
//
// A recording starts where the turn's first sample lands on the session's audio clock (the speech
// stream's end at the press), and takes the same frames the speech stream takes from then on, so
// its sample k is the clock's sample `start + k` and the witness's word times line up with the
// biased stream's. After the release it takes `tailMs` more of the microphone's audio, which the
// speech stream doesn't: the end of a word cut short by an early release. A recording that runs
// past the cap drops its audio at once and only counts on: its turn is skipped as `too_long`.
//
// Hands-free turns have no press: a recording runs while the engine streams and is cut at each turn
// end, so a turn's audio runs from the end of the turn before it.
import { TARGET_SAMPLE_RATE } from "../capture/dsp";
import { MAX_TURN_AUDIO_MS, TURN_AUDIO_TAIL_MS } from "./runner";

const SAMPLES_PER_MS = TARGET_SAMPLE_RATE / 1000;

/** One turn's audio, as the engine's `turn_audio` event carries it. */
export interface TurnAudio {
  /** Where the audio starts on the session's audio clock, in ms. */
  readonly startMs: number;
  /** How long it runs, in ms, tail included. */
  readonly durationMs: number;
  /** PCM16, mono, 16 kHz; null when the turn ran past the cap, which dropped it. */
  readonly pcm: Int16Array | null;
}

export class TurnAudioRecording {
  /** The session audio clock's sample the recording starts at. */
  readonly startSample: number;
  readonly #maxSamples: number;
  #chunks: Int16Array[] = [];
  #samples = 0;
  #tooLong = false;
  /** Samples still to take after the release; null until released. */
  #tailLeft: number | null = null;
  #complete = false;

  constructor(startSample: number, maxSamples: number) {
    this.startSample = startSample;
    this.#maxSamples = maxSamples;
  }

  /** Every sample it took, tail included, even past the cap. */
  get samples(): number {
    return this.#samples;
  }

  get complete(): boolean {
    return this.#complete;
  }

  get releasing(): boolean {
    return this.#tailLeft !== null && !this.#complete;
  }

  /** Takes `pcm`, up to the end of its tail. True if that completed it. */
  write(pcm: Int16Array): boolean {
    if (this.#complete || pcm.length === 0) return false;
    let take = pcm;
    if (this.#tailLeft !== null) {
      take = pcm.length > this.#tailLeft ? pcm.subarray(0, this.#tailLeft) : pcm;
      this.#tailLeft -= take.length;
    }
    this.#samples += take.length;
    if (!this.#tooLong) {
      if (this.#samples > this.#maxSamples) {
        this.#tooLong = true;
        this.#chunks = [];
      } else {
        this.#chunks.push(take.slice());
      }
    }
    if (this.#tailLeft === 0) this.#complete = true;
    return this.#complete;
  }

  /** Takes `tailSamples` more, then completes. True if that completed it already. */
  release(tailSamples: number): boolean {
    if (this.#complete || this.#tailLeft !== null) return this.#complete;
    this.#tailLeft = Math.max(0, Math.round(tailSamples));
    if (this.#tailLeft === 0) this.#complete = true;
    return this.#complete;
  }

  /** Completes it where it stands. */
  finish(): void {
    this.#complete = true;
  }

  /** The audio, joined; `pcm` is null when it ran past the cap. */
  audio(): TurnAudio {
    let pcm: Int16Array | null = null;
    if (!this.#tooLong) {
      pcm = new Int16Array(this.#samples);
      let offset = 0;
      for (const chunk of this.#chunks) {
        pcm.set(chunk, offset);
        offset += chunk.length;
      }
    }
    return {
      startMs: Math.round(this.startSample / SAMPLES_PER_MS),
      durationMs: Math.round(this.#samples / SAMPLES_PER_MS),
      pcm,
    };
  }
}

export interface TurnAudioRecorderOptions {
  /** Past this, a recording drops its audio (target 120 s). */
  readonly maxMs?: number;
  /** How long a released recording keeps taking audio (target 200 ms). */
  readonly tailMs?: number;
}

/**
 * The engine's recordings: at most one open (the turn being spoken), and any released ones still
 * taking their tail. Methods return the recordings they completed.
 */
export class TurnAudioRecorder {
  readonly #maxSamples: number;
  readonly #tailSamples: number;
  #open: TurnAudioRecording | undefined;
  #tails: TurnAudioRecording[] = [];

  constructor(options: TurnAudioRecorderOptions = {}) {
    this.#maxSamples = Math.round((options.maxMs ?? MAX_TURN_AUDIO_MS) * SAMPLES_PER_MS);
    this.#tailSamples = Math.round((options.tailMs ?? TURN_AUDIO_TAIL_MS) * SAMPLES_PER_MS);
  }

  /** The recording being spoken into, if any. */
  get current(): TurnAudioRecording | undefined {
    return this.#open;
  }

  /**
   * Starts a recording at `startSample`. A tail still running ends where it stands, since the
   * next turn's audio begins here, and so does a recording its owner left open.
   */
  open(startSample: number): { recording: TurnAudioRecording; completed: TurnAudioRecording[] } {
    const completed = this.#finishTails();
    if (this.#open && !this.#open.complete) {
      this.#open.finish();
      completed.push(this.#open);
    }
    this.#open = new TurnAudioRecording(startSample, this.#maxSamples);
    return { recording: this.#open, completed };
  }

  /**
   * Audio the engine captured, gated or not: to the open recording, which exists only while the
   * gate is open, so it takes exactly what the speech stream takes, and to every tail.
   */
  write(pcm: Int16Array): TurnAudioRecording[] {
    this.#open?.write(pcm);
    const completed: TurnAudioRecording[] = [];
    for (const tail of this.#tails) if (tail.write(pcm)) completed.push(tail);
    this.#tails = this.#tails.filter((tail) => !tail.complete);
    return completed;
  }

  /** Push-to-talk released: the open recording takes its tail, then completes. */
  release(): TurnAudioRecording[] {
    const recording = this.#open;
    this.#open = undefined;
    if (!recording) return [];
    if (recording.release(this.#tailSamples)) return [recording];
    this.#tails.push(recording);
    return [];
  }

  /** Completes the open recording now, without a tail: a hands-free turn's end. */
  cut(): TurnAudioRecording | undefined {
    const recording = this.#open;
    this.#open = undefined;
    recording?.finish();
    return recording;
  }

  /** Forgets the open recording: hands-free went quiet with no turn to give it to. */
  drop(): void {
    this.#open = undefined;
  }

  /** Completes everything now: the engine is stopping. */
  finish(): TurnAudioRecording[] {
    const completed = this.#finishTails();
    const open = this.cut();
    if (open) completed.push(open);
    return completed;
  }

  #finishTails(): TurnAudioRecording[] {
    const tails = this.#tails;
    this.#tails = [];
    for (const tail of tails) tail.finish();
    return tails;
  }
}
