// SessionClient (spec WP8 step 1): the browser's half of the session socket protocol (§4.2).
//
// - Every connect uses a fresh ticket (SessionDO accepts a `jti` once), offered as the
//   subprotocols `["earshot.v1", "earshot.ticket.<ticket>"]`, so it stays out of URLs and logs.
// - On open it says `hello` with the last seq it folded; SessionDO answers `welcome` and replays
//   everything after, in order. A gap in seqs asks again (`hello` on the same socket).
// - Messages that change the session go through an in-memory outbox with UUIDv7 msgIds and are
//   resent, in order, until acknowledged. A `turn_end` key lives only there, and only until its
//   ack: never in the store, a log, or any storage.
// - Events are upcast, validated, and folded by `SessionStore` with the server's projections.
// - A `ping` heartbeat finds dead sockets. Drops reconnect with backoff and jitter, as each close
//   code's `reconnect` flag says. `online`, `offline`, and `visibilitychange` steer it, and on
//   iOS a hidden page stops capture, flushes, and closes cleanly before WebKit freezes it.
// - The tray's reviews and snoozes (Phase 5 WP3) go over the socket, split to fit its limits, until
//   SessionDO seals the session; then, or once the client has closed for good, they go to the web
//   route with the same review ids (`reviewRoute`), so each is written once, by one writer.
//
// The connection machine (`@earshot/voice/machines`) decides; this class performs its effects.
import {
  ClientMessage,
  type EntityRef,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  type LlmProvider,
  MAX_MESSAGE_BYTES,
  parseServerMessage,
  type ReviewInput,
  SESSION_PROTOCOL_VERSION,
  SESSION_SUBPROTOCOL,
  type ServerMessage,
  type ServerMessageOf,
  type SessionProviders,
  type SnoozeInput,
  type TurnMarks,
  type TurnTrigger,
  ticketSubprotocol,
  type UtteranceFinalV2,
  uuidv7,
  type WitnessReason,
} from "@earshot/core";
import type { EventRegistry, SessionEvent } from "@earshot/events";
import { type BackoffOptions, backoffDelay } from "../machines/backoff";
import {
  type Connection,
  type ConnectionCloseReason,
  type ConnectionEffect,
  type ConnectionEvent,
  type ConnectionPolicy,
  connectionFor,
  connectionTransition,
} from "../machines/connection";
import { fitUtterance } from "../stt/normalize";
import {
  type Clock,
  createBrowserSocket,
  SOCKET_OPEN,
  type SocketFactory,
  type SocketLike,
  systemClock,
} from "../stt/socket";
import type { UnbiasedUtterance } from "../witness/runner";
import { browserPageLifecycle, type PageEvent, type PageLifecycle } from "./lifecycle";
import { Outbox, type OutboxItem, type OutboxMessage } from "./outbox";
import {
  type ReviewRoute,
  ReviewRouteFailure,
  type ReviewRouteRequestBody,
  reviewFrameBytes,
  splitReviews,
} from "./reviews";
import { type ConnectionView, type SessionIssue, SessionStore } from "./store";
import { type SessionTicket, SessionTicketError } from "./ticket";

