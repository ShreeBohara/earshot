import { describe, expect, it } from "vitest";
import {
  initialSilentResponse,
  isAudioOutputSafe,
  SILENT_RESPONSE_EVENTS,
  SILENT_RESPONSE_STATES,
  type SilentResponse,
  type SilentResponseEvent,
  type SilentResponseEventType,
  type SilentResponseState,
  silentResponseTransition,
} from "../src/machines/silent-response";

const eventOf = (type: SilentResponseEventType): SilentResponseEvent => {
  switch (type) {
    case "turn_sent":
      return { type, turnId: "t2" };
    case "completed":
      return { type, turnId: "t1", outcome: "nothing_to_propose" };
    case "output":
      return { type, safe: true };
    default:
      return { type };
  }
};

const at = (state: SilentResponseState): SilentResponse => ({
  state,
  context: { turnId: state === "idle" ? null : "t1", outputSafe: true },
});

// Every (state, event) pair. `completed` is for the turn being followed, with nothing proposed.
const TABLE: Record<SilentResponseState, Record<SilentResponseEventType, SilentResponseState>> = {
  idle: {
    turn_sent: "waiting",
    completed: "idle",
    timeout: "idle",
    output: "idle",
    reset: "idle",
  },
  waiting: {
    turn_sent: "waiting",
    completed: "idle",
    timeout: "timed_out",
    output: "waiting",
    reset: "idle",
  },
  timed_out: {
    turn_sent: "waiting",
    completed: "idle",
    timeout: "timed_out",
    output: "timed_out",
    reset: "idle",
  },
};

function run(events: SilentResponseEvent[], from: SilentResponse = initialSilentResponse) {
  let machine = from;
  const effects: string[] = [];
  for (const event of events) {
    const step = silentResponseTransition(machine, event);
    machine = step.silentResponse;
    for (const effect of step.effects) {
      if (effect.type === "notify") {
        effects.push(
          `notify:${effect.turnId}:${effect.reason}:${effect.chime ? "chime" : "quiet"}`,
        );
      } else if (effect.type === "start_timer") effects.push(`start_timer:${effect.delayMs}`);
      else effects.push(effect.type);
    }
  }
  return { machine, effects };
}

const SAFE: SilentResponseEvent = { type: "output", safe: true };
const UNSAFE: SilentResponseEvent = { type: "output", safe: false };

describe("the silentResponse machine", () => {
  it("decides every (state, event) pair", () => {
    let pairs = 0;
    for (const state of SILENT_RESPONSE_STATES) {
      for (const type of SILENT_RESPONSE_EVENTS) {
        const next = silentResponseTransition(at(state), eventOf(type)).silentResponse.state;
        expect(`${state} + ${type} → ${next}`).toBe(`${state} + ${type} → ${TABLE[state][type]}`);
        pairs += 1;
      }
    }
    expect(pairs).toBe(SILENT_RESPONSE_STATES.length * SILENT_RESPONSE_EVENTS.length);
  });

  it("chimes when a turn ends with nothing to propose and output is safe", () => {
    const { machine, effects } = run([
      SAFE,
      { type: "turn_sent", turnId: "t1" },
      { type: "completed", turnId: "t1", outcome: "nothing_to_propose" },
    ]);
    expect(effects).toEqual([
      "start_timer:4000",
      "cancel_timer",
      "notify:t1:nothing_to_propose:chime",
    ]);
    expect(machine.state).toBe("idle");
  });

  it("adds the feed row without the chime while output isn't safe (iOS, mic live)", () => {
    const { effects } = run([
      UNSAFE,
      { type: "turn_sent", turnId: "t1" },
      { type: "completed", turnId: "t1", outcome: "nothing_to_propose" },
    ]);
    expect(effects.at(-1)).toBe("notify:t1:nothing_to_propose:quiet");
  });

  it("says so when nothing arrives in 4 s, and doesn't chime twice for the turn", () => {
    const { effects } = run([
      SAFE,
      { type: "turn_sent", turnId: "t1" },
      { type: "timeout" },
      { type: "completed", turnId: "t1", outcome: "nothing_to_propose" },
    ]);
    expect(effects).toEqual([
      "start_timer:4000",
      "notify:t1:timeout:chime",
      "notify:t1:nothing_to_propose:quiet",
    ]);
  });

  it("stays quiet for proposals and for errors, which have their own feedback", () => {
    for (const outcome of ["proposals", "provider_error", "invalid_output", "cancelled"]) {
      const { effects } = run([
        SAFE,
        { type: "turn_sent", turnId: "t1" },
        { type: "completed", turnId: "t1", outcome },
      ]);
      expect(effects).toEqual(["start_timer:4000", "cancel_timer"]);
    }
  });

  it("follows only the newest turn", () => {
    const { machine, effects } = run([
      SAFE,
      { type: "turn_sent", turnId: "t1" },
      { type: "turn_sent", turnId: "t2" },
      { type: "completed", turnId: "t1", outcome: "nothing_to_propose" },
    ]);
    expect(effects).toEqual(["start_timer:4000", "cancel_timer", "start_timer:4000"]);
    expect(machine).toEqual({ state: "waiting", context: { turnId: "t2", outputSafe: true } });
  });

  it("forgets the last session's turn on reset (v1 carried one call's state into the next)", () => {
    const { machine, effects } = run([
      SAFE,
      { type: "turn_sent", turnId: "old" },
      { type: "reset" },
      { type: "completed", turnId: "old", outcome: "nothing_to_propose" },
      { type: "timeout" },
    ]);
    expect(effects).toEqual(["start_timer:4000", "cancel_timer"]);
    expect(machine).toEqual({ state: "idle", context: { turnId: null, outputSafe: true } });
  });

  it("decides output safety: iOS needs the mic track stopped; elsewhere, not mid-utterance", () => {
    expect(isAudioOutputSafe({ ios: true, micTrackLive: true, recording: false })).toBe(false);
    expect(isAudioOutputSafe({ ios: true, micTrackLive: false, recording: false })).toBe(true);
    expect(isAudioOutputSafe({ ios: false, micTrackLive: true, recording: false })).toBe(true);
    expect(isAudioOutputSafe({ ios: false, micTrackLive: true, recording: true })).toBe(false);
  });
});
