// Hands-free voice activity detection (spec WP4 step 7): @ricky0123/vad-web 0.0.31 running Silero
// v6, loaded with a dynamic import only when the rep turns hands-free on, so neither it nor
// onnxruntime-web is in the main bundle (test/bundle.test.ts checks). The provider's endpointing
// still decides turns; the VAD drives UI state and lets the engine close the socket after a long
// silence, which is where AssemblyAI's socket-time billing saves money.
//
// - `model: "v6"`: vad-web defaults to "legacy" (96 ms frames and the oldest weights).
// - The assets are self-hosted under /vad/, copied from node_modules by `earshot-voice-assets`;
//   nothing is fetched from a CDN. onnxruntime-web is pinned at 1.31.1 in package.json so its JS
//   glue and the copied wasm stay in lockstep.
// - One thread: ORT's threaded wasm needs cross-origin isolation, and Silero's 512-sample frames
//   run fine on one, so no COOP/COEP headers are needed.
// - The shared stream belongs to the session. vad-web's defaults stop its tracks on pause and ask
//   for the mic again on resume; both are overridden.

/** Where the web app serves the VAD and onnxruntime files. */
export const VAD_ASSET_PATH = "/vad/";

export interface HandsFreeVad {
  start(): Promise<void>;
  pause(): Promise<void>;
  destroy(): Promise<void>;
}

export interface HandsFreeVadOptions {
  readonly stream: MediaStream;
  /** Shares the capture graph's context, so the VAD adds no second audio thread. */
  readonly audioContext?: AudioContext;
  /** Where the model and vad-web's worklet are served. */
  readonly assetPath?: string;
  /** Where onnxruntime-web's wasm and glue are served, when not beside the model. */
  readonly wasmPath?: string;
  /** Silence before speech counts as over, in ms (spec: about 1,000–1,400). */
  readonly redemptionMs?: number;
  readonly onSpeechStart: () => void;
  /** Speech ended, or turned out too short to be speech. */
  readonly onSpeechEnd: () => void;
  /** Every 32 ms frame's speech probability, for a meter or a test. */
  readonly onFrameProcessed?: (speechProbability: number) => void;
}

export type HandsFreeVadFactory = (options: HandsFreeVadOptions) => Promise<HandsFreeVad>;

export const loadHandsFreeVad: HandsFreeVadFactory = async (options) => {
  const { MicVAD } = await import("@ricky0123/vad-web");
  const assetPath = options.assetPath ?? VAD_ASSET_PATH;
  const vad = await MicVAD.new({
    model: "v6",
    startOnLoad: false,
    baseAssetPath: assetPath,
    onnxWASMBasePath: options.wasmPath ?? assetPath,
    ...(options.audioContext ? { audioContext: options.audioContext } : {}),
    getStream: async () => options.stream,
    pauseStream: async () => {},
    resumeStream: async () => options.stream,
    redemptionMs: options.redemptionMs ?? 1_200,
    ortConfig: (ort) => {
      ort.env.logLevel = "error";
      ort.env.wasm.numThreads = 1;
    },
    onSpeechStart: () => options.onSpeechStart(),
    onSpeechEnd: () => options.onSpeechEnd(),
    onVADMisfire: () => options.onSpeechEnd(),
    onFrameProcessed: (probabilities) => options.onFrameProcessed?.(probabilities.isSpeech),
  });
  return {
    start: () => vad.start(),
    pause: () => vad.pause(),
    destroy: () => vad.destroy(),
  };
};
