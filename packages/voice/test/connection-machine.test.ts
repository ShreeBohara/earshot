import { SESSION_CLOSE_CODES } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  CONNECTION_EVENTS,
  CONNECTION_STATES,
  type Connection,
  type ConnectionEvent,
  type ConnectionEventType,
  type ConnectionPolicy,
  type ConnectionState,
  connectionFor,
  connectionTransition,
  initialConnection,
} from "../src/machines/connection";

const policy: ConnectionPolicy = {
  delay: (attempt) => 100 * 2 ** attempt,
  rateLimitedDelayMs: 5_000,
  maxTicketRefusals: 2,
  maxGapResumes: 3,
};

const eventOf = (type: ConnectionEventType): ConnectionEvent => {
  switch (type) {
    case "ticket_failed":
      return { type, retryable: true };
    case "dropped":
      return { type, code: 1006 };
    case "gap":
      return { type, expectedSeq: 5 };
    default:
      return { type };
  }
};

/** Each state with the page flags it implies: offline is offline, suspended is hidden. */
const at = (state: ConnectionState): Connection => ({
  state,
  context: {
    ...initialConnection.context,
    online: state !== "offline",
    hidden: state === "suspended",
    reason: state === "closed" ? "stopped" : null,
  },
});

// Every (state, event) pair. The type makes a new state or event without a decision a compile
// error, and the loop makes a wrong decision a test failure. `dropped` is a network drop (1006)
// here; each close code has its own test below.
const TABLE: Record<ConnectionState, Record<ConnectionEventType, ConnectionState>> = {
  idle: {
    start: "connecting",
    ticket_failed: "idle",
    opened: "idle",
    welcome: "idle",
    dropped: "idle",
    retry_due: "idle",
    gap: "idle",
    heartbeat_timeout: "idle",
    offline: "idle",
    online: "idle",
    hidden: "idle",
    visible: "idle",
    stop: "closed",
  },
  connecting: {
    start: "connecting",
    ticket_failed: "backoff",
    opened: "resuming",
    welcome: "connecting",
    dropped: "backoff",
    retry_due: "connecting",
    gap: "connecting",
    heartbeat_timeout: "connecting",
    offline: "connecting",
    online: "connecting",
    hidden: "suspended",
    visible: "connecting",
    stop: "closed",
  },
  resuming: {
    start: "resuming",
    ticket_failed: "resuming",
    opened: "resuming",
    welcome: "open",
    dropped: "backoff",
    retry_due: "resuming",
    gap: "resuming",
    heartbeat_timeout: "backoff",
    offline: "resuming",
    online: "resuming",
    hidden: "suspended",
    visible: "resuming",
    stop: "closed",
  },
  open: {
    start: "open",
    ticket_failed: "open",
    opened: "open",
    welcome: "open",
    dropped: "backoff",
    retry_due: "open",
    gap: "resuming",
    heartbeat_timeout: "backoff",
    offline: "open",
    online: "open",
    hidden: "suspended",
    visible: "open",
    stop: "closed",
  },
  backoff: {
    start: "backoff",
    ticket_failed: "backoff",
    opened: "backoff",
    welcome: "backoff",
    dropped: "backoff",
    retry_due: "connecting",
    gap: "backoff",
    heartbeat_timeout: "backoff",
    offline: "offline",
    online: "connecting",
    hidden: "suspended",
    visible: "backoff",
    stop: "closed",
  },
  offline: {
    start: "offline",
    ticket_failed: "offline",
    opened: "offline",
    welcome: "offline",
    dropped: "offline",
    retry_due: "offline",
    gap: "offline",
    heartbeat_timeout: "offline",
    offline: "offline",
    online: "connecting",
    hidden: "suspended",
    visible: "offline",
    stop: "closed",
  },
  suspended: {
    start: "suspended",
    ticket_failed: "suspended",
    opened: "suspended",
    welcome: "suspended",
    dropped: "suspended",
    retry_due: "suspended",
    gap: "suspended",
    heartbeat_timeout: "suspended",
    offline: "suspended",
    online: "suspended",
    hidden: "suspended",
    visible: "connecting",
    stop: "closed",
  },
  closed: {
    start: "closed",
    ticket_failed: "closed",
    opened: "closed",
    welcome: "closed",
    dropped: "closed",
    retry_due: "closed",
    gap: "closed",
    heartbeat_timeout: "closed",
    offline: "closed",
    online: "closed",
    hidden: "closed",
    visible: "closed",
    stop: "closed",
  },
};

/** Runs events in order, returning the final machine and every effect, flattened to strings. */
function run(events: ConnectionEvent[], from: Connection = initialConnection) {
  let connection = from;
  const effects: string[] = [];
  for (const event of events) {
    const step = connectionTransition(connection, event, policy);
    connection = step.connection;
    for (const effect of step.effects) {
      if (effect.type === "schedule_retry") effects.push(`schedule_retry:${effect.delayMs}`);
      else if (effect.type === "close_socket") effects.push(`close_socket:${effect.reason}`);
      else effects.push(effect.type);
    }
  }
  return { connection, effects };
}

