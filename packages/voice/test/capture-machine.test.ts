import { describe, expect, it } from "vitest";
import { ENGINE_STATES, type EngineState, VOICE_ERROR_CODES } from "../src/codes";
import {
  CAPTURE_EVENTS,
  CAPTURE_STATES,
  type Capture,
  type CaptureEvent,
  type CaptureEventType,
  type CaptureState,
  captureErrorKind,
  captureTransition,
  initialCapture,
} from "../src/machines/capture";

const eventOf = (type: CaptureEventType): CaptureEvent => {
  switch (type) {
    case "mic_failed":
      return { type, code: "permission_denied" };
    case "engine_state":
      return { type, state: "recording" };
    case "engine_error":
      return { type, code: "provider_unavailable", retryable: true };
    default:
      return { type };
  }
};

const at = (state: CaptureState): Capture => ({
  state,
  context: {
    error:
      state === "permission_denied"
        ? "permission_denied"
        : state === "device_unavailable"
          ? "device_unavailable"
          : state === "provider_unavailable"
            ? "provider_unavailable"
            : null,
    notice: null,
  },
});

// Every (state, event) pair. `engine_state` is the engine reporting `recording` and
// `engine_error` a provider failure here; the tables below cover every engine state and code.
const TABLE: Record<CaptureState, Record<CaptureEventType, CaptureState>> = {
  idle: {
    arm: "requesting_permission",
    mic_granted: "idle",
    mic_failed: "idle",
    engine_state: "idle",
    engine_error: "idle",
    retry: "idle",
    disarm: "idle",
    reset: "idle",
  },
  requesting_permission: {
    arm: "requesting_permission",
    mic_granted: "starting",
    mic_failed: "permission_denied",
    engine_state: "requesting_permission",
    engine_error: "requesting_permission",
    retry: "requesting_permission",
    disarm: "idle",
    reset: "idle",
  },
  starting: {
    arm: "starting",
    mic_granted: "starting",
    mic_failed: "starting",
    engine_state: "recording",
    engine_error: "provider_unavailable",
    retry: "starting",
    disarm: "idle",
    reset: "idle",
  },
  armed: {
    arm: "armed",
    mic_granted: "armed",
    mic_failed: "armed",
    engine_state: "recording",
    engine_error: "provider_unavailable",
    retry: "armed",
    disarm: "idle",
    reset: "idle",
  },
  recording: {
    arm: "recording",
    mic_granted: "recording",
    mic_failed: "recording",
    engine_state: "recording",
    engine_error: "provider_unavailable",
    retry: "recording",
    disarm: "idle",
    reset: "idle",
  },
  finalizing: {
    arm: "finalizing",
    mic_granted: "finalizing",
    mic_failed: "finalizing",
    engine_state: "recording",
    engine_error: "provider_unavailable",
    retry: "finalizing",
    disarm: "idle",
    reset: "idle",
  },
  reconnecting: {
    arm: "reconnecting",
    mic_granted: "reconnecting",
    mic_failed: "reconnecting",
    engine_state: "recording",
    engine_error: "provider_unavailable",
    retry: "reconnecting",
    disarm: "idle",
    reset: "idle",
  },
  permission_denied: {
    arm: "requesting_permission",
    mic_granted: "permission_denied",
    mic_failed: "permission_denied",
    engine_state: "permission_denied",
    engine_error: "permission_denied",
    retry: "requesting_permission",
    disarm: "idle",
    reset: "idle",
  },
  device_unavailable: {
    arm: "requesting_permission",
    mic_granted: "device_unavailable",
    mic_failed: "device_unavailable",
    engine_state: "device_unavailable",
    engine_error: "device_unavailable",
    retry: "requesting_permission",
    disarm: "idle",
    reset: "idle",
  },
  provider_unavailable: {
    arm: "provider_unavailable",
    mic_granted: "provider_unavailable",
    mic_failed: "provider_unavailable",
    engine_state: "recording",
    engine_error: "provider_unavailable",
    retry: "armed",
    disarm: "idle",
    reset: "idle",
  },
};

