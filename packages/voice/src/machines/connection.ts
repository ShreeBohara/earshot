// The session socket's lifecycle (spec WP8 `connection`), as a pure reducer: connect with a fresh
// ticket, say `hello` and wait for `welcome` (resuming), stay open, and after a drop reconnect
// with backoff and jitter, as each close code's `reconnect` flag says (`sessionCloseFor` in
// `@earshot/core`). SessionClient performs the effects it returns.
//
// This is the session socket to SessionDO, not the speech socket to the provider: that one is
// `speech-socket.ts`, which the Debrief engine runs. The two differ on purpose. The session socket
// is wanted for the whole session, never closes for idling, resumes from a seq after `hello`, and
// stops for good on the final close codes; it shares only `backoffDelay` with the speech socket.

import { type SessionCloseName, sessionCloseFor } from "@earshot/core";

export const CONNECTION_STATES = [
  "idle",
  "connecting",
  "resuming",
  "open",
  "backoff",
  "offline",
  "suspended",
  "closed",
] as const;
/**
 * - `idle`: made, not started.
 * - `connecting`: fetching a fresh ticket, then opening the socket.
 * - `resuming`: the socket is open and `hello` went out; events wait for `welcome`.
 * - `open`: `welcome` arrived; events, acks, and the outbox flow.
 * - `backoff`: the socket dropped; a reconnect is scheduled.
 * - `offline`: the browser is offline; reconnecting waits for `online`.
 * - `suspended`: the page is hidden on a platform that loses its sockets (iOS); reconnecting
 *   waits for `visible`.
 * - `closed`: for good: stopped, ended, replaced, refused, or out of sync. `reason` says which.
 */
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const CONNECTION_EVENTS = [
  "start",
  "ticket_failed",
  "opened",
  "welcome",
  "dropped",
  "retry_due",
  "gap",
  "heartbeat_timeout",
  "offline",
  "online",
  "hidden",
  "visible",
  "stop",
] as const;
export type ConnectionEventType = (typeof CONNECTION_EVENTS)[number];

/** Why the connection closed for good. */
export type ConnectionCloseReason =
  /** The client stopped: the session ended here, or the app closed it. */
  | "stopped"
  /**
   * A session close code's name: one with `reconnect: false` (replaced, session_ended,
   * forbidden, unsupported_protocol), or `ticket_refused` / `ticket_reused` after the edge refused
   * two fresh tickets in a row. Core's table decides, so a new final code needs no change here.
   */
  | SessionCloseName
  /** The ticket route refused: the user is signed out (401), or the session isn't theirs (404). */
  | "signed_out"
  | "not_found"
  /** The server's log disagrees with the client's, or the same gap keeps coming back. */
  | "desynced";

/** A ticket route refusal that can't be retried, as the reason the connection closes. */
export type TicketRefusal = Extract<
  ConnectionCloseReason,
  "signed_out" | "not_found" | "forbidden" | "session_ended"
>;

export type ConnectionEvent =
  | { readonly type: "start" }
  /** The ticket request failed: retry it later (after `Retry-After`, if given)... */
  | { readonly type: "ticket_failed"; readonly retryable: true; readonly retryAfterMs?: number }
  /** ...or stop for `reason`. */
  | { readonly type: "ticket_failed"; readonly retryable: false; readonly reason: TicketRefusal }
  /** The handshake finished. */
  | { readonly type: "opened" }
  | { readonly type: "welcome" }
  /** The socket closed without being asked to, or failed to open. */
  | { readonly type: "dropped"; readonly code: number }
  | { readonly type: "retry_due" }
  /** An event skipped ahead of the next expected seq. */
  | { readonly type: "gap"; readonly expectedSeq: number }
  /** No frame arrived within the heartbeat's deadline: the socket is dead. */
  | { readonly type: "heartbeat_timeout" }
  | { readonly type: "offline" }
  | { readonly type: "online" }
  /** The page was hidden on a platform that loses its sockets; the client already stopped capture. */
  | { readonly type: "hidden" }
  | { readonly type: "visible" }
  | { readonly type: "stop"; readonly reason?: "stopped" | "desynced" };

export type ConnectionEffect =
  /** Fetch a fresh ticket, then open a socket with it. */
  | { readonly type: "connect" }
  /** Abandon the ticket request or handshake in progress. */
  | { readonly type: "abort_connect" }
  | { readonly type: "send_hello" }
  /** Send every unacknowledged message, in order. */
  | { readonly type: "flush_outbox" }
  | { readonly type: "close_socket"; readonly code: number; readonly reason: string }
  | { readonly type: "start_heartbeat" }
  | { readonly type: "stop_heartbeat" }
  | { readonly type: "schedule_retry"; readonly delayMs: number }
  | { readonly type: "cancel_retry" };

