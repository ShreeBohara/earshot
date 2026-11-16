// The speech socket's lifecycle (spec WP4 step 6), as a pure reducer: open on the first press (or
// on arming hands-free), reuse across presses, close after 20 s idle, and reconnect with backoff
// after a drop, but only while audio still needs sending. The Debrief engine performs the effects
// it returns: connecting with a fresh credential, closing, and the timers.
//
// The context's `wanted` says whether the engine needs the socket right now: push-to-talk is
// down, a released turn is waiting for its finals, or hands-free is streaming.

export const SPEECH_SOCKET_STATES = ["closed", "connecting", "open", "backoff", "closing"] as const;
export type SpeechSocketState = (typeof SPEECH_SOCKET_STATES)[number];

export const SPEECH_SOCKET_EVENTS = [
  "want",
  "release",
  "opened",
  "connect_failed",
  "dropped",
  "retry_due",
  "idle_timeout",
  "stop",
  "closed",
] as const;
export type SpeechSocketEventType = (typeof SPEECH_SOCKET_EVENTS)[number];

export type SpeechSocketEvent =
  /** Audio needs sending. */
  | { readonly type: "want" }
  /** Nothing needs sending for now; the idle timer may run. */
  | { readonly type: "release" }
  | { readonly type: "opened" }
  | { readonly type: "connect_failed"; readonly retryable: boolean; readonly retryAfterMs?: number }
  /** The open socket closed without being asked to. */
  | { readonly type: "dropped" }
  | { readonly type: "retry_due" }
  | { readonly type: "idle_timeout" }
  /** The engine is stopping: close, and never reconnect. */
  | { readonly type: "stop" }
  /** A close the engine asked for has finished. */
  | { readonly type: "closed" };

export type SpeechSocketEffect =
  | { readonly type: "connect" }
  | { readonly type: "close" }
  | { readonly type: "schedule_retry"; readonly delayMs: number }
  | { readonly type: "cancel_retry" }
  | { readonly type: "start_idle_timer" }
  | { readonly type: "cancel_idle_timer" }
  | { readonly type: "give_up"; readonly reason: "attempts_exhausted" | "rejected" };

export interface SpeechSocketContext {
  readonly wanted: boolean;
  /** Connect attempts that failed in a row. */
  readonly attempts: number;
  /** The socket dropped or failed, and hasn't reopened since. */
  readonly recovering: boolean;
  readonly stopped: boolean;
}

export interface SpeechSocket {
  readonly state: SpeechSocketState;
  readonly context: SpeechSocketContext;
}

export interface SpeechSocketPolicy {
  /** Consecutive failed connects before giving up. */
  readonly maxAttempts: number;
  /** The delay before retry `attempt` (0 for the first). */
  readonly delay: (attempt: number) => number;
}

export interface SpeechSocketStep {
  readonly socket: SpeechSocket;
  readonly effects: readonly SpeechSocketEffect[];
}

export const initialSpeechSocket: SpeechSocket = {
  state: "closed",
  context: { wanted: false, attempts: 0, recovering: false, stopped: false },
};

const step = (
  state: SpeechSocketState,
  context: SpeechSocketContext,
  effects: SpeechSocketEffect[] = [],
): SpeechSocketStep => ({ socket: { state, context }, effects });

/** The next state, and the effects to perform, for one event. Every pair is decided. */
export function speechSocketTransition(
  socket: SpeechSocket,
  event: SpeechSocketEvent,
  policy: SpeechSocketPolicy,
): SpeechSocketStep {
  const { state, context } = socket;
  const want = { ...context, wanted: !context.stopped };
  const release = { ...context, wanted: false };
  const stop = { ...context, wanted: false, stopped: true };
  const same = step(state, context);

  switch (state) {
    case "closed":
      switch (event.type) {
        case "want":
          return context.stopped
            ? same
            : step("connecting", { ...want, attempts: 0 }, [{ type: "connect" }]);
        case "release":
          return step("closed", release);
        case "stop":
          return step("closed", stop);
        default:
          return same; // a stale timer or socket event
      }

    case "connecting":
      switch (event.type) {
        case "want":
          return step("connecting", want);
        case "release":
          return step("connecting", release);
        case "opened":
          return step(
            "open",
            { ...context, attempts: 0, recovering: false },
            context.wanted ? [] : [{ type: "start_idle_timer" }],
          );
        case "connect_failed":
          return failed(context, event, policy);
        case "dropped":
          return failed(context, { retryable: true }, policy);
        case "stop":
          return step("closing", stop, [{ type: "close" }]);
        case "closed":
          return step("closed", context);
        default:
          return same;
      }

    case "open":
      switch (event.type) {
        case "want":
          return step("open", want, [{ type: "cancel_idle_timer" }]);
        case "release":
          return step("open", release, [{ type: "start_idle_timer" }]);
        case "dropped":
        case "closed":
          // The provider closed the socket itself: a drop, or its own idle or duration limit.
          return context.wanted
            ? step("backoff", { ...context, attempts: 0, recovering: true }, [
                { type: "cancel_idle_timer" },
                { type: "schedule_retry", delayMs: policy.delay(0) },
              ])
            : step("closed", context, [{ type: "cancel_idle_timer" }]);
        case "idle_timeout":
          return context.wanted ? same : step("closing", context, [{ type: "close" }]);
        case "stop":
          return step("closing", stop, [{ type: "cancel_idle_timer" }, { type: "close" }]);
        default:
          return same;
      }

    case "backoff":
      switch (event.type) {
        case "want":
          return step("backoff", want);
        case "release":
          return step("backoff", release);
        case "retry_due":
          return context.wanted
            ? step("connecting", context, [{ type: "connect" }])
            : step("closed", { ...context, attempts: 0, recovering: false });
        case "stop":
          return step("closed", stop, [{ type: "cancel_retry" }]);
        default:
          return same;
      }

    case "closing":
      switch (event.type) {
        case "want":
          return step("closing", want);
        case "release":
          return step("closing", release);
        case "closed":
        case "dropped":
          return context.wanted
            ? step("connecting", { ...context, attempts: 0 }, [{ type: "connect" }])
            : step("closed", context);
        case "stop":
          return step("closing", stop);
        default:
          return same;
      }
  }
}

function failed(
  context: SpeechSocketContext,
  event: { readonly retryable: boolean; readonly retryAfterMs?: number },
  policy: SpeechSocketPolicy,
): SpeechSocketStep {
  if (!event.retryable) {
    return step("closed", { ...context, wanted: false, attempts: 0, recovering: false }, [
      { type: "give_up", reason: "rejected" },
    ]);
  }
  if (!context.wanted) return step("closed", { ...context, attempts: 0, recovering: false });
  const attempts = context.attempts + 1;
  if (attempts >= policy.maxAttempts) {
    return step("closed", { ...context, wanted: false, attempts: 0, recovering: false }, [
      { type: "give_up", reason: "attempts_exhausted" },
    ]);
  }
  const delayMs = Math.max(policy.delay(attempts), event.retryAfterMs ?? 0);
  return step("backoff", { ...context, attempts, recovering: true }, [
    { type: "schedule_retry", delayMs },
  ]);
}