/** Debug logging: message types, codes, and counts only. Never a payload, a ticket, or a key. */
export interface SessionLog {
  debug(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
}

const SILENT_LOG: SessionLog = { debug: () => {} };

export interface SessionClientOptions {
  readonly sessionId: string;
  /** The session socket's URL, `wss://<edge>/v1/sessions/<id>/ws` (WP3's `edgeUrl`). */
  readonly url: string;
  /** A fresh ticket for one connect: `POST /api/sessions/:id/ticket` (`createTicketFetcher`). */
  readonly getTicket: (signal: AbortSignal) => Promise<SessionTicket>;
  /** The ticket `POST /api/sessions` answered with: used for the first connect while fresh. */
  readonly initialTicket?: SessionTicket;
  readonly socket?: SocketFactory;
  readonly clock?: Clock;
  /** For jitter; tests pass a constant. */
  readonly random?: () => number;
  /** msgIds. Defaults to UUIDv7. */
  readonly createId?: () => string;
  /** Defaults to the browser's page, or a steady one outside a browser. */
  readonly page?: PageLifecycle;
  /**
   * On a hidden iOS page, before the flush: stop capture here (`engine.stop()`), so the last
   * turn's finals and `turn_end` reach the outbox first. Waited for up to `suspendTimeoutMs`.
   */
  readonly onSuspend?: () => void | Promise<void>;
  readonly log?: SessionLog;
  /** The store to fold into. Defaults to a new one; pass one to share it before connecting. */
  readonly store?: SessionStore;
  readonly registry?: EventRegistry<SessionEvent>;
  /** Ping after this long (target 20 s), and expect any frame back within `pongTimeoutMs`. */
  readonly heartbeatMs?: number;
  readonly pongTimeoutMs?: number;
  /** Cumulative acks wait this long, so a replay of many events costs one ack. */
  readonly ackDelayMs?: number;
  /** Reconnect backoff: full jitter, from `baseMs` (500) up to `maxMs` (15 s). */
  readonly backoff?: Omit<BackoffOptions, "random">;
  /** The least wait after a `rate_limited` close (4002). */
  readonly rateLimitedDelayMs?: number;
  /**
   * The client's own send budget per socket, kept under SessionDO's 20 messages a second (burst
   * 20) so it never refuses a message, which could reorder a turn's utterances and its
   * `turn_end`. Heartbeats don't count: the runtime answers them.
   */
  readonly sendBudget?: { readonly burst: number; readonly perSecond: number };
  /** How long to wait before resending after a retryable refusal. */
  readonly resendDelayMs?: number;
  readonly suspendTimeoutMs?: number;
  /** A ticket this close to expiring isn't used for a connect. */
  readonly ticketMarginMs?: number;
  /**
   * Where a review or snooze goes once the session is sealed: the web route
   * (`createReviewRoute`). Without it, one the socket refuses with `sealed` is reported refused.
   */
  readonly reviewRoute?: ReviewRoute;
}

export interface SendStartInput {
  readonly providers: SessionProviders;
  /** When capture started, by the client's clock. */
  readonly startedAt: string;
  /** From `POST /api/sessions`, unchanged: each record with its `parentId`, where it has one. */
  readonly entities: readonly EntityRef[];
  /** The rep's IANA time zone, so "by Thursday" resolves on their calendar. */
  readonly timeZone?: string;
  /**
   * The account open in Earshot, from `POST /api/sessions`: one of `entities`. The linker reads
   * it as context, and a proposal that names no record targets it. Null or absent for none.
   */
  readonly focusEntityId?: string | null;
}

export interface SendTurnEndInput {
  readonly turnId: string;
  readonly trigger: TurnTrigger;
  readonly llm: { readonly provider: LlmProvider; readonly model: string };
  /** This turn's LLM key, from the device: held until the ack, then dropped. */
  readonly key: string;
}

export interface SendUsageInput {
  readonly provider: string;
  readonly model: string;
  readonly audioMs: number;
  readonly socketMs: number;
}

/**
 * A turn's second witness (Phase 4 WP9): its unbiased transcript, or why there's none. The audio
 * and the witness's key went from the browser to its provider; neither is here.
 */
export type SendWitnessInput = {
  readonly turnId: string;
  /** The witness's provider and model, such as `groq` and `whisper-large-v3-turbo`. */
  readonly provider: string;
  readonly model: string;
  /** How long the witness took, by the client's clock. */
  readonly latencyMs?: number;
} & (
  | { readonly outcome: "transcribed"; readonly utterance: UnbiasedUtterance }
  | { readonly outcome: "failed" | "skipped"; readonly reason: WitnessReason }
);

/** What SessionDO answered a message with. */
export interface MessageAck {
  /** The last event the message appended, if it appended any. */
  readonly seq: number | undefined;
}

/**
 * Where one slice of reviews (one `review` message's worth), or one snooze, was written: by
 * SessionDO over the socket, or by the web route after the seal; or why neither took it.
 */
export type ReviewDelivery =
  | {
      readonly ok: true;
      readonly via: "socket" | "route";
      /** The `reviewId`s (or the `snoozeId`) written. */
      readonly ids: readonly string[];
      /** The last seq the write reached, when the writer said. */
      readonly seq: number | undefined;
    }
  | {
      readonly ok: false;
      readonly ids: readonly string[];
      /**
       * SessionDO's error code (`bad_message`, `internal`, ...), the route's (`stale`,
       * `not_sealed`, ...), `too_large` for a review no frame can hold, or `closed`.
       */
      readonly code: string;
    };

/** The connection closed for good before a message was acknowledged. */
export class SessionClosedError extends Error {
  override readonly name = "SessionClosedError";
  readonly reason: ConnectionCloseReason;

  constructor(reason: ConnectionCloseReason) {
    super(`the session connection closed: ${reason}`);
    this.reason = reason;
  }
}

/** SessionDO refused a message for good. */
export class MessageRefusedError extends Error {
  override readonly name = "MessageRefusedError";
  readonly code: string;