/** Where each running state goes for each engine state: the engine's own decision, followed. */
const RUNNING = [
  "starting",
  "armed",
  "recording",
  "finalizing",
  "reconnecting",
  "provider_unavailable",
] as const;
const FOLLOW: Record<(typeof RUNNING)[number], Record<EngineState, CaptureState>> = {
  starting: {
    idle: "starting",
    starting: "starting",
    armed: "armed",
    recording: "recording",
    finalizing: "finalizing",
    reconnecting: "reconnecting",
    stopped: "idle",
  },
  armed: {
    idle: "armed",
    starting: "armed",
    armed: "armed",
    recording: "recording",
    finalizing: "finalizing",
    reconnecting: "reconnecting",
    stopped: "idle",
  },
  recording: {
    idle: "recording",
    starting: "recording",
    armed: "armed",
    recording: "recording",
    finalizing: "finalizing",
    reconnecting: "reconnecting",
    stopped: "idle",
  },
  finalizing: {
    idle: "finalizing",
    starting: "finalizing",
    armed: "armed",
    recording: "recording",
    finalizing: "finalizing",
    reconnecting: "reconnecting",
    stopped: "idle",
  },
  reconnecting: {
    idle: "reconnecting",
    starting: "reconnecting",
    armed: "armed",
    recording: "recording",
    finalizing: "finalizing",
    reconnecting: "reconnecting",
    stopped: "idle",
  },
  provider_unavailable: {
    idle: "provider_unavailable",
    starting: "provider_unavailable",
    // After giving up, the engine reports armed again: the error stays until the rep acts.
    armed: "provider_unavailable",
    recording: "recording",
    finalizing: "finalizing",
    reconnecting: "reconnecting",
    stopped: "idle",
  },
};

function run(events: CaptureEvent[], from: Capture = initialCapture) {
  let capture = from;
  const effects: string[] = [];
  for (const event of events) {
    const step = captureTransition(capture, event);
    capture = step.capture;
    effects.push(...step.effects.map((effect) => effect.type));
  }
  return { capture, effects };
}

const ARMED: CaptureEvent[] = [
  { type: "arm" },
  { type: "mic_granted" },
  { type: "engine_state", state: "starting" },
  { type: "engine_state", state: "armed" },
];

