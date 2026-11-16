import { describe, expect, it } from "vitest";
import { backoffDelay } from "../src/machines/backoff";
import {
  initialSpeechSocket,
  SPEECH_SOCKET_EVENTS,
  SPEECH_SOCKET_STATES,
  type SpeechSocket,
  type SpeechSocketEvent,
  type SpeechSocketEventType,
  type SpeechSocketPolicy,
  type SpeechSocketState,
  speechSocketTransition,
} from "../src/machines/speech-socket";

const policy: SpeechSocketPolicy = { maxAttempts: 5, delay: (attempt) => 100 * 2 ** attempt };

const eventOf = (type: SpeechSocketEventType): SpeechSocketEvent =>
  type === "connect_failed" ? { type, retryable: true } : { type };

const at = (state: SpeechSocketState, wanted: boolean): SpeechSocket => ({
  state,
  context: { wanted, attempts: 0, recovering: false, stopped: false },
});

// Every (state, event) pair, for a socket that isn't wanted and one that is: [not wanted, wanted].
// The type makes a new state or event without a decision a compile error, and the loop below
// makes a wrong decision a test failure.
const TABLE: Record<
  SpeechSocketState,
  Record<SpeechSocketEventType, [SpeechSocketState, SpeechSocketState]>
> = {
  closed: {
    want: ["connecting", "connecting"],
    release: ["closed", "closed"],
    opened: ["closed", "closed"],
    connect_failed: ["closed", "closed"],
    dropped: ["closed", "closed"],
    retry_due: ["closed", "closed"],
    idle_timeout: ["closed", "closed"],
    stop: ["closed", "closed"],
    closed: ["closed", "closed"],
  },
  connecting: {
    want: ["connecting", "connecting"],
    release: ["connecting", "connecting"],
    opened: ["open", "open"],
    connect_failed: ["closed", "backoff"],
    dropped: ["closed", "backoff"],
    retry_due: ["connecting", "connecting"],
    idle_timeout: ["connecting", "connecting"],
    stop: ["closing", "closing"],
    closed: ["closed", "closed"],
  },
  open: {
    want: ["open", "open"],
    release: ["open", "open"],
    opened: ["open", "open"],
    connect_failed: ["open", "open"],
    dropped: ["closed", "backoff"],
    retry_due: ["open", "open"],
    idle_timeout: ["closing", "open"],
    stop: ["closing", "closing"],
    closed: ["closed", "backoff"],
  },
  backoff: {
    want: ["backoff", "backoff"],
    release: ["backoff", "backoff"],
    opened: ["backoff", "backoff"],
    connect_failed: ["backoff", "backoff"],
    dropped: ["backoff", "backoff"],
    retry_due: ["closed", "connecting"],
    idle_timeout: ["backoff", "backoff"],
    stop: ["closed", "closed"],
    closed: ["backoff", "backoff"],
  },
  closing: {
    want: ["closing", "closing"],
    release: ["closing", "closing"],
    opened: ["closing", "closing"],
    connect_failed: ["closing", "closing"],
    dropped: ["closed", "connecting"],
    retry_due: ["closing", "closing"],
    idle_timeout: ["closing", "closing"],
    stop: ["closing", "closing"],
    closed: ["closed", "connecting"],
  },
};

