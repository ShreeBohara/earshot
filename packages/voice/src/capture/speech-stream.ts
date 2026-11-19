// The speech stream: the 16 kHz PCM16 audio meant for the speech-to-text provider, in order, with
// the last 60 s kept for replay (spec WP4 step 3). Only gated audio enters it: audio captured
// while push-to-talk is held, or while hands-free mode is streaming. Its sample index is the
// session's audio clock, so a word at sample 48,000 is at 3,000 ms of session audio, and every
// transcript time in `utterance.final` is on this clock.
//
// A socket reads from the stream through a cursor, the index of its next unsent sample. Live
// audio and replay after a reconnect are the same operation: send from the cursor to the end.
import { TARGET_SAMPLE_RATE } from "./dsp";
import { PcmRingBuffer } from "./ring-buffer";

/** A message: two 32 ms frames, 64 ms at 16 kHz (spec decision 4; AssemblyAI takes 20–1000 ms). */
export const MESSAGE_SAMPLES = 1_024;
/** The shortest message a provider accepts: AssemblyAI's 20 ms floor. */
export const MIN_MESSAGE_SAMPLES = 320;
/** The replay window: 60 s, about 1.9 MB (target). */
export const RING_SECONDS = 60;

/** Samples to session audio ms, rounded down. */
export function samplesToMs(samples: number, rate = TARGET_SAMPLE_RATE): number {
  return Math.floor((samples * 1000) / rate);
}

/** Session audio ms to samples. */
export function msToSamples(ms: number, rate = TARGET_SAMPLE_RATE): number {
  return Math.round((ms * rate) / 1000);
}

export interface SpeechStreamOptions {
  readonly ringSeconds?: number;
  readonly messageSamples?: number;
  readonly minMessageSamples?: number;
}

export interface TakeResult {
  /** The messages to send, in order. */
  readonly messages: readonly Int16Array[];
  /** The cursor after them. */
  readonly cursor: number;
  /** Samples between the old cursor and the ring's start that had already dropped off. */
  readonly skipped: number;
  /** Samples of silence appended to the stream to bring a flushed remainder up to the minimum. */
  readonly padded: number;
}

export class SpeechStream {
  readonly messageSamples: number;
  readonly minMessageSamples: number;
  readonly #ring: PcmRingBuffer;

  constructor(options: SpeechStreamOptions = {}) {
    this.messageSamples = options.messageSamples ?? MESSAGE_SAMPLES;
    this.minMessageSamples = options.minMessageSamples ?? MIN_MESSAGE_SAMPLES;
    if (this.minMessageSamples > this.messageSamples) {
      throw new RangeError("minMessageSamples can't exceed messageSamples");
    }
    this.#ring = new PcmRingBuffer((options.ringSeconds ?? RING_SECONDS) * TARGET_SAMPLE_RATE);
  }

  /** The stream's length in samples: the session audio clock. */
  get end(): number {
    return this.#ring.end;
  }

  /** The oldest sample still available for replay. */
  get start(): number {
    return this.#ring.start;
  }

  append(pcm: Int16Array): void {
    if (pcm.length > 0) this.#ring.write(pcm);
  }

  /** A copy of samples `[from, to)`, clipped to what's still held. */
  read(from: number, to = this.end): Int16Array {
    return this.#ring.read(from, to);
  }

  /**
   * The messages that move a socket's cursor forward: whole 64 ms messages only, unless `flush`
   * is set, in which case the remainder goes too. A remainder shorter than the 20 ms minimum is
   * padded with silence, and the silence is appended to the stream as well, so the provider's
   * clock and the session's stay in step.
   */
  take(cursor: number, flush: boolean): TakeResult {
    const from = Math.max(cursor, this.start);
    const skipped = from - cursor;
    let pending = this.end - from;
    let padded = 0;
    if (flush && pending > 0 && pending % this.messageSamples !== 0) {
      const remainder = pending % this.messageSamples;
      if (remainder < this.minMessageSamples) {
        padded = this.minMessageSamples - remainder;
        this.append(new Int16Array(padded));
        pending += padded;
      }
    }
    const messages: Int16Array[] = [];
    let at = from;
    while (pending - (at - from) >= this.messageSamples) {
      messages.push(this.read(at, at + this.messageSamples));
      at += this.messageSamples;
    }
    if (flush && at < this.end) {
      messages.push(this.read(at, this.end));
      at = this.end;
    }
    return { messages, cursor: at, skipped, padded };
  }
}
