import { describe, expect, it } from "vitest";
import { createAutoMute } from "../src/auto-mute";
import {
  AUTO_MUTE_EVENTS,
  AUTO_MUTE_STATES,
  type AutoMute,
  type AutoMuteEvent,
  type AutoMuteEventType,
  type AutoMuteState,
  autoMuteTransition,
  initialAutoMute,
  isMuted,
} from "../src/machines/auto-mute";
import { ManualClock } from "./support/manual-clock";

const at = (state: AutoMuteState): AutoMute => ({
  state,
  context: { playing: state === "agent_speaking" ? 1 : 0 },
});

// Every (state, event) pair, with one sound playing in `agent_speaking`.
const TABLE: Record<AutoMuteState, Record<AutoMuteEventType, AutoMuteState>> = {
  live: {
    agent_start: "agent_speaking",
    agent_end: "live",
    tail_elapsed: "live",
    reset: "live",
  },
  agent_speaking: {
    agent_start: "agent_speaking",
    agent_end: "tail",
    tail_elapsed: "agent_speaking",
    reset: "live",
  },
  tail: {
    agent_start: "agent_speaking",
    agent_end: "tail",
    tail_elapsed: "live",
    reset: "live",
  },
};

function run(events: AutoMuteEvent[], from: AutoMute = initialAutoMute) {
  let autoMute = from;
  const effects: string[] = [];
  for (const event of events) {
    const step = autoMuteTransition(autoMute, event);
    autoMute = step.autoMute;
    effects.push(
      ...step.effects.map((effect) =>
        "delayMs" in effect ? `${effect.type}:${effect.delayMs}` : effect.type,
      ),
    );
  }
  return { autoMute, effects };
}

describe("the autoMute machine", () => {
  it("decides every (state, event) pair", () => {
    let pairs = 0;
    for (const state of AUTO_MUTE_STATES) {
      for (const type of AUTO_MUTE_EVENTS) {
        const next = autoMuteTransition(at(state), { type }).autoMute.state;
        expect(`${state} + ${type} → ${next}`).toBe(`${state} + ${type} → ${TABLE[state][type]}`);
        pairs += 1;
      }
    }
    expect(pairs).toBe(AUTO_MUTE_STATES.length * AUTO_MUTE_EVENTS.length);
  });

  it("mutes while the agent speaks, and for a short tail after", () => {
    const { autoMute, effects } = run([{ type: "agent_start" }, { type: "agent_end" }]);
    expect(autoMute.state).toBe("tail");
    expect(isMuted(autoMute)).toBe(true);
    expect(effects).toEqual(["start_tail_timer:250"]);
    expect(isMuted(run([{ type: "tail_elapsed" }], autoMute).autoMute)).toBe(false);
  });

  it("stays muted until the last of overlapping sounds ends", () => {
    const { autoMute } = run([
      { type: "agent_start" },
      { type: "agent_start" },
      { type: "agent_end" },
    ]);
    expect(autoMute).toEqual({ state: "agent_speaking", context: { playing: 1 } });
  });

  it("cancels the tail when another sound starts in it", () => {
    const { autoMute, effects } = run([
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "agent_start" },
    ]);
    expect(autoMute.state).toBe("agent_speaking");
    expect(effects).toEqual(["start_tail_timer:250", "cancel_tail_timer"]);
  });
});

describe("createAutoMute, the ref the PCM sender reads", () => {
  it("answers synchronously, the moment a sound starts and after its tail", async () => {
    const clock = new ManualClock();
    const mute = createAutoMute({ clock });
    const isMutedNow = mute.isMuted; // the engine holds the function, not the object
    expect(isMutedNow()).toBe(false);
    mute.agentStarted();
    expect(isMutedNow()).toBe(true); // no render, no await
    mute.agentEnded();
    expect(isMutedNow()).toBe(true);
    await clock.advance(249);
    expect(isMutedNow()).toBe(true);
    await clock.advance(1);
    expect(isMutedNow()).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("drops a pending tail on reset", async () => {
    const clock = new ManualClock();
    const mute = createAutoMute({ clock });
    mute.agentStarted();
    mute.agentEnded();
    mute.reset();
    expect(mute.isMuted()).toBe(false);
    expect(clock.pending).toBe(0);
  });
});
