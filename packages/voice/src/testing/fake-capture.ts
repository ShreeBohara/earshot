// A capture source a test drives by hand: it frames audio exactly as the worklet does (512-sample
// PCM16 frames, a partial frame on `flush()`), but at 16 kHz already and with no AudioContext.
import { FRAME_SAMPLES, FrameAssembler, TARGET_SAMPLE_RATE } from "../capture/dsp";
import type {
  CaptureFrame,
  CaptureSource,
  CaptureSourceFactory,
  CaptureSourceOptions,
} from "../capture/graph";

export class FakeCaptureSource implements CaptureSource {
  readonly sampleRate: number;
  readonly #listeners = new Set<(frame: CaptureFrame) => void>();
  readonly #framer: FrameAssembler;
  #phase = 0;
  /** What the engine passed when it started this source. */
  options: CaptureSourceOptions | undefined;
  flushes = 0;
  closed = false;

  constructor(sampleRate = 48_000) {
    this.sampleRate = sampleRate;
    this.#framer = new FrameAssembler(FRAME_SAMPLES, (pcm, rms, flush) => {
      const frame: CaptureFrame = { pcm, rms, flush };
      for (const listener of this.#listeners) listener(frame);
    });
  }

  /** A factory that starts this source, or fails with `error`. */
  factory(error?: unknown): CaptureSourceFactory {
    return async (options) => {
      if (error !== undefined) throw error;
      this.options = options;
      return this;
    };
  }

  onFrame(listener: (frame: CaptureFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Captures `ms` of a 440 Hz tone at `amplitude` (0 is silence), framing as it goes. */
  speak(ms: number, amplitude = 0.3): void {
    const samples = Math.round((ms * TARGET_SAMPLE_RATE) / 1000);
    const block = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      block[i] = amplitude * Math.sin(this.#phase);
      this.#phase += (2 * Math.PI * 440) / TARGET_SAMPLE_RATE;
    }
    if (!this.closed) this.#framer.push(block);
  }

  /** Captures `ms` of silence. */
  silence(ms: number): void {
    this.speak(ms, 0);
  }

  /** Answers on a microtask, as the worklet answers over its port. */
  flush(): void {
    this.flushes += 1;
    queueMicrotask(() => {
      if (!this.closed) this.#framer.flush();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.#listeners.clear();
  }
}
