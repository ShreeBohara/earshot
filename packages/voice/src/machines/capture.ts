// What the capture screen shows (spec WP8 `capture`), as a pure reducer: idle, asking for the
// microphone, starting, armed, recording, finalizing, and the error states (permission denied,
// device unavailable, provider unavailable) plus reconnecting.
//
// It doesn't model the speech socket. The Debrief engine already runs the speech-socket machine
// (`speech-socket.ts`) and reports the result as `state` events: armed, recording, finalizing,
// reconnecting. This machine follows those, and adds what only the screen knows: the Arm click,
// the permission prompt, and which error to show until the rep acts.

import type { EngineState, VoiceErrorCode } from "../codes";

export const CAPTURE_STATES = [
  "idle",
  "requesting_permission",
  "starting",
  "armed",
  "recording",
  "finalizing",
  "reconnecting",
  "permission_denied",
  "device_unavailable",
  "provider_unavailable",
] as const;
export type CaptureState = (typeof CAPTURE_STATES)[number];

export const CAPTURE_EVENTS = [
  "arm",
  "mic_granted",
  "mic_failed",
  "engine_state",
  "engine_error",
  "retry",
  "disarm",
  "reset",
] as const;
export type CaptureEventType = (typeof CAPTURE_EVENTS)[number];

export type CaptureEvent =
  /** The rep clicked Arm (a user gesture, so the AudioContext may start). */
  | { readonly type: "arm" }
  | { readonly type: "mic_granted" }
  /** `openMicrophone` failed with this code. */
  | { readonly type: "mic_failed"; readonly code: VoiceErrorCode }
  /** The voice engine's `state` event. */
  | { readonly type: "engine_state"; readonly state: EngineState }
  /** The voice engine's `error` event. */
  | { readonly type: "engine_error"; readonly code: VoiceErrorCode; readonly retryable: boolean }
  /** The rep asked to try again from an error state. */
  | { readonly type: "retry" }
  /** The rep stopped capture. */
  | { readonly type: "disarm" }
  /** A new session: back to idle with nothing carried over. */
  | { readonly type: "reset" };

export type CaptureEffect =
  /** Ask for the microphone (`openMicrophone`). */
  | { readonly type: "request_mic" }
  /** Start the voice engine on the granted stream. */
  | { readonly type: "start_engine" }
  /** Stop the engine and release the microphone, whatever is running. */
  | { readonly type: "release" };

export interface CaptureContext {
  /** Why capture is in an error state. */
  readonly error: VoiceErrorCode | null;
  /** A problem worth showing that doesn't stop capture: keyterms refused, no VAD, a rate limit. */
  readonly notice: VoiceErrorCode | null;
}

export interface Capture {
  readonly state: CaptureState;
  readonly context: CaptureContext;
}

export interface CaptureStep {
  readonly capture: Capture;
  readonly effects: readonly CaptureEffect[];
}

const CLEAR: CaptureContext = { error: null, notice: null };

export const initialCapture: Capture = { state: "idle", context: CLEAR };

/** How an error code moves the screen: to a microphone error, a provider error, or a notice. */
export type CaptureErrorKind = "microphone" | "provider" | "notice";

export function captureErrorKind(code: VoiceErrorCode): CaptureErrorKind {
  switch (code) {
    case "permission_denied":
    case "permission_stuck":
    case "device_unavailable":
    case "audio_unavailable":
      return "microphone";
    case "provider_rejected":
    case "provider_unavailable":
    case "credential_failed":
      return "provider";
    case "rate_limited":
    case "provider_error":
    case "keyterms_rejected":
    case "vad_unavailable":
      return "notice";
  }
}

/** The microphone error state for a code: a refusal, or everything else that broke capture. */
function microphoneState(code: VoiceErrorCode): CaptureState {
  return code === "permission_denied" ? "permission_denied" : "device_unavailable";
}

/** The states in which the engine is running and its `state` events steer the screen. */
const RUNNING: ReadonlySet<CaptureState> = new Set([
  "starting",
  "armed",
  "recording",
  "finalizing",
  "reconnecting",
  "provider_unavailable",
]);

const step = (
  state: CaptureState,
  context: CaptureContext,
  effects: CaptureEffect[] = [],
): CaptureStep => ({ capture: { state, context }, effects });

/** The next state, and the effects to perform, for one event. Every pair is decided. */
export function captureTransition(capture: Capture, event: CaptureEvent): CaptureStep {
  const { state, context } = capture;
  const same = step(state, context);

  if (event.type === "reset") {
    return step(
      "idle",
      CLEAR,
      RUNNING.has(state) || state === "requesting_permission" ? [{ type: "release" }] : [],
    );
  }

  switch (state) {
    case "idle":
      return event.type === "arm"
        ? step("requesting_permission", CLEAR, [{ type: "request_mic" }])
        : same;

    case "requesting_permission":
      switch (event.type) {
        case "mic_granted":
          return step("starting", context, [{ type: "start_engine" }]);
        case "mic_failed":
          return step(microphoneState(event.code), { ...context, error: event.code });
        case "disarm":
          return step("idle", CLEAR, [{ type: "release" }]);
        default:
          return same; // no engine yet, so its events are stale
      }

    case "permission_denied":
    case "device_unavailable":
      switch (event.type) {
        case "arm":
        case "retry":
          return step("requesting_permission", CLEAR, [{ type: "request_mic" }]);
        case "disarm":
          return step("idle", CLEAR);
        default:
          return same; // nothing is running
      }

    case "starting":
    case "armed":
    case "recording":
    case "finalizing":
    case "reconnecting":
    case "provider_unavailable":
      switch (event.type) {
        case "engine_state":
          return followEngine(capture, event.state);
        case "engine_error": {
          const kind = captureErrorKind(event.code);
          if (kind === "microphone") {
            return step(microphoneState(event.code), { ...context, error: event.code }, [
              { type: "release" },
            ]);
          }
          // A provider error leaves the engine armed with its speech socket suspended; the next
          // press retries it.
          return kind === "provider"
            ? step("provider_unavailable", { ...context, error: event.code })
            : step(state, { ...context, notice: event.code });
        }
        case "retry":
          return state === "provider_unavailable"
            ? step("armed", { ...context, error: null })
            : same;
        case "disarm":
          return step("idle", CLEAR, [{ type: "release" }]);
        default:
          return same;
      }
  }
}

/** Follows the engine's own state, which the speech-socket machine already decided. */
function followEngine(capture: Capture, engine: EngineState): CaptureStep {
  const { state, context } = capture;
  switch (engine) {
    case "armed":
      // After a provider error the engine reports armed again; keep the error up until the rep acts.
      return state === "provider_unavailable" ? step(state, context) : step("armed", context);
    case "recording":
    case "finalizing":
    case "reconnecting":
      return step(engine, { ...context, error: null });
    case "stopped":
      return step("idle", CLEAR);
    case "idle":
    case "starting":
      return step(state, context);
  }
}
