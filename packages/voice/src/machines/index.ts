// `@earshot/voice/machines`: pure reducers with no DOM types, imported by the browser and by the
// edge Worker. test/no-dom.test.ts typechecks this entry without the DOM library. WP8 adds the
// capture, connection, autoMute, retry, and silentResponse machines here.
export {
  type CaptureMode,
  ENGINE_STATES,
  type EngineState,
  type TurnTrigger,
  VOICE_ERROR_CODES,
  type VoiceErrorCode,
} from "../codes";
export { type BackoffOptions, backoffDelay } from "./backoff";
export {
  initialSpeechSocket,
  SPEECH_SOCKET_EVENTS,
  SPEECH_SOCKET_STATES,
  type SpeechSocket,
  type SpeechSocketContext,
  type SpeechSocketEffect,
  type SpeechSocketEvent,
  type SpeechSocketEventType,
  type SpeechSocketPolicy,
  type SpeechSocketState,
  type SpeechSocketStep,
  speechSocketTransition,
} from "./speech-socket";