export interface ConnectionContext {
  /** Connects that failed or dropped in a row since the last `welcome`. */
  readonly attempt: number;
  /** Tickets the edge refused in a row. */
  readonly ticketRefusals: number;
  /** The seq the last gap expected, and how many gaps in a row expected it. */
  readonly gapSeq: number | null;
  readonly gapRepeats: number;
  readonly online: boolean;
  readonly hidden: boolean;
  /** The last close code a socket reported. */
  readonly lastCode: number | null;
  readonly reason: ConnectionCloseReason | null;
}

export interface Connection {
  readonly state: ConnectionState;
  readonly context: ConnectionContext;
}

export interface ConnectionPolicy {
  /** The backoff before reconnect `attempt` (0 for the first). */
  readonly delay: (attempt: number) => number;
  /** The least wait after a `rate_limited` close (4002). */
  readonly rateLimitedDelayMs: number;
  /** Ticket refusals in a row before stopping. The protocol says 2: a fresh one, then stop. */
  readonly maxTicketRefusals: number;
  /** Resumes for the same gap before calling the logs out of sync. */
  readonly maxGapResumes: number;
}

export interface ConnectionStep {
  readonly connection: Connection;
  readonly effects: readonly ConnectionEffect[];
}

/** A socket the client closes itself always closes normally; the reason is for logs. */
export const CLIENT_CLOSE_CODE = 1000;

export const initialConnection: Connection = {
  state: "idle",
  context: {
    attempt: 0,
    ticketRefusals: 0,
    gapSeq: null,
    gapRepeats: 0,
    online: true,
    hidden: false,
    lastCode: null,
    reason: null,
  },
};

/** The connection a client starts from, given whether the page is online and visible now. */
export function connectionFor(page: { online: boolean; hidden: boolean }): Connection {
  return { state: "idle", context: { ...initialConnection.context, ...page } };
}

const step = (
  state: ConnectionState,
  context: ConnectionContext,
  effects: ConnectionEffect[] = [],
): ConnectionStep => ({ connection: { state, context }, effects });

const close = (reason: string): ConnectionEffect => ({
  type: "close_socket",
  code: CLIENT_CLOSE_CODE,
  reason,
});