  constructor(code: string) {
    super(`the session refused the message: ${code}`);
    this.code = code;
  }
}

interface Waiter {
  readonly resolve: (ack: MessageAck) => void;
  readonly reject: (error: Error) => void;
}

const TIMER_NAMES = ["retry", "ping", "pong", "welcome", "ack", "resend", "drain"] as const;
type TimerName = (typeof TIMER_NAMES)[number];

/** Retryable refusals of one message before the client gives up on it. */
const MAX_REFUSALS = 5;

export function createSessionClient(options: SessionClientOptions): SessionClient {
  return new SessionClient(options);
}

export class SessionClient {
  readonly sessionId: string;
  readonly store: SessionStore;
  readonly #getTicket: (signal: AbortSignal) => Promise<SessionTicket>;
  readonly #socketFactory: SocketFactory;
  readonly #clock: Clock;
  readonly #random: () => number;
  readonly #createId: () => string;
  readonly #page: PageLifecycle;
  readonly #onSuspend: (() => void | Promise<void>) | undefined;
  readonly #log: SessionLog;
  readonly #policy: ConnectionPolicy;
  readonly #settings: {
    heartbeatMs: number;
    pongTimeoutMs: number;
    ackDelayMs: number;
    burst: number;
    perSecond: number;
    resendDelayMs: number;
    suspendTimeoutMs: number;
    ticketMarginMs: number;
  };
  readonly #reviewRoute: ReviewRoute | undefined;
  readonly #outbox = new Outbox();
  readonly #waiters = new Map<string, Waiter[]>();
  readonly #refusals = new Map<string, number>();
  readonly #timers: Partial<Record<TimerName, unknown>> = {};

  #url: string;
  #initialTicket: SessionTicket | undefined;
  #connection: Connection;
  #queue: ConnectionEvent[] = [];
  #dispatching = false;
  #retryAt: number | null = null;
  #socket: SocketLike | undefined;
  /** Bumped on every connect and every close the client makes; stale callbacks compare it. */
  #generation = 0;
  #connectAbort: AbortController | undefined;
  #lastAckSent = -1;
  #budget = { tokens: 0, at: 0 };
  #unsubscribePage: (() => void) | undefined;
  #suspendToken = 0;
  #started = false;

  constructor(options: SessionClientOptions) {
    this.sessionId = options.sessionId;
    this.#url = options.url;
    this.#getTicket = options.getTicket;
    this.#initialTicket = options.initialTicket;
    this.#socketFactory = options.socket ?? createBrowserSocket;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
    this.#createId = options.createId ?? uuidv7;
    this.#page = options.page ?? browserPageLifecycle();
    this.#onSuspend = options.onSuspend;
    this.#reviewRoute = options.reviewRoute;
    this.#log = options.log ?? SILENT_LOG;
    this.store =
      options.store ??
      new SessionStore(options.sessionId, {
        now: () => this.#clock.now(),
        ...(options.registry ? { registry: options.registry } : {}),
      });
    if (this.store.sessionId !== options.sessionId) {
      throw new Error("the store belongs to another session");
    }
    const backoff = { baseMs: 500, maxMs: 15_000, ...options.backoff };
    this.#policy = {
      delay: (attempt) => backoffDelay(attempt, { ...backoff, random: this.#random }),
      rateLimitedDelayMs: options.rateLimitedDelayMs ?? 5_000,
      maxTicketRefusals: 2,
      maxGapResumes: 3,
    };
    this.#settings = {
      heartbeatMs: options.heartbeatMs ?? 20_000,
      pongTimeoutMs: options.pongTimeoutMs ?? 10_000,
      ackDelayMs: options.ackDelayMs ?? 250,
      burst: options.sendBudget?.burst ?? 16,
      perSecond: options.sendBudget?.perSecond ?? 10,
      resendDelayMs: options.resendDelayMs ?? 1_000,
      suspendTimeoutMs: options.suspendTimeoutMs ?? 1_000,
      ticketMarginMs: options.ticketMarginMs ?? 5_000,
    };
    this.#connection = connectionFor({ online: this.#page.online, hidden: false });
  }

  /** The connection machine's state, as the store shows it. */
  get connection(): ConnectionView {
    return this.store.getState().connection;
  }

