// `@earshot/voice`: the browser voice runtime. The pure parts have their own entries:
// `@earshot/voice/machines` and `@earshot/voice/prices` (no DOM, for the edge Worker too), and
// `@earshot/voice/testing` (fakes, never in production).

// Capture
export {
  createResampler,
  FirDecimator,
  FRAME_SAMPLES,
  FrameAssembler,
  floatToInt16,
  levelFromRms,
  PolyphaseResampler,
  type Resampler,
  rms,
  TARGET_SAMPLE_RATE,
} from "./capture/dsp";
export {
  CAPTURE_WORKLET_PATH,
  type CaptureFrame,
  type CaptureSource,
  type CaptureSourceFactory,
  type CaptureSourceOptions,
  createAudioContext,
  startCaptureGraph,
} from "./capture/graph";
export {
  type AudioSessionLike,
  browserMicrophoneEnvironment,
  MIC_CONSTRAINTS,
  type Microphone,
  type MicrophoneEnvironment,
  openMicrophone,
} from "./capture/microphone";
export { CAPTURE_PROCESSOR_NAME } from "./capture/protocol";
export { PcmRingBuffer } from "./capture/ring-buffer";
export {
  MESSAGE_SAMPLES,
  MIN_MESSAGE_SAMPLES,
  msToSamples,
  RING_SECONDS,
  SpeechStream,
  samplesToMs,
} from "./capture/speech-stream";
// The engine
export {
  type CaptureMode,
  ENGINE_STATES,
  type EngineState,
  type TurnTrigger,
  VOICE_ERROR_CODES,
  type VoiceErrorCode,
} from "./codes";
export type {
  VoiceEngine,
  VoiceEngineStartOptions,
  VoiceEvent,
  VoiceEventOf,
} from "./engine";
export {
  createDebriefEngine,
  DebriefEngine,
  type DebriefEngineOptions,
} from "./engines/debrief";
export { isVoiceError, VoiceError, type VoiceErrorOptions } from "./errors";
// Speech-to-text
export {
  type SttAdapter,
  type SttAdapterId,
  SttConnectError,
  type SttConnection,
  type SttConnectOptions,
  type SttErrorCode,
  type SttEvent,
  type SttLimits,
  type SttUsage,
  type TempCredential,
  type TempCredentialProvider,
} from "./stt/adapter";
export {
  ASSEMBLYAI_MODEL,
  ASSEMBLYAI_ORIGIN,
  ASSEMBLYAI_PATH,
  type AssemblyAiOptions,
  createAssemblyAiAdapter,
} from "./stt/assemblyai";
export { providerSocketUrl } from "./stt/credential";
export { DEEPGRAM_ORIGIN } from "./stt/deepgram";
export {
  createDeepgramFluxAdapter,
  DEEPGRAM_FLUX_MODEL,
  DEEPGRAM_FLUX_PATH,
  type DeepgramFluxOptions,
} from "./stt/deepgram-flux";
export {
  createDeepgramNova3Adapter,
  DEEPGRAM_NOVA3_MODEL,
  DEEPGRAM_NOVA3_PATH,
  type DeepgramNova3Options,
} from "./stt/deepgram-nova3";
export {
  ASSEMBLYAI_KEYTERM_LIMITS,
  DEEPGRAM_KEYTERM_LIMITS,
  estimateKeytermTokens,
  type KeytermLimits,
  type KeytermPlan,
  normalizeKeyterm,
  prepareKeyterms,
} from "./stt/keyterms";
export { type ProviderWord, toUtterances, type UtteranceOptions } from "./stt/normalize";
export {
  type Clock,
  createBrowserSocket,
  type SocketFactory,
  type SocketLike,
  systemClock,
} from "./stt/socket";
// Hands-free
export {
  type HandsFreeVad,
  type HandsFreeVadFactory,
  type HandsFreeVadOptions,
  loadHandsFreeVad,
  VAD_ASSET_PATH,
} from "./vad/hands-free";
