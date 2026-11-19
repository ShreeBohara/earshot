// Don't send mic audio while the agent speaks (spec WP8 `autoMute`), as a pure reducer. The agent
// is anything Earshot plays: the silent-response chime, a spoken confirmation, or the Conversation
// engine's voice. Muting holds for a short tail after the last sound ends, so its echo isn't sent
// either.
//
// As in v1, the PCM sender reads the result synchronously for every frame, through a ref
// (`createAutoMute` in `@earshot/voice` keeps one), never through React state, which would lag a
// render behind the audio.

export const AUTO_MUTE_STATES = ["live", "agent_speaking", "tail"] as const;
export type AutoMuteState = (typeof AUTO_MUTE_STATES)[number];

export const AUTO_MUTE_EVENTS = ["agent_start", "agent_end", "tail_elapsed", "reset"] as const;
export type AutoMuteEventType = (typeof AUTO_MUTE_EVENTS)[number];

export type AutoMuteEvent =
  /** A sound started playing. Sounds may overlap: each start needs its own end. */
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end" }
  /** The tail timer fired. */
  | { readonly type: "tail_elapsed" }
  /** Everything stopped (a new session, or the output was torn down). */
  | { readonly type: "reset" };

export type AutoMuteEffect =
  | { readonly type: "start_tail_timer"; readonly delayMs: number }
  | { readonly type: "cancel_tail_timer" };

export interface AutoMuteContext {
  /** Sounds playing now. */
  readonly playing: number;
}

export interface AutoMute {
  readonly state: AutoMuteState;
  readonly context: AutoMuteContext;
}

export interface AutoMutePolicy {
  /** How long muting outlasts the last sound (target 250 ms). */
  readonly tailMs: number;
}

export interface AutoMuteStep {
  readonly autoMute: AutoMute;
  readonly effects: readonly AutoMuteEffect[];
}

export const DEFAULT_AUTO_MUTE_POLICY: AutoMutePolicy = Object.freeze({ tailMs: 250 });

export const initialAutoMute: AutoMute = { state: "live", context: { playing: 0 } };

/** True while mic audio must not be sent. */
export function isMuted(autoMute: AutoMute): boolean {
  return autoMute.state !== "live";
}

const step = (
  state: AutoMuteState,
  playing: number,
  effects: AutoMuteEffect[] = [],
): AutoMuteStep => ({ autoMute: { state, context: { playing } }, effects });

/** The next state, and the effects to perform, for one event. Every pair is decided. */
export function autoMuteTransition(
  autoMute: AutoMute,
  event: AutoMuteEvent,
  policy: AutoMutePolicy = DEFAULT_AUTO_MUTE_POLICY,
): AutoMuteStep {
  const { state, context } = autoMute;
  const same = step(state, context.playing);
  if (event.type === "reset") {
    return step("live", 0, state === "tail" ? [{ type: "cancel_tail_timer" }] : []);
  }

  switch (state) {
    case "live":
      return event.type === "agent_start" ? step("agent_speaking", 1) : same;

    case "agent_speaking":
      switch (event.type) {
        case "agent_start":
          return step("agent_speaking", context.playing + 1);
        case "agent_end":
          return context.playing > 1
            ? step("agent_speaking", context.playing - 1)
            : step("tail", 0, [{ type: "start_tail_timer", delayMs: policy.tailMs }]);
        default:
          return same; // a stale tail timer
      }

    case "tail":
      switch (event.type) {
        case "agent_start":
          return step("agent_speaking", 1, [{ type: "cancel_tail_timer" }]);
        case "tail_elapsed":
          return step("live", 0);
        default:
          return same; // an unmatched end
      }
  }
}