describe("the speech socket machine", () => {
  it("decides every (state, event) pair, wanted or not", () => {
    let pairs = 0;
    for (const state of SPEECH_SOCKET_STATES) {
      for (const type of SPEECH_SOCKET_EVENTS) {
        for (const wanted of [false, true]) {
          const next = speechSocketTransition(at(state, wanted), eventOf(type), policy).socket
            .state;
          expect(`${state} + ${type} (wanted: ${wanted}) → ${next}`).toBe(
            `${state} + ${type} (wanted: ${wanted}) → ${TABLE[state][type][wanted ? 1 : 0]}`,
          );
          pairs += 1;
        }
      }
    }
    expect(pairs).toBe(SPEECH_SOCKET_STATES.length * SPEECH_SOCKET_EVENTS.length * 2);
  });

  /** Runs events in order, returning the final socket and every effect. */
  function run(events: SpeechSocketEvent[], from: SpeechSocket = initialSpeechSocket) {
    let socket = from;
    const effects: string[] = [];
    for (const event of events) {
      const step = speechSocketTransition(socket, event, policy);
      socket = step.socket;
      effects.push(
        ...step.effects.map((effect) =>
          "delayMs" in effect ? `${effect.type}:${effect.delayMs}` : effect.type,
        ),
      );
    }
    return { socket, effects };
  }

  it("opens on the first press, stays open across presses, and closes after idling", () => {
    const { socket, effects } = run([
      { type: "want" },
      { type: "opened" },
      { type: "release" },
      { type: "want" },
      { type: "release" },
      { type: "idle_timeout" },
      { type: "closed" },
    ]);
    expect(effects).toEqual([
      "connect",
      "start_idle_timer",
      "cancel_idle_timer",
      "start_idle_timer",
      "close",
    ]);
    expect(socket.state).toBe("closed");
  });

  it("starts the idle timer when a socket opens with nothing to send", () => {
    expect(run([{ type: "want" }, { type: "release" }, { type: "opened" }]).effects).toEqual([
      "connect",
      "start_idle_timer",
    ]);
  });

  it("reconnects after a drop while audio is needed, with backoff, and recovers", () => {
    const { socket, effects } = run([
      { type: "want" },
      { type: "opened" },
      { type: "dropped" },
      { type: "retry_due" },
      { type: "connect_failed", retryable: true },
      { type: "retry_due" },
      { type: "opened" },
    ]);
    expect(effects).toEqual([
      "connect",
      "cancel_idle_timer",
      "schedule_retry:100",
      "connect",
      "schedule_retry:200",
      "connect",
    ]);
    expect(socket).toEqual({
      state: "open",
      context: { wanted: true, attempts: 0, recovering: false, stopped: false },
    });
  });

  it("marks itself recovering until the socket reopens", () => {
    const dropped = run([{ type: "want" }, { type: "opened" }, { type: "dropped" }]).socket;
    expect(dropped.context.recovering).toBe(true);
    expect(run([{ type: "retry_due" }], dropped).socket.context.recovering).toBe(true);
  });

  it("doesn't reconnect a socket that dropped while idle; the next press does", () => {
    const idle = run([
      { type: "want" },
      { type: "opened" },
      { type: "release" },
      { type: "dropped" },
    ]);
    expect(idle.socket.state).toBe("closed");
    expect(run([{ type: "want" }], idle.socket).effects).toEqual(["connect"]);
  });

  it("gives up after five failed connects in a row", () => {
    const failures = Array.from({ length: 5 }, () => [
      { type: "connect_failed", retryable: true } as const,
      { type: "retry_due" } as const,
    ]).flat();
    const { socket, effects } = run([{ type: "want" }, ...failures.slice(0, -1)]);
    expect(effects.filter((effect) => effect === "connect")).toHaveLength(5);
    expect(effects.at(-1)).toBe("give_up");
    expect(socket).toMatchObject({ state: "closed", context: { wanted: false, attempts: 0 } });
  });

  it("gives up at once when the failure can't be retried", () => {
    const { socket, effects } = run([
      { type: "want" },
      { type: "connect_failed", retryable: false },
    ]);
    expect(effects).toEqual(["connect", "give_up"]);
    expect(socket.state).toBe("closed");
  });

  it("waits at least as long as the provider asked", () => {
    const { effects } = run([
      { type: "want" },
      { type: "connect_failed", retryable: true, retryAfterMs: 12_000 },
    ]);
    expect(effects).toEqual(["connect", "schedule_retry:12000"]);
  });

  it("reconnects once a close finishes, if audio was wanted meanwhile", () => {
    const { socket, effects } = run([
      { type: "want" },
      { type: "opened" },
      { type: "release" },
      { type: "idle_timeout" },
      { type: "want" },
      { type: "closed" },
    ]);
    expect(effects.slice(-2)).toEqual(["close", "connect"]);
    expect(socket.state).toBe("connecting");
  });

  it("stays down once stopped, whatever comes after", () => {
    const stopped = run([
      { type: "want" },
      { type: "opened" },
      { type: "stop" },
      { type: "closed" },
    ]);
    expect(stopped.effects).toEqual(["connect", "cancel_idle_timer", "close"]);
    expect(stopped.socket.state).toBe("closed");
    expect(run([{ type: "want" }], stopped.socket).effects).toEqual([]);
    const inBackoff = run([
      { type: "want" },
      { type: "opened" },
      { type: "dropped" },
      { type: "stop" },
    ]);
    expect(inBackoff.effects.at(-1)).toBe("cancel_retry");
    expect(inBackoff.socket.state).toBe("closed");
  });
});

describe("backoffDelay", () => {
  it("doubles the ceiling each attempt, up to the cap, with full jitter", () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, { random: () => 0.999_999 })),
    ).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 8_000]);
    expect(backoffDelay(3, { random: () => 0 })).toBe(0);
    expect(backoffDelay(3, { random: () => 0.5 })).toBe(1_000);
    expect(backoffDelay(2, { baseMs: 100, maxMs: 300, random: () => 0.999_999 })).toBe(300);
  });

  it("stays in range for any random source", () => {
    for (let i = 0; i < 1_000; i++) {
      const delay = backoffDelay(i % 8);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(8_000);
    }
  });
});
