// The pcm16-capture AudioWorklet (spec WP4 step 2). It runs on the audio thread at the
// AudioContext's native rate, filters and resamples to 16 kHz, and posts 512-sample PCM16 frames
// (32 ms) with their RMS level, transferring each buffer.
//
// This file runs in AudioWorkletGlobalScope, not the page. Next.js can't bundle a worklet from a
// TypeScript source package, so `earshot-voice-assets` builds it with esbuild into the web app's
// public/voice/ (CAPTURE_WORKLET_PATH). Vite serves it straight from source in the browser tests.
import { createResampler, FRAME_SAMPLES, FrameAssembler } from "./dsp";
import { CAPTURE_PROCESSOR_NAME, type WorkletFrameMessage, type WorkletInbound } from "./protocol";

// AudioWorkletGlobalScope, which TypeScript ships no lib for.
declare const sampleRate: number;
interface WorkletProcessor {
  readonly port: MessagePort;
}
declare const AudioWorkletProcessor: {
  prototype: WorkletProcessor;
  new (): WorkletProcessor;
};
declare function registerProcessor(
  name: string,
  processor: new () => WorkletProcessor & { process(inputs: Float32Array[][]): boolean },
): void;

class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  readonly #resampler = createResampler(sampleRate);
  #scratch = new Float32Array(this.#resampler.maxOutput(128));
  readonly #framer: FrameAssembler;
  #stopped = false;

  constructor() {
    super();
    this.#framer = new FrameAssembler(FRAME_SAMPLES, (pcm, rms, flush) => {
      const message: WorkletFrameMessage = { type: "frame", pcm: pcm.buffer, rms, flush };
      this.port.postMessage(message, [pcm.buffer]);
    });
    this.port.onmessage = (event: MessageEvent<WorkletInbound>) => {
      if (event.data.type === "flush") this.#framer.flush();
      else if (event.data.type === "stop") this.#stopped = true;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.#stopped) return false;
    // One input, down-mixed to mono by the node's channelCount of 1. It has no channels while the
    // source is silent or ended.
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      const needed = this.#resampler.maxOutput(channel.length);
      if (this.#scratch.length < needed) this.#scratch = new Float32Array(needed);
      const count = this.#resampler.process(channel, this.#scratch);
      this.#framer.push(this.#scratch, count);
    }
    return true;
  }
}

registerProcessor(CAPTURE_PROCESSOR_NAME, Pcm16CaptureProcessor);
