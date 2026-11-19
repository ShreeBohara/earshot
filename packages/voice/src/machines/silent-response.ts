// What the screen does when a turn gets no proposal (spec WP8 `silentResponse`), as a pure
// reducer: a soft chime plus a feed row when a turn ends with nothing to propose, or when nothing
// arrives within 4 s of its `turn_end` (target). The chime plays only when audio output is safe;
// on iOS that means the mic track is stopped, because WebKit crackles any sound played while an
// echo-cancelled mic is live (bug 326286). Otherwise the feed row comes alone.
//
// One turn is followed at a time: the newest. A turn the rep has moved on from gets no chime.

export const SILENT_RESPONSE_STATES = ["idle", "waiting", "timed_out"] as const;
/**
 * - `idle`: no turn is waiting for an answer.
 * - `waiting`: a turn's `turn_end` went out; the timer runs.
 * - `timed_out`: the timer fired and the screen said so; the turn's answer may still come, but
 *   it won't chime again.
 */
export type SilentResponseState = (typeof SILENT_RESPONSE_STATES)[number];

export const SILENT_RESPONSE_EVENTS = [
  "turn_sent",
  "completed",
  "timeout",
  "output",
  "reset",
] as const;
export type SilentResponseEventType = (typeof SILENT_RESPONSE_EVENTS)[number];

/** `turn.completed`'s outcomes, as far as this machine cares: anything else is an error row. */
export type SilentTurnOutcome = "proposals" | "nothing_to_propose" | (string & {});

export type SilentResponseEvent =
  /** The turn's `turn_end` was sent. */
  | { readonly type: "turn_sent"; readonly turnId: string }
  /** `turn.completed` arrived for a turn. */
  | { readonly type: "completed"; readonly turnId: string; readonly outcome: SilentTurnOutcome }
  | { readonly type: "timeout" }
  /** Whether playing a sound is safe now. */
  | { readonly type: "output"; readonly safe: boolean }
  /** A new session: nothing carries over. */
  | { readonly type: "reset" };

/** Why the screen says nothing came: the model found nothing, or nothing arrived in time. */
export type SilentReason = "nothing_to_propose" | "timeout";

export type SilentResponseEffect =
  | { readonly type: "start_timer"; readonly delayMs: number }
  | { readonly type: "cancel_timer" }
  /** Add the feed row, and play the chime if `chime`. */
  | {
      readonly type: "notify";
      readonly turnId: string;
      readonly reason: SilentReason;
      readonly chime: boolean;
    };

export interface SilentResponseContext {
  /** The turn being followed. */
  readonly turnId: string | null;
  readonly outputSafe: boolean;
}

export interface SilentResponse {
  readonly state: SilentResponseState;
  readonly context: SilentResponseContext;
}

export interface SilentResponsePolicy {
  /** How long a turn may go without an answer before the screen says so (target 4 s). */
  readonly timeoutMs: number;
}

export interface SilentResponseStep {
  readonly silentResponse: SilentResponse;
  readonly effects: readonly SilentResponseEffect[];
}

export const DEFAULT_SILENT_RESPONSE_POLICY: SilentResponsePolicy = Object.freeze({
  timeoutMs: 4_000,
});

/** Starts with output unsafe: nothing plays until the caller says the output is safe. */
export const initialSilentResponse: SilentResponse = {
  state: "idle",
  context: { turnId: null, outputSafe: false },
};

/**
 * Whether a chime may play now. On iOS only with the mic track stopped (WebKit bug 326286); on
 * other platforms whenever the rep isn't mid-utterance, since auto-mute keeps the chime out of
 * the speech stream anyway.
 */
export function isAudioOutputSafe(input: {
  readonly ios: boolean;
  readonly micTrackLive: boolean;
  readonly recording: boolean;
}): boolean {
  return input.ios ? !input.micTrackLive : !input.recording;
}

const step = (
  state: SilentResponseState,
  context: SilentResponseContext,
  effects: SilentResponseEffect[] = [],
): SilentResponseStep => ({ silentResponse: { state, context }, effects });

/** The next state, and the effects to perform, for one event. Every pair is decided. */
export function silentResponseTransition(
  silentResponse: SilentResponse,
  event: SilentResponseEvent,
  policy: SilentResponsePolicy = DEFAULT_SILENT_RESPONSE_POLICY,
): SilentResponseStep {
  const { state, context } = silentResponse;
  const same = step(state, context);

  switch (event.type) {
    case "output":
      return step(state, { ...context, outputSafe: event.safe });
    case "reset":
      return step(
        "idle",
        { ...context, turnId: null },
        state === "waiting" ? [{ type: "cancel_timer" }] : [],
      );
    case "turn_sent":
      // A newer turn replaces the one being followed.
      return step("waiting", { ...context, turnId: event.turnId }, [
        ...(state === "waiting" ? [{ type: "cancel_timer" } as const] : []),
        { type: "start_timer", delayMs: policy.timeoutMs },
      ]);
    case "timeout":
      if (state !== "waiting" || context.turnId === null) return same; // a stale timer
      return step("timed_out", context, [
        { type: "notify", turnId: context.turnId, reason: "timeout", chime: context.outputSafe },
      ]);
    case "completed": {
      if (state === "idle" || event.turnId !== context.turnId) return same; // not the newest turn
      const effects: SilentResponseEffect[] = state === "waiting" ? [{ type: "cancel_timer" }] : [];
      if (event.outcome === "nothing_to_propose") {
        effects.push({
          type: "notify",
          turnId: event.turnId,
          reason: "nothing_to_propose",
          // One chime per turn: a turn that already timed out gets its row, quietly.
          chime: state === "waiting" && context.outputSafe,
        });
      }
      return step("idle", { ...context, turnId: null }, effects);
    }
  }
}