/** The next state, and the effects to perform, for one event. Every pair is decided. */
export function connectionTransition(
  connection: Connection,
  event: ConnectionEvent,
  policy: ConnectionPolicy,
): ConnectionStep {
  const { state, context } = connection;
  const same = step(state, context);
  const flags = (patch: Partial<ConnectionContext>) => step(state, { ...context, ...patch });
  const closed = (reason: ConnectionCloseReason, effects: ConnectionEffect[] = []) =>
    step("closed", { ...context, reason }, effects);

  /** Waits to reconnect: offline and hidden wait for the page; otherwise a backoff timer. */
  const reconnectLater = (
    from: ConnectionContext,
    minDelayMs: number,
    effects: ConnectionEffect[],
  ): ConnectionStep => {
    const next = { ...from, attempt: from.attempt + 1 };
    if (from.hidden) return step("suspended", next, effects);
    if (!from.online) return step("offline", next, effects);
    const delayMs = Math.max(policy.delay(from.attempt), minDelayMs);
    return step("backoff", next, [...effects, { type: "schedule_retry", delayMs }]);
  };

  /** A socket closed on its own: stop, fetch a fresh ticket at once, or back off. */
  const dropped = (code: number, effects: ConnectionEffect[]): ConnectionStep => {
    const known = sessionCloseFor(code);
    const from = { ...context, lastCode: code };
    if (known && !known.reconnect) return step("closed", { ...from, reason: known.name }, effects);
    if (known?.name === "ticket_refused" || known?.name === "ticket_reused") {
      const ticketRefusals = from.ticketRefusals + 1;
      if (ticketRefusals >= policy.maxTicketRefusals) {
        return step("closed", { ...from, ticketRefusals, reason: known.name }, effects);
      }
      // A fresh ticket usually fixes it, so fetch one now rather than after a backoff.
      const next = { ...from, ticketRefusals, attempt: from.attempt + 1 };
      if (from.hidden) return step("suspended", next, effects);
      if (!from.online) return step("offline", next, effects);
      return step("connecting", next, [...effects, { type: "connect" }]);
    }
    const minDelayMs = known?.name === "rate_limited" ? policy.rateLimitedDelayMs : 0;
    return reconnectLater(from, minDelayMs, effects);
  };

  const connectNow = (from: ConnectionContext, effects: ConnectionEffect[] = []) =>
    step("connecting", from, [...effects, { type: "connect" }]);

  switch (state) {
    case "idle":
      switch (event.type) {
        case "start":
          if (context.hidden) return step("suspended", context);
          if (!context.online) return step("offline", context);
          return connectNow(context);
        case "offline":
          return flags({ online: false });
        case "online":
          return flags({ online: true });
        case "hidden":
          return flags({ hidden: true });
        case "visible":
          return flags({ hidden: false });
        case "stop":
          return closed(event.reason ?? "stopped");
        default:
          return same;
      }

    case "connecting":
      switch (event.type) {
        case "opened":
          return step("resuming", context, [{ type: "send_hello" }, { type: "start_heartbeat" }]);
        case "ticket_failed":
          if (!event.retryable) return closed(event.reason);
          return reconnectLater(context, event.retryAfterMs ?? 0, []);
        case "dropped":
          return dropped(event.code, []);
        case "offline":
          return flags({ online: false }); // the attempt finishes or fails on its own
        case "online":
          return flags({ online: true });
        case "hidden":
          return step("suspended", { ...context, hidden: true }, [{ type: "abort_connect" }]);
        case "visible":
          return flags({ hidden: false });
        case "stop":
          return closed(event.reason ?? "stopped", [{ type: "abort_connect" }]);
        default:
          return same;
      }

    case "resuming":
    case "open":
      switch (event.type) {
        case "welcome":
          return state === "resuming"
            ? step("open", { ...context, attempt: 0, ticketRefusals: 0 }, [
                { type: "flush_outbox" },
              ])
            : same; // a stray welcome changes nothing
        case "gap": {
          if (state === "resuming") return same; // the resume in flight covers it
          const gapRepeats = context.gapSeq === event.expectedSeq ? context.gapRepeats + 1 : 1;
          const next = { ...context, gapSeq: event.expectedSeq, gapRepeats };
          if (gapRepeats > policy.maxGapResumes) {
            return step("closed", { ...next, reason: "desynced" }, [
              { type: "stop_heartbeat" },
              close("desynced"),
            ]);
          }
          return step("resuming", next, [{ type: "send_hello" }]);
        }
        case "dropped":
          return dropped(event.code, [{ type: "stop_heartbeat" }]);
        case "heartbeat_timeout":
          return reconnectLater(context, 0, [{ type: "stop_heartbeat" }, close("heartbeat")]);
        case "offline":
          return flags({ online: false }); // the socket may well survive; the heartbeat decides
        case "online":
          return flags({ online: true });
        case "hidden":
          // iOS: the outbox goes out now (only once `welcome` said this is the right session),
          // then the socket closes cleanly, before the page is frozen with it half open.
          return step("suspended", { ...context, hidden: true }, [
            ...(state === "open" ? [{ type: "flush_outbox" } as const] : []),
            { type: "stop_heartbeat" },
            close("hidden"),
          ]);
        case "visible":
          return flags({ hidden: false });
        case "stop":
          return closed(event.reason ?? "stopped", [{ type: "stop_heartbeat" }, close("stopped")]);
        default:
          return same;
      }

    case "backoff":
      switch (event.type) {
        case "retry_due":
          return connectNow(context);
        case "online":
          // The network is back: don't sit out the rest of the backoff.
          return connectNow({ ...context, online: true, attempt: 0 }, [{ type: "cancel_retry" }]);
        case "offline":
          return step("offline", { ...context, online: false }, [{ type: "cancel_retry" }]);
        case "hidden":
          return step("suspended", { ...context, hidden: true }, [{ type: "cancel_retry" }]);
        case "visible":
          return flags({ hidden: false });
        case "stop":
          return closed(event.reason ?? "stopped", [{ type: "cancel_retry" }]);
        default:
          return same;
      }

    case "offline":
      switch (event.type) {
        case "online":
          return context.hidden
            ? step("suspended", { ...context, online: true })
            : connectNow({ ...context, online: true, attempt: 0 });
        case "offline":
          return flags({ online: false });
        case "hidden":
          return step("suspended", { ...context, hidden: true });
        case "visible":
          return flags({ hidden: false });
        case "stop":
          return closed(event.reason ?? "stopped");
        default:
          return same;
      }

    case "suspended":
      switch (event.type) {
        case "visible":
          return context.online
            ? connectNow({ ...context, hidden: false, attempt: 0 })
            : step("offline", { ...context, hidden: false });
        case "online":
          return flags({ online: true });
        case "offline":
          return flags({ online: false });
        case "hidden":
          return flags({ hidden: true });
        case "stop":
          return closed(event.reason ?? "stopped");
        default:
          return same;
      }

    case "closed":
      return same;
  }
}