describe("the capture machine", () => {
  it("decides every (state, event) pair", () => {
    let pairs = 0;
    for (const state of CAPTURE_STATES) {
      for (const type of CAPTURE_EVENTS) {
        const next = captureTransition(at(state), eventOf(type)).capture.state;
        expect(`${state} + ${type} → ${next}`).toBe(`${state} + ${type} → ${TABLE[state][type]}`);
        pairs += 1;
      }
    }
    expect(pairs).toBe(CAPTURE_STATES.length * CAPTURE_EVENTS.length);
  });

  it("follows every engine state from every running state", () => {
    for (const state of RUNNING) {
      for (const engine of ENGINE_STATES) {
        const next = captureTransition(at(state), { type: "engine_state", state: engine }).capture
          .state;
        expect(`${state} + engine ${engine} → ${next}`).toBe(
          `${state} + engine ${engine} → ${FOLLOW[state][engine]}`,
        );
      }
    }
  });

  it("sorts every voice error into a microphone error, a provider error, or a notice", () => {
    const expected = {
      permission_denied: "permission_denied",
      permission_stuck: "device_unavailable",
      device_unavailable: "device_unavailable",
      audio_unavailable: "device_unavailable",
      credential_failed: "provider_unavailable",
      provider_rejected: "provider_unavailable",
      provider_unavailable: "provider_unavailable",
      provider_error: "armed",
      rate_limited: "armed",
      keyterms_rejected: "armed",
      vad_unavailable: "armed",
    } as const;
    for (const code of VOICE_ERROR_CODES) {
      const { capture, effects } = run(
        [{ type: "engine_error", code, retryable: true }],
        at("armed"),
      );
      expect(`${code} → ${capture.state}`).toBe(`${code} → ${expected[code]}`);
      const kind = captureErrorKind(code);
      expect(effects).toEqual(kind === "microphone" ? ["release"] : []);
      if (kind === "notice") expect(capture.context).toEqual({ error: null, notice: code });
      else expect(capture.context.error).toBe(code);
    }
  });

  it("arms, records, finalizes, and disarms", () => {
    const { capture, effects } = run([
      ...ARMED,
      { type: "engine_state", state: "recording" },
      { type: "engine_state", state: "finalizing" },
      { type: "engine_state", state: "armed" },
      { type: "disarm" },
    ]);
    expect(effects).toEqual(["request_mic", "start_engine", "release"]);
    expect(capture).toEqual(initialCapture);
  });

  it("shows a refused microphone until the rep tries again", () => {
    const denied = run([{ type: "arm" }, { type: "mic_failed", code: "permission_denied" }]);
    expect(denied.capture).toEqual({
      state: "permission_denied",
      context: { error: "permission_denied", notice: null },
    });
    const again = run([{ type: "retry" }, { type: "mic_granted" }], denied.capture);
    expect(again.capture).toEqual({ state: "starting", context: { error: null, notice: null } });
    expect(again.effects).toEqual(["request_mic", "start_engine"]);
  });

  it("keeps WebKit's stuck permission apart, for its own advice", () => {
    const { capture } = run([{ type: "arm" }, { type: "mic_failed", code: "permission_stuck" }]);
    expect(capture).toEqual({
      state: "device_unavailable",
      context: { error: "permission_stuck", notice: null },
    });
  });

  it("holds a provider error over the engine's armed state, and clears it on the next press", () => {
    const failed = run([
      ...ARMED,
      { type: "engine_state", state: "recording" },
      { type: "engine_state", state: "reconnecting" },
      { type: "engine_error", code: "provider_unavailable", retryable: true },
      { type: "engine_state", state: "armed" },
    ]);
    expect(failed.capture).toEqual({
      state: "provider_unavailable",
      context: { error: "provider_unavailable", notice: null },
    });
    const pressed = run([{ type: "engine_state", state: "recording" }], failed.capture);
    expect(pressed.capture).toEqual({ state: "recording", context: { error: null, notice: null } });
    expect(run([{ type: "retry" }], failed.capture).capture.state).toBe("armed");
  });

  it("releases everything when the engine can't capture", () => {
    const { capture, effects } = run([
      ...ARMED,
      { type: "engine_error", code: "audio_unavailable", retryable: false },
      { type: "engine_state", state: "stopped" },
    ]);
    expect(capture.state).toBe("device_unavailable");
    expect(effects.at(-1)).toBe("release");
  });

  it("ignores a stale engine's events once disarmed", () => {
    const { capture, effects } = run([
      ...ARMED,
      { type: "disarm" },
      { type: "engine_state", state: "armed" },
      { type: "engine_state", state: "recording" },
      { type: "engine_error", code: "provider_unavailable", retryable: true },
    ]);
    expect(capture).toEqual(initialCapture);
    expect(effects).toEqual(["request_mic", "start_engine", "release"]);
  });

  it("starts a new session clean (v1 carried state from one call into the next)", () => {
    const busy = run([
      ...ARMED,
      { type: "engine_error", code: "keyterms_rejected", retryable: false },
      { type: "engine_error", code: "provider_rejected", retryable: false },
    ]).capture;
    expect(busy.context).toEqual({ error: "provider_rejected", notice: "keyterms_rejected" });
    const reset = run([{ type: "reset" }], busy);
    expect(reset.capture).toEqual(initialCapture);
    expect(reset.effects).toEqual(["release"]);
    expect(run([{ type: "reset" }]).effects).toEqual([]);
  });
});