const OPEN: ConnectionEvent[] = [{ type: "start" }, { type: "opened" }, { type: "welcome" }];

describe("the connection machine", () => {
  it("decides every (state, event) pair", () => {
    let pairs = 0;
    for (const state of CONNECTION_STATES) {
      for (const type of CONNECTION_EVENTS) {
        const next = connectionTransition(at(state), eventOf(type), policy).connection.state;
        expect(`${state} + ${type} → ${next}`).toBe(`${state} + ${type} → ${TABLE[state][type]}`);
        pairs += 1;
      }
    }
    expect(pairs).toBe(CONNECTION_STATES.length * CONNECTION_EVENTS.length);
  });

  it("connects, says hello, and opens on welcome", () => {
    const { connection, effects } = run(OPEN);
    expect(effects).toEqual(["connect", "send_hello", "start_heartbeat", "flush_outbox"]);
    expect(connection.state).toBe("open");
  });

  it("follows every session close code's reconnect flag", () => {
    const codes = Object.values(SESSION_CLOSE_CODES);
    expect(codes).toHaveLength(9);
    for (const close of codes) {
      const opened = run(OPEN).connection;
      const { connection, effects } = run([{ type: "dropped", code: close.code }], opened);
      const ticket = close.code === 4003 || close.code === 4004;
      const expected = !close.reconnect ? "closed" : ticket ? "connecting" : "backoff";
      expect(`${close.code} → ${connection.state}`).toBe(`${close.code} → ${expected}`);
      expect(connection.context.lastCode).toBe(close.code);
      if (!close.reconnect) {
        expect(connection.context.reason).toBe(
          (Object.keys(SESSION_CLOSE_CODES) as (keyof typeof SESSION_CLOSE_CODES)[]).find(
            (name) => SESSION_CLOSE_CODES[name].code === close.code,
          ),
        );
        expect(effects).toEqual(["stop_heartbeat"]);
      }
    }
  });

  it("reconnects after any other code, as after a network drop", () => {
    for (const code of [1000, 1001, 1006, 1011, 4099]) {
      const { connection, effects } = run([{ type: "dropped", code }], run(OPEN).connection);
      expect(connection.state).toBe("backoff");
      expect(effects).toEqual(["stop_heartbeat", "schedule_retry:100"]);
    }
  });

  it("backs off for longer after a rate-limited close", () => {
    const { effects } = run([{ type: "dropped", code: 4002 }], run(OPEN).connection);
    expect(effects).toEqual(["stop_heartbeat", "schedule_retry:5000"]);
  });

  it("fetches a fresh ticket at once after a refused one, and stops if that one is refused too", () => {
    const first = run([...OPEN, { type: "dropped", code: 4003 }]);
    expect(first.effects.slice(-2)).toEqual(["stop_heartbeat", "connect"]);
    const second = run([{ type: "opened" }, { type: "dropped", code: 4004 }], first.connection);
    expect(second.connection).toMatchObject({
      state: "closed",
      context: { reason: "ticket_reused", ticketRefusals: 2 },
    });
    // A welcome in between clears the count.
    const recovered = run(
      [{ type: "opened" }, { type: "welcome" }, { type: "dropped", code: 4003 }],
      first.connection,
    );
    expect(recovered.connection.state).toBe("connecting");
  });

  it("drops, backs off with growing delays, and resumes", () => {
    const { connection, effects } = run([
      ...OPEN,
      { type: "dropped", code: 1006 },
      { type: "retry_due" },
      { type: "dropped", code: 1006 },
      { type: "retry_due" },
      { type: "ticket_failed", retryable: true },
      { type: "retry_due" },
      { type: "opened" },
      { type: "welcome" },
    ]);
    expect(effects).toEqual([
      "connect",
      "send_hello",
      "start_heartbeat",
      "flush_outbox",
      "stop_heartbeat",
      "schedule_retry:100",
      "connect",
      "schedule_retry:200",
      "connect",
      "schedule_retry:400",
      "connect",
      "send_hello",
      "start_heartbeat",
      "flush_outbox",
    ]);
    expect(connection).toMatchObject({ state: "open", context: { attempt: 0 } });
  });

  it("waits out a ticket route's Retry-After", () => {
    const { effects } = run([
      { type: "start" },
      { type: "ticket_failed", retryable: true, retryAfterMs: 30_000 },
    ]);
    expect(effects).toEqual(["connect", "schedule_retry:30000"]);
  });

  it("stops for a ticket refusal that can't be retried", () => {
    for (const reason of ["signed_out", "not_found", "forbidden", "session_ended"] as const) {
      const { connection } = run([
        { type: "start" },
        { type: "ticket_failed", retryable: false, reason },
      ]);
      expect(connection).toMatchObject({ state: "closed", context: { reason } });
    }
  });

  it("resumes on a gap, and calls it out of sync when the same gap keeps coming back", () => {
    const resumed = run([...OPEN, { type: "gap", expectedSeq: 7 }]);
    expect(resumed.effects.at(-1)).toBe("send_hello");
    expect(resumed.connection.state).toBe("resuming");
    let connection = resumed.connection;
    for (let i = 0; i < 2; i++) {
      connection = run(
        [{ type: "welcome" }, { type: "gap", expectedSeq: 7 }],
        connection,
      ).connection;
      expect(connection.state).toBe("resuming");
    }
    const last = run([{ type: "welcome" }, { type: "gap", expectedSeq: 7 }], connection);
    expect(last.connection).toMatchObject({ state: "closed", context: { reason: "desynced" } });
    expect(last.effects).toEqual(["flush_outbox", "stop_heartbeat", "close_socket:desynced"]);
  });

  it("counts gaps again once the log moves on", () => {
    let connection = run(OPEN).connection;
    for (const expectedSeq of [3, 3, 3, 9, 9, 9]) {
      connection = run([{ type: "gap", expectedSeq }, { type: "welcome" }], connection).connection;
    }
    expect(connection).toMatchObject({ state: "open", context: { gapSeq: 9, gapRepeats: 3 } });
  });

  it("closes a socket whose heartbeat went unanswered, and reconnects", () => {
    const { connection, effects } = run([...OPEN, { type: "heartbeat_timeout" }]);
    expect(effects.slice(-3)).toEqual([
      "stop_heartbeat",
      "close_socket:heartbeat",
      "schedule_retry:100",
    ]);
    expect(connection.state).toBe("backoff");
  });

  it("stops retrying while offline, and reconnects as soon as the network is back", () => {
    const offline = run([...OPEN, { type: "dropped", code: 1006 }, { type: "offline" }]);
    expect(offline.effects.slice(-1)).toEqual(["cancel_retry"]);
    expect(offline.connection.state).toBe("offline");
    const back = run([{ type: "online" }], offline.connection);
    expect(back.effects).toEqual(["connect"]);
    expect(back.connection.context.attempt).toBe(0);
    // In backoff, the network coming back skips the rest of the wait.
    const waiting = run([...OPEN, { type: "dropped", code: 1006 }]).connection;
    expect(run([{ type: "online" }], waiting).effects).toEqual(["cancel_retry", "connect"]);
  });

  it("keeps an open socket when the browser says offline, and waits for online after a drop", () => {
    const { connection, effects } = run([
      ...OPEN,
      { type: "offline" },
      { type: "dropped", code: 1006 },
    ]);
    expect(connection.state).toBe("offline");
    expect(effects.slice(-1)).toEqual(["stop_heartbeat"]);
  });

  it("on a hidden iOS page, flushes the outbox, closes cleanly, and resumes when visible", () => {
    const hidden = run([...OPEN, { type: "hidden" }]);
    expect(hidden.effects.slice(-3)).toEqual([
      "flush_outbox",
      "stop_heartbeat",
      "close_socket:hidden",
    ]);
    expect(hidden.connection.state).toBe("suspended");
    expect(run([{ type: "visible" }], hidden.connection).effects).toEqual(["connect"]);
    // Before welcome there's nothing to flush to; a pending connect is abandoned.
    expect(
      run([{ type: "start" }, { type: "opened" }, { type: "hidden" }]).effects.slice(-2),
    ).toEqual(["stop_heartbeat", "close_socket:hidden"]);
    expect(run([{ type: "start" }, { type: "hidden" }]).effects.slice(-1)).toEqual([
      "abort_connect",
    ]);
  });

  it("starts suspended or offline when the page is", () => {
    expect(
      run([{ type: "start" }], connectionFor({ online: true, hidden: true })).connection.state,
    ).toBe("suspended");
    expect(
      run([{ type: "start" }], connectionFor({ online: false, hidden: false })).connection.state,
    ).toBe("offline");
    const hiddenOffline = run(
      [{ type: "start" }, { type: "visible" }],
      connectionFor({ online: false, hidden: true }),
    );
    expect(hiddenOffline.connection.state).toBe("offline");
  });

  it("stops from every live state, undoing whatever it had going", () => {
    expect(run([{ type: "start" }, { type: "stop" }]).effects.slice(-1)).toEqual(["abort_connect"]);
    expect(run([...OPEN, { type: "stop" }]).effects.slice(-2)).toEqual([
      "stop_heartbeat",
      "close_socket:stopped",
    ]);
    expect(
      run([...OPEN, { type: "dropped", code: 1006 }, { type: "stop" }]).effects.slice(-1),
    ).toEqual(["cancel_retry"]);
    const stopped = run([...OPEN, { type: "stop", reason: "desynced" }]).connection;
    expect(stopped).toMatchObject({ state: "closed", context: { reason: "desynced" } });
    for (const type of CONNECTION_EVENTS) {
      expect(connectionTransition(stopped, eventOf(type), policy).effects).toEqual([]);
    }
  });
});
