// The second witness in the browser (Phase 4 spec WP9; ADR-0029): the runner interface, the Groq
// Whisper client, the WAV encoder, and the per-turn audio recorder the Debrief engine keeps.
export {
  createGroqWitness,
  GROQ_DEFAULT_RETRY_WAIT_MS,
  GROQ_MAX_RETRY_WAIT_MS,
  GROQ_REQUEST_TIMEOUT_MS,
  GROQ_TRANSCRIPTIONS_URL,
  type GroqWitnessOptions,
  groqUtterance,
  retryAfterMs,
  UNKNOWN_CONFIDENCE,
  type WitnessLog,
} from "./groq";
export {
  isTranscribed,
  MAX_TURN_AUDIO_MS,
  MIN_WITNESS_AUDIO_MS,
  type TranscribeOptions,
  TURN_AUDIO_TAIL_MS,
  type UnbiasedUtterance,
  WITNESS_MODEL,
  WITNESS_PROVIDER,
  type WitnessFailure,
  type WitnessResult,
  type WitnessRunner,
} from "./runner";
export {
  type TurnAudio,
  TurnAudioRecorder,
  type TurnAudioRecorderOptions,
  TurnAudioRecording,
} from "./turn-audio";
export { audioMsOf, encodeWav, WAV_HEADER_BYTES } from "./wav";
