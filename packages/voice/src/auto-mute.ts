// The auto-mute ref: the autoMute machine (`@earshot/voice/machines`) held in a plain object, so
// the PCM sender can read it synchronously for every frame. Pass `isMuted` to the Debrief engine;
// call `agentStarted` and `agentEnded` around every sound Earshot plays.
import {
  type AutoMute,
  type AutoMuteEvent,
  type AutoMutePolicy,
  autoMuteTransition,
  DEFAULT_AUTO_MUTE_POLICY,
  initialAutoMute,
  isMuted,
} from "./machines/auto-mute";
import { type Clock, systemClock } from "./stt/socket";

export interface AutoMuteRef {
  /** True while mic audio must not be sent. Synchronous: read it for every frame. */
  isMuted(): boolean;
  agentStarted(): void;
  agentEnded(): void;
  /** Stops muting at once, as when a session ends. */
  reset(): void;
  readonly state: AutoMute;
}

export function createAutoMute(
  options: { clock?: Clock; policy?: AutoMutePolicy } = {},
): AutoMuteRef {
  const clock = options.clock ?? systemClock;
  const policy = options.policy ?? DEFAULT_AUTO_MUTE_POLICY;
  let state = initialAutoMute;
  let timer: unknown;

  const dispatch = (event: AutoMuteEvent) => {
    const step = autoMuteTransition(state, event, policy);
    state = step.autoMute;
    for (const effect of step.effects) {
      if (effect.type === "start_tail_timer") {
        clock.clearTimeout(timer);
        timer = clock.setTimeout(() => dispatch({ type: "tail_elapsed" }), effect.delayMs);
      } else {
        clock.clearTimeout(timer);
        timer = undefined;
      }
    }
  };

  return {
    // An arrow over the live variable, so the engine can hold the function itself.
    isMuted: () => isMuted(state),
    agentStarted: () => dispatch({ type: "agent_start" }),
    agentEnded: () => dispatch({ type: "agent_end" }),
    reset: () => dispatch({ type: "reset" }),
    get state() {
      return state;
    },
  };
}