  /** Starts connecting. Messages sent before this wait in the outbox. */
  start(): void {
    if (this.#started || this.#connection.state !== "idle") return;
    this.#started = true;
    this.#unsubscribePage = this.#page.subscribe((event) => this.#onPage(event));
    this.#connection = connectionFor({
      online: this.#page.online,
      hidden: this.#page.hidden && this.#page.suspendsWhenHidden,
    });
    this.#dispatch({ type: "start" });
  }

  /** Closes for good. Unacknowledged messages are dropped, turn keys with them. */
  stop(): void {
    this.#dispatch({ type: "stop" });
  }

  /** Skips the rest of a backoff: the screen's "Reconnect now". */
  reconnectNow(): void {
    if (this.#connection.state === "backoff") this.#dispatch({ type: "retry_due" });
  }

  // ─── Actions ─────────────────────────────────────────────────────────────────────────────────

  /** `start`: once, first. Returns the msgId, or null if the message was refused here. */
  sendStart(input: SendStartInput): string | null {
    return this.#enqueue({
      t: "start",
      msgId: this.#createId(),
      mode: "debrief",
      engine: "cascaded",
      providers: input.providers,
      startedAt: input.startedAt,
      entities: [...input.entities],
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      ...(input.focusEntityId ? { focusEntityId: input.focusEntityId } : {}),
    });
  }

  /** A final transcript segment, as the voice engine's `final` event carries it. */
  sendUtterance(turnId: string, utterance: UtteranceFinalV2): string | null {
    // An utterance too big for one frame (long text, or many word timings) goes as several, in
    // order, so none is refused and the turn keeps every word. Returns the last part's msgId.
    let msgId: string | null = null;
    for (const part of fitUtterance(utterance)) {
      msgId = this.#enqueue({ t: "utterance", msgId: this.#createId(), turnId, utterance: part });
      if (msgId === null) return null;
    }
    return msgId;
  }

  /** The turn is over: SessionDO runs its extraction with this key, once. */
  sendTurnEnd(input: SendTurnEndInput): string | null {
    return this.#enqueue({
      t: "turn_end",
      msgId: this.#createId(),
      turnId: input.turnId,
      trigger: input.trigger,
      llm: { provider: input.llm.provider, model: input.llm.model },
      key: input.key,
    });
  }

  /** One closed speech socket's usage, for the cost meter. */
  sendUsage(input: SendUsageInput): string | null {
    return this.#enqueue({
      t: "usage",
      msgId: this.#createId(),
      provider: input.provider,
      model: input.model,
      audioMs: Math.max(0, Math.round(input.audioMs)),
      socketMs: Math.max(0, Math.round(input.socketMs)),
    });
  }

  /**
   * A turn's second witness, after that turn's `turn_end`: SessionDO compares it with the turn's
   * proposals and flags where the two witnesses disagree.
   */
  sendWitness(input: SendWitnessInput): string | null {
    const base = {
      t: "witness" as const,
      msgId: this.#createId(),
      turnId: input.turnId,
      provider: input.provider,
      model: input.model,
      ...(input.latencyMs === undefined
        ? {}
        : { latencyMs: Math.max(0, Math.round(input.latencyMs)) }),
    };
    return this.#enqueue(
      input.outcome === "transcribed"
        ? { ...base, outcome: "transcribed", utterance: input.utterance }
        : { ...base, outcome: input.outcome, reason: input.reason },
    );
  }

  /** One turn's latency marks, on the client's clock; SessionDO records `turn.measured`. */
  sendMetric(turnId: string, marks: TurnMarks): string | null {
    return this.#enqueue({ t: "metric", msgId: this.#createId(), turnId, marks });
  }

  /**
   * The tray's reviews: one decision, or an "accept all" of any size, sent in order as as many
   * `review` messages as the socket's limits need (25 reviews and 64 KiB a message; a batch keeps
   * its `batchId` across them). Resolves with one delivery per message once each is settled; it
   * never rejects. A message SessionDO refuses with `sealed`, and every message once the client has
   * closed for good, goes to the web route instead (`reviewRoute`), with the same review ids.
   */
  sendReview(reviews: readonly ReviewInput[]): Promise<ReviewDelivery[]> {
    const sends = splitReviews(reviews).map((part) => {
      const ids = part.map((review) => review.reviewId);
      if (reviewFrameBytes(part) > MAX_MESSAGE_BYTES) {
        this.#log.debug("message refused here", { t: "review", reason: "too_large" });
        return Promise.resolve<ReviewDelivery>({ ok: false, ids, code: "too_large" });
      }
      return this.#sendWrite(
        { t: "review", msgId: this.#createId(), reviews: part },
        { reviews: part, snoozes: [] },
        ids,
      );
    });
    return Promise.all(sends);
  }

  /** A snooze, or a wake (`until: null`), under the same rules as `sendReview`. */
  sendSnooze(snooze: SnoozeInput): Promise<ReviewDelivery> {
    return this.#sendWrite(
      { t: "snooze", msgId: this.#createId(), ...snooze },
      {
        reviews: [],
        snoozes: [snooze],
      },
      [snooze.snoozeId],
    );
  }

  /**
   * Sends a `review` or `snooze` over the socket and waits for its answer, falling back to the web
   * route for `sealed`, or when the client has closed for good. The waiter is registered as the
   * message is queued, so no answer can arrive before it.
   */
  #sendWrite(
    message: Extract<OutboxMessage, { t: "review" } | { t: "snooze" }>,
    request: ReviewRouteRequestBody,
    ids: readonly string[],
  ): Promise<ReviewDelivery> {
    const toRoute = async (): Promise<ReviewDelivery> => {
      if (!this.#reviewRoute) return { ok: false, ids, code: "sealed" };
      try {
        const answer = await this.#reviewRoute(request);
        this.#log.debug("written by the route", { t: message.t });
        return { ok: true, via: "route", ids, seq: answer.lastSeq };
      } catch (error) {
        return {
          ok: false,
          ids,
          code: error instanceof ReviewRouteFailure ? error.code : "unavailable",
        };
      }
    };
    if (this.#connection.state === "closed") return toRoute();
    const msgId = this.#enqueue(message);
    if (msgId === null) return Promise.resolve({ ok: false, ids, code: "bad_message" });
    return this.acked(msgId).then(
      (ack): ReviewDelivery => ({ ok: true, via: "socket", ids, seq: ack.seq }),
      (error: unknown): Promise<ReviewDelivery> | ReviewDelivery => {
        if (error instanceof MessageRefusedError && error.code === "sealed") return toRoute();
        if (error instanceof SessionClosedError) return toRoute();
        return {
          ok: false,
          ids,
          code: error instanceof MessageRefusedError ? error.code : "closed",
        };
      },
    );
  }

  /** Ends the session. Resolves once SessionDO has acknowledged it. */
  end(endedAt: string = new Date().toISOString()): Promise<MessageAck> {
    const msgId = this.#enqueue({ t: "end", msgId: this.#createId(), endedAt });
    return msgId ? this.acked(msgId) : Promise.reject(new MessageRefusedError("bad_message"));
  }

  /** Resolves when SessionDO acknowledges `msgId`; rejects if it's refused or the client closes. */
  acked(msgId: string): Promise<MessageAck> {
    if (!this.#outbox.has(msgId)) return Promise.resolve({ seq: undefined });
    return new Promise((resolve, reject) => {
      this.#waiters.set(msgId, [...(this.#waiters.get(msgId) ?? []), { resolve, reject }]);
    });
  }

  /** Records a problem found outside the client, such as a turn with no LLM key on the device. */
  reportIssue(issue: Omit<SessionIssue, "at" | "source">): void {
    this.store.dispatch({
      type: "issue",
      issue: { ...issue, source: "client", at: this.#clock.now() },
    });
  }

  /** The messages waiting for an ack, in order. Never with a key. */
  pendingMessages(): OutboxItem[] {
    return this.#outbox.items();
  }

  #enqueue(message: OutboxMessage): string | null {
    if (this.#connection.state === "closed") return null;
    // The same schema SessionDO parses with: a message it would refuse never leaves.
    const parsed = ClientMessage.safeParse(message);
    if (!parsed.success) {
      this.#log.debug("message refused here", { t: message.t });
      this.reportIssue({ code: "bad_message", retryable: false, msgId: message.msgId });
      return null;
    }
    // SessionDO refuses a frame past MAX_MESSAGE_BYTES before it can read the msgId, so a message
    // that big would sit in the outbox forever: refuse it here instead.
    if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_MESSAGE_BYTES) {
      this.#log.debug("message refused here", { t: message.t, reason: "too_large" });
      this.reportIssue({ code: "too_large", retryable: false, msgId: message.msgId });
      return null;
    }
    this.#outbox.add(message);
    this.#pendingChanged();
    this.#log.debug("queued", { t: message.t });
    this.#flush();
    return message.msgId;
  }

  // ─── The connection machine ──────────────────────────────────────────────────────────────────

  #dispatch(event: ConnectionEvent): void {
    this.#queue.push(event);
    if (this.#dispatching) return; // effects that dispatch run after the current step
    this.#dispatching = true;
    try {
      for (let next = this.#queue.shift(); next; next = this.#queue.shift()) {
        const before = this.#connection.state;
        const step = connectionTransition(this.#connection, next, this.#policy);
        this.#connection = step.connection;
        if (before !== step.connection.state) {
          this.#log.debug("connection", { from: before, to: step.connection.state, on: next.type });
        }
        for (const effect of step.effects) this.#run(effect);
        if (step.connection.state === "closed" && before !== "closed") this.#teardown();
        this.#publishConnection();
      }
    } finally {
      this.#dispatching = false;
    }
  }

  #run(effect: ConnectionEffect): void {
    switch (effect.type) {
      case "connect":
        void this.#connect();
        return;
      case "abort_connect":
        this.#connectAbort?.abort();
        this.#connectAbort = undefined;
        this.#closeSocket(1000, "abandoned");
        return;
      case "send_hello":
        this.#sendHello();
        return;
      case "flush_outbox":
        this.#flush();
        return;
      case "close_socket":
        this.#closeSocket(effect.code, effect.reason);
        return;
      case "start_heartbeat":
        this.#armPing();
        return;
      case "stop_heartbeat":
        // The socket is going: its heartbeat and any wait for its `welcome` go with it.
        this.#clearTimer("ping");
        this.#clearTimer("pong");
        this.#clearTimer("welcome");
        return;
      case "schedule_retry":
        this.#clearTimer("retry");
        this.#retryAt = this.#clock.now() + effect.delayMs;
        this.#timers.retry = this.#clock.setTimeout(() => {
          this.#retryAt = null;
          this.#dispatch({ type: "retry_due" });
        }, effect.delayMs);
        return;
      case "cancel_retry":
        this.#clearTimer("retry");
        this.#retryAt = null;
        return;
    }
  }

  #publishConnection(): void {
    const { state, context } = this.#connection;
    this.store.dispatch({
      type: "connection",
      connection: {
        state,
        attempt: context.attempt,
        online: context.online,
        reason: context.reason,
        lastCode: context.lastCode,
        retryAt: state === "backoff" ? this.#retryAt : null,
      },
    });
  }

  async #connect(): Promise<void> {
    const generation = ++this.#generation;
    const abort = new AbortController();
    this.#connectAbort = abort;
    let ticket: SessionTicket;
    try {
      ticket = this.#takeInitialTicket() ?? (await this.#getTicket(abort.signal));
    } catch (error) {
      if (abort.signal.aborted || generation !== this.#generation) return;
      this.#connectAbort = undefined;
      this.#log.debug("ticket failed", {
        code: error instanceof SessionTicketError ? error.code : "error",
      });
      this.#dispatch(ticketFailure(error));
      return;
    }
    if (abort.signal.aborted || generation !== this.#generation) return;
    this.#connectAbort = undefined;
    if (ticket.edgeUrl) this.#url = ticket.edgeUrl;

    let socket: SocketLike;
    try {
      socket = this.#socketFactory(this.#url, [
        SESSION_SUBPROTOCOL,
        ticketSubprotocol(ticket.ticket),
      ]);
    } catch {
      this.#dispatch({ type: "dropped", code: 1006 });
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (generation !== this.#generation) return;
      // A server that picked another subprotocol speaks something else; "" means the server is
      // about to close with a code of its own, which says more.
      if (socket.protocol !== "" && socket.protocol !== SESSION_SUBPROTOCOL) {
        this.#closeSocket(1002, "subprotocol");
        this.#dispatch({ type: "dropped", code: 4008 });
        return;
      }
      this.#budget = { tokens: this.#settings.burst, at: this.#clock.now() };
      this.#lastAckSent = -1;
      this.#outbox.markUnsent(); // a new socket: everything unacknowledged goes again
      this.#dispatch({ type: "opened" });
    };
    socket.onmessage = (message) => {
      if (generation === this.#generation) this.#onFrame(message.data);
    };
    socket.onclose = (close) => {
      if (generation !== this.#generation) return;
      this.#socket = undefined;
      this.#log.debug("socket closed", { code: close.code });
      this.#dispatch({ type: "dropped", code: close.code });
    };
    socket.onerror = () => {}; // a close follows
  }

  #takeInitialTicket(): SessionTicket | undefined {
    const ticket = this.#initialTicket;
    this.#initialTicket = undefined; // one connection per ticket, used or not
    if (!ticket) return undefined;
    if (ticket.ticketExpiresAt) {
      const expires = Date.parse(ticket.ticketExpiresAt);
      if (!Number.isFinite(expires) || expires - Date.now() < this.#settings.ticketMarginMs) {
        return undefined;
      }
    }
    return ticket;
  }

  #closeSocket(code: number, reason: string): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#generation += 1; // its late callbacks are stale now
    if (!socket) return;
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  // ─── Frames ──────────────────────────────────────────────────────────────────────────────────

  #onFrame(data: string | ArrayBuffer): void {
    this.#clearTimer("pong"); // any frame proves the socket is alive
    if (data === HEARTBEAT_PONG) return;
    const parsed = parseServerMessage(data);
    if (!parsed.ok) {
      this.#log.debug("server frame refused", { reason: parsed.reason });
      this.reportIssue({ code: "bad_server_message", retryable: false });
      return;
    }
    this.#onMessage(parsed.message);
  }

  #onMessage(message: ServerMessage): void {
    switch (message.t) {
      case "welcome":
        this.#onWelcome(message);
        return;
      case "event":
        this.#onEvent(message);
        return;
      case "ack":
        this.#onAck(message);
        return;
      case "working":
        this.store.dispatch({ type: "working", message, at: this.#clock.now() });
        return;
      case "error":
        this.#onError(message);
        return;
    }
  }

  #onWelcome(message: ServerMessageOf<"welcome">): void {
    if (this.#connection.state !== "resuming") return;
    this.#clearTimer("welcome");
    const { lastSeq } = this.store.getState();
    if (message.sessionId !== this.sessionId || message.lastSeq < lastSeq) {
      // Another session's socket, or a server that has lost events this client folded.
      this.#log.debug("welcome refused", { serverLastSeq: message.lastSeq, lastSeq });
      this.reportIssue({ code: "desynced", retryable: false });
      this.#dispatch({ type: "stop", reason: "desynced" });
      return;
    }
    this.#dispatch({ type: "welcome" });
  }

  #onEvent(message: ServerMessageOf<"event">): void {
    // Before `welcome`, events are ones the resume will replay: drop them.
    if (this.#connection.state !== "open") return;
    const result = this.store.applyEvent(message.event, this.#clock.now());
    switch (result.kind) {
      case "applied":
        this.#scheduleAck();
        return;
      case "gap":
        this.#log.debug("gap", { expectedSeq: result.expectedSeq, seq: message.event.seq });
        this.#dispatch({ type: "gap", expectedSeq: result.expectedSeq });
        return;
      case "outdated":
      case "invalid":
        // Folding has stopped (the store says why); the outbox keeps delivering.
        this.#log.debug("fold stopped", { kind: result.kind, seq: message.event.seq });
        return;
      default:
        return;
    }
  }

  #onAck(message: ServerMessageOf<"ack">): void {
    const item = this.#outbox.remove(message.msgId);
    if (!item) return; // a resend's second ack, or one this client never sent
    this.#log.debug("acked", { t: item.t });
    this.#settle(message.msgId, (waiter) => waiter.resolve({ seq: message.seq }));
  }

  /** Forgets a message the outbox no longer holds, and answers whoever waits on it. */
  #settle(msgId: string, answer: (waiter: Waiter) => void): void {
    this.#refusals.delete(msgId);
    this.#pendingChanged();
    const waiters = this.#waiters.get(msgId) ?? [];
    this.#waiters.delete(msgId);
    for (const waiter of waiters) answer(waiter);
  }

  #onError(message: ServerMessageOf<"error">): void {
    const { code, retryable, msgId } = message;
    this.#log.debug("server error", { code, retryable });
    this.store.dispatch({
      type: "issue",
      issue: {
        source: "server",
        code,
        retryable,
        ...(msgId ? { msgId } : {}),
        at: this.#clock.now(),
      },
    });
    if (msgId) {
      // An error after an ack (a turn that failed at the provider) is only news for the screen.
      if (!this.#outbox.has(msgId)) return;
      const refusals = (this.#refusals.get(msgId) ?? 0) + 1;
      if (!retryable || refusals > MAX_REFUSALS) {
        this.#outbox.remove(msgId); // a turn key goes with it
        this.#settle(msgId, (waiter) => waiter.reject(new MessageRefusedError(code)));
        return;
      }
      this.#refusals.set(msgId, refusals);
      this.#outbox.markUnsent([msgId]);
      this.#scheduleResend();
      return;
    }
    if (code === "rate_limited") {
      // SessionDO dropped a message unparsed, so its msgId is unknown: send again whatever is
      // still unanswered on this socket, once the rate has recovered.
      this.#outbox.markUnsent(this.#outbox.inFlight());
      this.#scheduleResend();
    }
  }

  // ─── Sending ─────────────────────────────────────────────────────────────────────────────────

  /** Sends the outbox's unsent messages in order, within the send budget. */
  #flush(): void {
    if (this.#connection.state !== "open" || !this.#isOpen()) return;
    for (const msgId of this.#outbox.unsent()) {
      if (!this.#takeToken()) {
        this.#scheduleDrain();
        return;
      }
      this.#socket?.send(this.#outbox.frame(msgId));
      this.#outbox.markSent(msgId);
    }
  }

  /**
   * `hello`, with the last seq folded. It goes even past the send budget, since nothing else can
   * move until it's answered, and a `welcome` that never comes counts as a dead socket.
   */
  #sendHello(): void {
    if (!this.#isOpen()) return;
    this.#takeToken();
    const hello: ClientMessage = {
      t: "hello",
      protocol: SESSION_PROTOCOL_VERSION,
      lastSeq: this.store.getState().lastSeq,
    };
    this.#socket?.send(JSON.stringify(hello));
    this.#clearTimer("welcome");
    this.#timers.welcome = this.#clock.setTimeout(() => {
      delete this.#timers.welcome;
      this.#log.debug("welcome timed out");
      this.#dispatch({ type: "heartbeat_timeout" });
    }, this.#settings.pongTimeoutMs);
  }

  /** `ack`: not kept in the outbox, but within the budget like everything else. */
  #sendNow(message: ClientMessage): boolean {
    if (!this.#isOpen() || !this.#takeToken()) return false;
    this.#socket?.send(JSON.stringify(message));
    return true;
  }

  #isOpen(): boolean {
    return this.#socket?.readyState === SOCKET_OPEN;
  }

  #takeToken(): boolean {
    const now = this.#clock.now();
    const { burst, perSecond } = this.#settings;
    const refill = (Math.max(0, now - this.#budget.at) / 1000) * perSecond;
    this.#budget = { tokens: Math.min(burst, this.#budget.tokens + refill), at: now };
    if (this.#budget.tokens < 1) return false;
    this.#budget.tokens -= 1;
    return true;
  }

  #scheduleDrain(): void {
    if (this.#timers.drain !== undefined) return;
    const waitMs = Math.ceil(((1 - this.#budget.tokens) / this.#settings.perSecond) * 1000);
    this.#timers.drain = this.#clock.setTimeout(
      () => {
        delete this.#timers.drain;
        this.#flush();
        if (this.#ackDue()) this.#sendAck();
      },
      Math.max(1, waitMs),
    );
  }

  #scheduleResend(): void {
    if (this.#timers.resend !== undefined) return;
    this.#timers.resend = this.#clock.setTimeout(() => {
      delete this.#timers.resend;
      this.#flush();
    }, this.#settings.resendDelayMs);
  }

  #scheduleAck(): void {
    if (this.#timers.ack !== undefined) return;
    this.#timers.ack = this.#clock.setTimeout(() => {
      delete this.#timers.ack;
      this.#sendAck();
    }, this.#settings.ackDelayMs);
  }

  #ackDue(): boolean {
    return this.store.getState().lastSeq > this.#lastAckSent;
  }

  #sendAck(): void {
    if (this.#connection.state !== "open" || !this.#ackDue()) return;
    const seq = this.store.getState().lastSeq;
    if (this.#sendNow({ t: "ack", seq })) this.#lastAckSent = seq;
    else this.#scheduleDrain();
  }

  #armPing(): void {
    this.#clearTimer("ping");
    this.#timers.ping = this.#clock.setTimeout(() => {
      delete this.#timers.ping;
      if (!this.#isOpen()) return;
      this.#socket?.send(HEARTBEAT_PING);
      if (this.#timers.pong === undefined) {
        this.#timers.pong = this.#clock.setTimeout(() => {
          delete this.#timers.pong;
          this.#log.debug("heartbeat timed out");
          this.#dispatch({ type: "heartbeat_timeout" });
        }, this.#settings.pongTimeoutMs);
      }
      this.#armPing();
    }, this.#settings.heartbeatMs);
  }

  #pendingChanged(): void {
    this.store.dispatch({ type: "pending", pending: this.#outbox.size });
  }

  // ─── The page ────────────────────────────────────────────────────────────────────────────────

  #onPage(event: PageEvent): void {
    switch (event) {
      case "online":
      case "offline":
        this.#dispatch({ type: event });
        return;
      case "hidden":
        if (this.#page.suspendsWhenHidden) void this.#suspend();
        return;
      case "visible":
        this.#suspendToken += 1; // a suspend still running is called off
        this.#dispatch({ type: "visible" });
        return;
    }
  }

  /** iOS: stop capture, flush the outbox and the ack, then close until the page is visible. */
  async #suspend(): Promise<void> {
    const token = ++this.#suspendToken;
    if (this.#onSuspend) {
      let timer: unknown;
      try {
        await Promise.race([
          Promise.resolve().then(() => this.#onSuspend?.()),
          new Promise<void>((resolve) => {
            timer = this.#clock.setTimeout(resolve, this.#settings.suspendTimeoutMs);
          }),
        ]);
      } catch {
        // Capture failing to stop mustn't keep the outbox from flushing.
      } finally {
        this.#clock.clearTimeout(timer);
      }
    }
    if (token !== this.#suspendToken) return;
    this.#flush();
    this.#sendAck();
    this.#dispatch({ type: "hidden" });
  }

  // ─── Teardown ────────────────────────────────────────────────────────────────────────────────

  #teardown(): void {
    for (const name of TIMER_NAMES) this.#clearTimer(name);
    this.#retryAt = null;
    this.#unsubscribePage?.();
    this.#unsubscribePage = undefined;
    this.#connectAbort?.abort();
    this.#connectAbort = undefined;
    this.#closeSocket(1000, "closed");
    const reason = this.#connection.context.reason ?? "stopped";
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) waiter.reject(new SessionClosedError(reason));
    }
    this.#waiters.clear();
    this.#refusals.clear();
    // Nothing more can be delivered: drop the messages, and every turn key with them.
    this.#outbox.clear();
    this.#pendingChanged();
  }

  #clearTimer(name: TimerName): void {
    const handle = this.#timers[name];
    if (handle !== undefined) this.#clock.clearTimeout(handle);
    delete this.#timers[name];
  }
}

/** The connection machine's event for a failed ticket request. */
function ticketFailure(error: unknown): ConnectionEvent {
  if (error instanceof SessionTicketError) {
    const refusal = error.refusal;
    if (refusal) return { type: "ticket_failed", retryable: false, reason: refusal };
    return error.retryAfterMs === undefined
      ? { type: "ticket_failed", retryable: true }
      : { type: "ticket_failed", retryable: true, retryAfterMs: error.retryAfterMs };
  }
  // A network failure or a getTicket of the app's own: worth another try, later.
  return { type: "ticket_failed", retryable: true };
}
