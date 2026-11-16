// The capture graph (spec WP4 step 1): the shared microphone stream into the pcm16-capture
// worklet, at the AudioContext's native rate.
import { VoiceError } from "../errors";
import { CAPTURE_PROCESSOR_NAME, type WorkletInbound, type WorkletOutbound } from "./protocol";

/** Where the web app serves the built worklet (written by `earshot-voice-assets`). */
export const CAPTURE_WORKLET_PATH = "/voice/pcm16-capture.worklet.js";

/** A frame of 16 kHz PCM16 from the capture graph. */
export interface CaptureFrame {
  readonly pcm: Int16Array;
  /** RMS of the frame, 0 to 1. */
  readonly rms: number;
  /** True for the frame that answers `flush()`: shorter than 512 samples, possibly empty. */
  readonly flush: boolean;
}

/** Where frames come from: the worklet graph in the browser, or a scripted source in tests. */
export interface CaptureSource {
  /** The native rate the audio is captured at, before resampling to 16 kHz. */
  readonly sampleRate: number;
  /** The AudioContext behind it, which hands-free's VAD shares. */
  readonly audioContext?: AudioContext;
  onFrame(listener: (frame: CaptureFrame) => void): () => void;
  /** Asks for the partial frame now. The answer is a frame with `flush: true`. */
  flush(): void;
  /** Stops processing and closes the AudioContext. */
  close(): Promise<void>;
}

export interface CaptureSourceOptions {
  readonly stream: MediaStream;
  readonly audioContext?: AudioContext;
  readonly workletUrl: string | URL;
}

export type CaptureSourceFactory = (options: CaptureSourceOptions) => Promise<CaptureSource>;

/**
 * A new AudioContext at the device's native rate. Never pass `sampleRate`: on iOS a 16 kHz context
 * delivers about 75% of the samples it should (WebKit bug 251350). Call it inside the Arm click,
 * so the context may start without a further gesture.
 */
export function createAudioContext(): AudioContext {
  const context = new AudioContext();
  // Resuming inside the gesture covers browsers that create the context suspended anyway.
  void context.resume().catch(() => {});
  return context;
}

/**
 * Starts the worklet graph on `stream`. The worklet's output feeds the destination as silence,
 * which keeps it pulled in every browser. The returned source owns the AudioContext; the stream
 * stays the caller's.
 */
export const startCaptureGraph: CaptureSourceFactory = async (options) => {
  const context = options.audioContext ?? createAudioContext();
  try {
    if (context.state === "suspended") await context.resume();
    await context.audioWorklet.addModule(String(options.workletUrl));
    const source = context.createMediaStreamSource(options.stream);
    const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    source.connect(node);
    node.connect(context.destination);
    return new WorkletCaptureSource(context, source, node);
  } catch (error) {
    await context.close().catch(() => {});
    throw new VoiceError("audio_unavailable", "the capture worklet failed to start", {
      retryable: true,
      cause: error,
    });
  }
};

class WorkletCaptureSource implements CaptureSource {
  readonly audioContext: AudioContext;
  readonly #source: MediaStreamAudioSourceNode;
  readonly #node: AudioWorkletNode;
  readonly #listeners = new Set<(frame: CaptureFrame) => void>();
  #closed = false;

  constructor(context: AudioContext, source: MediaStreamAudioSourceNode, node: AudioWorkletNode) {
    this.audioContext = context;
    this.#source = source;
    this.#node = node;
    node.port.onmessage = (event: MessageEvent<WorkletOutbound>) => {
      const message = event.data;
      if (message.type !== "frame") return;
      const frame: CaptureFrame = {
        pcm: new Int16Array(message.pcm),
        rms: message.rms,
        flush: message.flush,
      };
      for (const listener of this.#listeners) listener(frame);
    };
  }

  get sampleRate(): number {
    return this.audioContext.sampleRate;
  }

  onFrame(listener: (frame: CaptureFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  flush(): void {
    if (!this.#closed) this.#post({ type: "flush" });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#post({ type: "stop" });
    this.#node.port.onmessage = null;
    this.#source.disconnect();
    this.#node.disconnect();
    this.#listeners.clear();
    await this.audioContext.close().catch(() => {});
  }

  #post(message: WorkletInbound): void {
    this.#node.port.postMessage(message);
  }
}
