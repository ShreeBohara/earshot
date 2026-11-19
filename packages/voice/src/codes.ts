// The voice engine's states and error codes. Plain data with no DOM types, so the pure machines
// (and the edge Worker, which imports them) can name them too.

/**
 * What a voice engine is doing, as its `state` events report it:
 * - `idle`: made, not started.
 * - `starting`: `start()` is setting up the audio graph.
 * - `armed`: capturing, but sending nothing: push-to-talk is up, or hands-free hears silence.
 * - `recording`: sending audio: push-to-talk is down, or hands-free hears speech.
 * - `finalizing`: push-to-talk was released; waiting for the turn's last transcript.
 * - `reconnecting`: the speech socket dropped while it was needed. Audio is buffered meanwhile
 *   and replayed once a new socket opens.
 * - `stopped`: `stop()` finished, or a fatal error ended the engine. Make a new one to go again.
 */
export const ENGINE_STATES = [
  "idle",
  "starting",
  "armed",
  "recording",
  "finalizing",
  "reconnecting",
  "stopped",
] as const;
export type EngineState = (typeof ENGINE_STATES)[number];

/**
 * Why the voice engine failed. Each `error` event says whether trying again can help.
 * - `permission_denied`: the user or the browser refused the microphone.
 * - `permission_stuck`: the microphone failed although permission reads as granted. On Safari
 *   26.3–26.6 this is WebKit bug 319706: quitting and reopening Safari fixes it.
 * - `device_unavailable`: no microphone, it's in use, or the page isn't a secure context.
 * - `audio_unavailable`: the AudioContext or the capture worklet failed to start.
 * - `credential_failed`: minting a temporary provider credential failed.
 * - `provider_rejected`: the provider refused the credential or the request.
 * - `provider_unavailable`: the provider couldn't be reached, or reconnects ran out.
 * - `provider_error`: the provider reported an error mid-stream.
 * - `rate_limited`: the provider refused for rate, such as AssemblyAI's 5 new streams a minute.
 * - `keyterms_rejected`: the provider refused a keyterm update. The old list stays in force.
 * - `vad_unavailable`: hands-free's voice activity detector failed to load. Hands-free keeps
 *   streaming, with the provider's endpointing alone and no silence cutoff.
 */
export const VOICE_ERROR_CODES = [
  "permission_denied",
  "permission_stuck",
  "device_unavailable",
  "audio_unavailable",
  "credential_failed",
  "provider_rejected",
  "provider_unavailable",
  "provider_error",
  "rate_limited",
  "keyterms_rejected",
  "vad_unavailable",
] as const;
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number];

/** How a turn's speech ended, as `turn_end` reports it. The same values as `TurnTrigger` in core. */
export type TurnTrigger = "ptt_release" | "provider_eot" | "manual";

/** How the rep captures speech. */
export type CaptureMode = "push_to_talk" | "hands_free";
