// SessionDO: one Durable Object per capture session (docs/adr/0003, Phase 3 spec WP6).
//
// - It holds the session's socket with the hibernation API, so an idle session costs nothing.
// - It writes every event to its own SQLite before anything leaves it, numbered from 0, with
//   UUIDv7 ids and the DO's clock (spec §4.4).
// - Every client message that changes state carries a msgId: its events and its `client_msgs` row
//   commit together, so a resend gets the same answer and changes nothing.
// - A client resumes from its last seq after any drop: `hello` replays what it missed.
// - `turn_end` runs extraction through `@earshot/agent`'s `runTurn`, one turn at a time, with the
//   turn's LLM key used for that call and referenced nowhere else.
// - The log flushes to Postgres through a Queue (WP7), and the object deletes itself a day after
//   Postgres confirms the whole session; `purge()` deletes it at once, for account deletion.
//
// The entry modules (src/index.ts, src/e2e.ts, the tests' worker) each export a `SessionDO`
// subclass that picks its dependencies: the agent, the flush sink, and the price table.

import { DurableObject } from "cloudflare:workers";
import {
  type ClientMessage,
  type ClientMessageOf,
  type EntityRef,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  type MessageParseFailure,
  parseClientMessage,
  SESSION_PROTOCOL_VERSION,
  type ServerMessage,
  type SessionCloseName,
  type SessionErrorCode,
  type TicketClaims,
  type UsageRecordedV1,
  type UtteranceFinalV2,
  uuidv7,
} from "@earshot/core";
import type { EventEnvelope } from "@earshot/events";
import type { PriceResult, SttUsageInput } from "@earshot/voice/prices";
import type { TurnAgent, TurnResult } from "./agent";
import { type FlushSink, packFlushMessages, type SessionIdentity } from "./flush-message";
import { createLogger, type Logger } from "./log";
import { hasUnstorableString, toStorable } from "./session/jsonb";
import {
  FLUSH_TIMING,
  newBucket,
  type RateBucket,
  recentTurnStarts,
  resendDueMs,
  SESSION_LIMITS,
  takeMessage,
} from "./session/limits";
import { addUsage, readMeter } from "./session/meter";
import { type DoneMessage, type NewEvent, SessionStore } from "./session/store";
import {
  CLAIMS_HEADER,
  closeWith,
  readClaimsHeader,
  refuseSocket,
  sendMessage,
  upgradeResponse,
} from "./socket";

/** What an entry module plugs into the runtime. */
export interface SessionDeps {
  /** Turn extraction: `@earshot/agent`, with a cassette `fetch` in tests. */
  readonly agent: TurnAgent;
  /** Where flush messages go: the `FLUSH` Queue in production. */
  readonly sink: FlushSink;
  /** Prices a client's speech-to-text usage: `priceStt` from `@earshot/voice/prices`. */
  readonly priceStt: (usage: SttUsageInput) => PriceResult;
  /** That table's date, recorded on usage the table can't price. */
  readonly priceTableDate: string;
  /** The clock, for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** The tag on every client socket, for `getWebSockets`. */
const CLIENT_TAG = "client";
/** The most events one `readRange` returns. A session has far fewer. */
const MAX_RANGE_EVENTS = 5_000;

/** What each client socket carries through hibernation (at most 16,384 bytes serialized). */
interface Attachment {
  readonly connId: string;
  readonly uid: string;
  readonly wid: string;
  readonly jti: string;
  /** Whether the client sent `hello`: only then does it get events as they're appended. */
  helloed: boolean;
  /** The client's cumulative ack. */
  ackedSeq: number;
}

function readAttachment(ws: WebSocket): Attachment | undefined {
  const value = ws.deserializeAttachment() as Partial<Attachment> | null;
  return value && typeof value.connId === "string" ? (value as Attachment) : undefined;
}

/** An error's class name: a fixed string, never its message, which could quote input. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function msgIdOf(message: ClientMessage): { msgId?: string } {
  return "msgId" in message ? { msgId: message.msgId } : {};
}

/** The entities `start` stored, or none. */
function readEntities(stored: string | undefined): EntityRef[] {
  if (!stored) return [];
  try {
    const entities: unknown = JSON.parse(stored);
    return Array.isArray(entities) ? (entities as EntityRef[]) : [];
  } catch {
    return [];
  }
}

/** Close codes an endpoint may send (RFC 6455 §7.4): 1004–1006 and 1015 are reserved. */
function isSendableCloseCode(code: number): boolean {
  return (
    code === 1000 ||
    (code >= 1001 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  );
}

/** True if a frame that failed to parse is a `hello` for another protocol version. */
function isOtherProtocolHello(frame: string | ArrayBuffer): boolean {
  if (typeof frame !== "string" || frame.length > 1_024) return false;
  try {
    const value = JSON.parse(frame) as { t?: unknown; protocol?: unknown } | null;
    return (
      value?.t === "hello" &&
      typeof value.protocol === "number" &&
      value.protocol !== SESSION_PROTOCOL_VERSION
    );
  } catch {
    return false;
  }
}

export class SessionRuntime extends DurableObject<Env> {
  readonly #deps: SessionDeps;
  readonly #now: () => number;
  readonly #store: SessionStore;
  readonly #log: Logger;
  /** Turns and `end` run one at a time, in arrival order. */
  #chain: Promise<unknown> = Promise.resolve();
  /** msgIds of `turn_end` and `end` messages running or queued, so a resend starts nothing. */
  readonly #inflight = new Set<string>();
  readonly #controllers = new Set<AbortController>();
  readonly #buckets = new Map<string, RateBucket>();
  #flushing: Promise<void> | null = null;
  /** The pending alarm, as last set or read. */
  #alarmAt: number | null = null;
  /** Set once `purge()` runs in this instance; `meta.purged_ms` says the same across instances. */
  #purged = false;

  constructor(ctx: DurableObjectState, env: Env, deps: SessionDeps) {
    super(ctx, env);
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#log = createLogger();
    this.#store = new SessionStore(ctx.storage);
    // Heartbeats are answered by the runtime: they neither wake the object nor bill.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG));
    // The constructor re-runs after every hibernation and eviction: rehydrate from SQLite.
    void ctx.blockConcurrencyWhile(async () => {
      this.#store.open();
      this.#alarmAt = await ctx.storage.getAlarm();
    });
  }

  // ─── The socket ──────────────────────────────────────────────────────────────────────────────

  /**
   * Accepts a session socket the edge route has already checked: Origin, the ticket's HMAC and
   * expiry, and its `sid`. The claims arrive in an internal header the route set. Here the first
   * connection pins the user and workspace, a `jti` works once, and the newest socket wins.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const claims = readClaimsHeader(request.headers.get(CLAIMS_HEADER));
    if (!claims) return new Response("missing ticket claims", { status: 400 });
    const refusal = this.#admit(claims);
    if (refusal) {
      this.#log.warn("socket refused", { close: refusal });
      return refuseSocket(refusal);
    }

    const { 0: client, 1: server } = new WebSocketPair();
    const connId = uuidv7();
    this.ctx.acceptWebSocket(server, [CLIENT_TAG]);
    const attachment: Attachment = {
      connId,
      uid: claims.uid,
      wid: claims.wid,
      jti: claims.jti,
      helloed: false,
      ackedSeq: -1,
    };
    server.serializeAttachment(attachment);
    let replaced = 0;
    for (const other of this.ctx.getWebSockets(CLIENT_TAG)) {
      if (readAttachment(other)?.connId === connId) continue;
      closeWith(other, "replaced");
      replaced += 1;
    }
    this.#log.info("socket accepted", { replaced });
    return upgradeResponse(client);
  }

  #admit(claims: TicketClaims): SessionCloseName | undefined {
    if (this.#isPurged()) return "session_ended";
    const store = this.#store;
    const sid = store.get("sid");
    const uid = store.get("uid");
    const wid = store.get("wid");
    if (sid !== undefined && sid !== claims.sid) return "forbidden";
    if ((uid !== undefined && uid !== claims.uid) || (wid !== undefined && wid !== claims.wid)) {
      return "forbidden";
    }
    const now = this.#now();
    return store.transaction(() => {
      if (!store.useTicket(claims.jti, now)) return "ticket_reused" as const;
      if (sid === undefined) {
        store.set("sid", claims.sid);
        store.set("uid", claims.uid);
        store.set("wid", claims.wid);
      }
      return undefined;
    });
  }

  override async webSocketMessage(ws: WebSocket, frame: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(ws);
    if (!attachment) {
      closeWith(ws, "internal_error");
      return;
    }
    if (this.#isPurged()) {
      closeWith(ws, "session_ended");
      return;
    }

    const now = this.#now();
    let bucket = this.#buckets.get(attachment.connId);
    if (!bucket) {
      bucket = newBucket(now);
      this.#buckets.set(attachment.connId, bucket);
    }
    const rate = takeMessage(bucket, now);
    if (rate === "close") {
      this.#log.warn("socket closed", { close: "rate_limited" });
      closeWith(ws, "rate_limited");
      return;
    }
    if (rate === "refuse") {
      sendMessage(ws, { t: "error", code: "rate_limited", retryable: true });
      return;
    }

    const parsed = parseClientMessage(frame);
    if (!parsed.ok) {
      this.#refuseFrame(ws, frame, parsed.reason);
      return;
    }
    const message = parsed.message;
    if (hasUnstorableString(message)) {
      this.#log.warn("message refused", { t: message.t, reason: "unstorable_text" });
      sendMessage(ws, { t: "error", code: "bad_message", retryable: false, ...msgIdOf(message) });
      return;
    }
    try {
      await this.#handle(ws, attachment, message);
    } catch (error) {
      this.#log.error("message failed", { t: message.t, cause: errorName(error) });
      sendMessage(ws, { t: "error", code: "internal", retryable: true, ...msgIdOf(message) });
    }
    this.#maybeFlush();
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    const attachment = readAttachment(ws);
    if (attachment) this.#buckets.delete(attachment.connId);
    this.#log.info("socket closed", { code });
    // Complete the close handshake. The runtime is meant to answer Close frames itself from
    // compatibility date 2026-04-07, and calling close() is then harmless; workerd 1.20261110
    // under the test runtime doesn't, and the client waits 10 s for a 1006 instead.
    try {
      ws.close(isSendableCloseCode(code) ? code : 1000, "");
    } catch {
      // Already closed.
    }
  }

  override webSocketError(_ws: WebSocket, error: unknown): void {
    this.#log.warn("socket error", { cause: errorName(error) });
  }

  #refuseFrame(ws: WebSocket, frame: string | ArrayBuffer, reason: MessageParseFailure): void {
    if (reason === "invalid" && isOtherProtocolHello(frame)) {
      this.#log.warn("socket closed", { close: "unsupported_protocol" });
      closeWith(ws, "unsupported_protocol");
      return;
    }
    this.#log.warn("message refused", { reason });
    sendMessage(ws, {
      t: "error",
      code: reason === "too_large" ? "too_large" : "bad_message",
      retryable: false,
    });
  }

  async #handle(ws: WebSocket, attachment: Attachment, message: ClientMessage): Promise<void> {
    switch (message.t) {
      case "hello":
        return this.#hello(ws, attachment, message);
      case "ack":
        return this.#clientAck(ws, attachment, message);
      case "start":
        return this.#start(message);
      case "utterance":
        return this.#utterance(message);
      case "turn_end":
        return this.#turnEnd(message);
      case "usage":
        return this.#usage(message);
      case "metric":
        return this.#metric(message);
      case "end":
        return this.#end(message);
    }
  }

  // ─── Messages ────────────────────────────────────────────────────────────────────────────────

  /** `welcome`, then every event after the client's `lastSeq`, in seq order. */
  #hello(ws: WebSocket, attachment: Attachment, message: ClientMessageOf<"hello">): void {
    const store = this.#store;
    const sessionId = store.get("sid") ?? "";
    attachment.helloed = true;
    ws.serializeAttachment(attachment);
    sendMessage(ws, {
      t: "welcome",
      sessionId,
      lastSeq: store.lastSeq,
      protocol: SESSION_PROTOCOL_VERSION,
    });
    // Synchronous from the read to the last send, so no event appended meanwhile can be missed
    // or sent out of order: those reach this socket by broadcast, after these.
    for (const event of store.events(sessionId, message.lastSeq + 1)) {
      sendMessage(ws, { t: "event", event });
    }
  }

  #clientAck(ws: WebSocket, attachment: Attachment, message: ClientMessageOf<"ack">): void {
    if (message.seq > attachment.ackedSeq && message.seq <= this.#store.lastSeq) {
      attachment.ackedSeq = message.seq;
      ws.serializeAttachment(attachment);
    }
  }

  /** `session.started`, once. A second `start` under a new msgId gets the first one's seq. */
  #start(message: ClientMessageOf<"start">): void {
    const store = this.#store;
    if (this.#answered(message.msgId)) return;
    if (store.get("ended_seq") !== undefined) {
      this.#refuse(message.msgId, "already_ended", false);
      return;
    }
    const startedSeq = store.getNumber("started_seq");
    if (startedSeq !== undefined) {
      this.#ackExisting(message.msgId, startedSeq);
      return;
    }

    this.#commit(
      message.msgId,
      [
        {
          type: "session.started",
          schemaVersion: 1,
          payload: {
            mode: message.mode,
            engine: message.engine,
            providers: message.providers,
            startedAt: message.startedAt,
          },
        },
      ],
      {
        during: ([started], now) => {
          store.set("started_seq", started?.seq ?? 0);
          store.set("capture_started_ms", now);
          store.set("call_time", message.startedAt);
          if (message.timeZone) store.set("time_zone", message.timeZone);
          store.set("entities", JSON.stringify(message.entities));
        },
      },
    );
    this.#log.info("session started", { entities: message.entities.length });
  }

  /** `utterance.final` v2. The same utterance under a new msgId gets the first one's seq. */
  #utterance(message: ClientMessageOf<"utterance">): void {
    const store = this.#store;
    if (this.#answered(message.msgId)) return;
    const refusal = this.#speechRefusal();
    if (refusal) {
      this.#refuse(message.msgId, refusal.code, refusal.retryable);
      return;
    }
    const { utteranceId } = message.utterance;
    const existing = store.utteranceSeq(utteranceId);
    if (existing !== undefined) {
      this.#ackExisting(message.msgId, existing);
      return;
    }
    this.#commit(
      message.msgId,
      [{ type: "utterance.final", schemaVersion: 2, payload: message.utterance }],
      {
        during: ([event]) => {
          if (event) store.addUtterance(utteranceId, message.turnId, event.seq);
        },
      },
    );
  }

  /**
   * Runs the turn's extraction, after any turn before it. A resend while it runs starts nothing;
   * its ack comes when the turn's events are written.
   */
  async #turnEnd(message: ClientMessageOf<"turn_end">): Promise<void> {
    const store = this.#store;
    if (this.#answered(message.msgId) || this.#inflight.has(message.msgId)) return;
    const refusal = this.#speechRefusal();
    if (refusal) {
      this.#refuse(message.msgId, refusal.code, refusal.retryable);
      return;
    }
    const now = this.#now();
    const starts = recentTurnStarts(store.get("turn_starts"), now);
    if (starts.length >= SESSION_LIMITS.turnsPerWindow) {
      this.#log.warn("turn refused", { reason: "turn_limit" });
      this.#commit(message.msgId, [], { error: { code: "turn_limit", retryable: false } });
      return;
    }
    store.transaction(() => store.set("turn_starts", JSON.stringify([...starts, now])));
    this.#inflight.add(message.msgId);
    try {
      await this.#serially(() => this.#runTurn(message));
    } finally {
      this.#inflight.delete(message.msgId);
    }
  }

  async #runTurn(message: ClientMessageOf<"turn_end">): Promise<void> {
    const store = this.#store;
    if (this.#isPurged() || store.done(message.msgId)) return;
    if (store.get("ended_seq") !== undefined) {
      this.#refuse(message.msgId, "already_ended", false);
      return;
    }
    const { agent } = this.#deps;
    let gateway: ReturnType<TurnAgent["aiGatewayFromEnv"]>;
    try {
      gateway = agent.aiGatewayFromEnv(this.env);
    } catch {
      // AI_GATEWAY_ACCOUNT_ID or AI_GATEWAY_ID can't be part of a URL: fail closed, not direct.
      this.#log.error("turn refused", { reason: "ai_gateway_misconfigured" });
      this.#refuse(message.msgId, "llm_unavailable", false);
      return;
    }
    let extractor: ReturnType<TurnAgent["createProposalExtractor"]>;
    try {
      extractor = agent.createProposalExtractor({
        provider: message.llm.provider,
        model: message.llm.model,
        gateway,
      });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      // A model the agent has no adapter or price for.
      this.#log.warn("turn refused", { reason: "unsupported_model" });
      this.#refuse(message.msgId, "bad_message", false);
      return;
    }

    const controller = new AbortController();
    this.#controllers.add(controller);
    let result: TurnResult;
    try {
      result = await agent.runTurn({
        extractor,
        turnId: message.turnId,
        // Validated as `utterance.final` v2 when they arrived.
        utterances: store.turnUtterances(message.turnId) as unknown as UtteranceFinalV2[],
        entities: readEntities(store.get("entities")),
        callTime:
          store.get("call_time") ??
          new Date(store.getNumber("capture_started_ms", this.#now())).toISOString(),
        timeZone: store.get("time_zone") ?? "UTC",
        // The turn's key: used for this call and referenced nowhere else.
        apiKey: message.key,
        signal: controller.signal,
        onWorking: (state) => this.#broadcast({ t: "working", turnId: message.turnId, ...state }),
      });
    } catch (error) {
      // runTurn turns every provider and validation failure into an outcome, so this is a bug.
      // Record the answer, so a resend can't run the call again and again.
      this.#log.error("turn failed", { cause: errorName(error) });
      this.#commit(message.msgId, [], { error: { code: "internal", retryable: false } });
      return;
    } finally {
      this.#controllers.delete(controller);
    }
    if (this.#isPurged()) {
      this.#log.info("turn discarded", { reason: "purged" });
      return;
    }

    const usage = result.usage;
    const events: NewEvent[] = [
      ...result.proposals.map((proposal) => ({
        type: "proposal.created",
        schemaVersion: 1,
        // Model output: cleaned of anything Postgres's jsonb would refuse.
        payload: toStorable(proposal) as unknown as Record<string, unknown>,
      })),
      ...(usage
        ? [
            {
              type: "usage.recorded",
              schemaVersion: 1,
              payload: { ...usage } as Record<string, unknown>,
            },
          ]
        : []),
      {
        type: "turn.completed",
        schemaVersion: 1,
        payload: { ...result.completed } as Record<string, unknown>,
      },
    ];
    try {
      this.#commit(message.msgId, events, {
        during: () => {
          if (usage) this.#addToMeter(usage);
        },
        error: result.error,
      });
    } catch (error) {
      // An event the registry refused: a bug in the extractor's output. Don't run it again.
      this.#log.error("turn not recorded", { cause: errorName(error) });
      this.#commit(message.msgId, [], { error: { code: "internal", retryable: false } });
      return;
    }
    this.#log.info("turn completed", {
      outcome: result.outcome,
      proposals: result.proposals.length,
      attempts: result.completed.attempts,
      llmMs: result.completed.llmMs,
      failure: result.failure,
    });
  }

  /** The client's speech-to-text usage, priced, as `usage.recorded`. */
  #usage(message: ClientMessageOf<"usage">): void {
    if (this.#answered(message.msgId)) return;
    if (this.#store.getNumber("started_seq") === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    const price = this.#deps.priceStt({
      provider: message.provider,
      model: message.model,
      audioMs: message.audioMs,
      socketMs: message.socketMs,
    });
    // An unknown model is recorded at $0, so its audio and socket time can be priced later.
    if (!price.ok) this.#log.warn("usage unpriced", { kind: "stt", reason: price.reason });
    const usage: UsageRecordedV1 = {
      usageId: uuidv7(),
      kind: "stt",
      provider: message.provider,
      model: message.model,
      audioMs: message.audioMs,
      socketMs: message.socketMs,
      costUsd: price.ok ? price.costUsd : 0,
      priceTable: price.ok ? price.priceTable : this.#deps.priceTableDate,
    };
    this.#commit(message.msgId, [{ type: "usage.recorded", schemaVersion: 1, payload: usage }], {
      during: () => this.#addToMeter(usage),
    });
  }

  /** `turn.measured`, from the client's marks: four stages on one clock, floored at 0. */
  #metric(message: ClientMessageOf<"metric">): void {
    if (this.#answered(message.msgId)) return;
    if (this.#store.getNumber("started_seq") === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    const marks = message.marks;
    const stage = (from: number, to: number) => Math.max(0, Math.round(to - from));
    this.#commit(message.msgId, [
      {
        type: "turn.measured",
        schemaVersion: 1,
        payload: {
          turnId: message.turnId,
          mode: marks.mode,
          speechEndToFinalMs: stage(marks.speechEndMs, marks.finalMs),
          finalToProposalMs: stage(marks.finalMs, marks.proposalMs),
          proposalToPaintMs: stage(marks.proposalMs, marks.paintMs),
          totalMs: stage(marks.speechEndMs, marks.paintMs),
        },
      },
    ]);
  }

  /** `session.ended`, after any turn still running, then an immediate flush. */
  async #end(message: ClientMessageOf<"end">): Promise<void> {
    if (this.#answered(message.msgId) || this.#inflight.has(message.msgId)) return;
    if (this.#store.getNumber("started_seq") === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    this.#inflight.add(message.msgId);
    try {
      await this.#serially(async () => this.#finish(message.msgId, message.endedAt));
    } finally {
      this.#inflight.delete(message.msgId);
    }
  }

  /** Ends the session: for the client's `end` (msgId), or for an abandoned session (null). */
  #finish(msgId: string | null, endedAt: string): void {
    if (this.#isPurged()) return;
    const store = this.#store;
    if (msgId !== null && store.done(msgId)) return;
    const endedSeq = store.getNumber("ended_seq");
    if (endedSeq !== undefined) {
      if (msgId !== null) this.#ackExisting(msgId, endedSeq);
      return;
    }
    const meter = readMeter(store.get("meter"));
    this.#commit(
      msgId,
      [{ type: "session.ended", schemaVersion: 1, payload: { endedAt, costUsd: meter.costUsd } }],
      {
        during: ([ended], now) => {
          store.set("ended_seq", ended?.seq ?? store.lastSeq);
          store.set("ended_ms", now);
          store.set("resend_count", 0);
          store.set("resend_due_ms", resendDueMs(now, 0));
        },
      },
    );
    this.#log.info("session ended", { events: store.lastSeq + 1, by: msgId ? "client" : "idle" });
    this.ctx.waitUntil(this.#flush());
  }

  // ─── Answers ─────────────────────────────────────────────────────────────────────────────────

  /** If the message was handled before, sends the same answer again and returns true. */
  #answered(msgId: string): boolean {
    const done = this.#store.done(msgId);
    if (!done) return false;
    this.#sendAnswer(msgId, done);
    return true;
  }

  #sendAnswer(msgId: string, done: DoneMessage): void {
    this.#toClients(done.seq === null ? { t: "ack", msgId } : { t: "ack", msgId, seq: done.seq });
    if (done.error) {
      this.#toClients({
        t: "error",
        code: done.error.code as SessionErrorCode,
        retryable: done.error.retryable,
        msgId,
      });
    }
  }

  /** Records a message whose event is already in the log, and acks it with that event's seq. */
  #ackExisting(msgId: string, seq: number): void {
    const answer: DoneMessage = { seq, error: null };
    this.#store.transaction(() => this.#store.markDone(msgId, answer, this.#now()));
    this.#sendAnswer(msgId, answer);
  }

  /**
   * Refuses a message without recording it. Each such refusal is one a resend would get again
   * (or, for `not_started`, one a resend after `start` fixes), so nothing needs remembering.
   */
  #refuse(msgId: string, code: SessionErrorCode, retryable: boolean): void {
    this.#toClients({ t: "error", code, retryable, msgId });
  }

  /** Why `utterance` and `turn_end` can't be taken now, if they can't. */
  #speechRefusal(): { code: SessionErrorCode; retryable: boolean } | undefined {
    const store = this.#store;
    const startedMs = store.getNumber("capture_started_ms");
    if (store.getNumber("started_seq") === undefined || startedMs === undefined) {
      return { code: "not_started", retryable: true };
    }
    if (store.get("ended_seq") !== undefined) return { code: "already_ended", retryable: false };
    if (this.#now() - startedMs >= SESSION_LIMITS.captureMs) {
      return { code: "duration_limit", retryable: false };
    }
    return undefined;
  }

  /**
   * Appends events and records the message that caused them, in one transaction, then sends the
   * events, the ack, and any error. Returns the appended envelopes.
   */
  #commit(
    msgId: string | null,
    events: readonly NewEvent[],
    options: {
      readonly during?: (appended: readonly EventEnvelope[], now: number) => void;
      readonly error?: DoneMessage["error"];
    } = {},
  ): readonly EventEnvelope[] {
    const store = this.#store;
    const sessionId = store.get("sid");
    if (!sessionId) throw new Error("the session has no id");
    const now = this.#now();
    const pendingBefore = store.lastSeq > store.getNumber("enqueued_seq", -1);
    const error = options.error ?? null;
    const appended = store.transaction(() => {
      const appended = store.append(sessionId, events, { now, newId: uuidv7 });
      options.during?.(appended, now);
      if (!pendingBefore && appended.length > 0) store.set("unflushed_since_ms", now);
      if (msgId !== null) store.markDone(msgId, { seq: appended.at(-1)?.seq ?? null, error }, now);
      return appended;
    });
    for (const event of appended) this.#broadcast({ t: "event", event });
    if (msgId !== null) this.#sendAnswer(msgId, { seq: appended.at(-1)?.seq ?? null, error });
    if (appended.length > 0) this.ctx.waitUntil(this.#schedule());
    return appended;
  }

  #addToMeter(usage: UsageRecordedV1): void {
    this.#store.set("meter", JSON.stringify(addUsage(readMeter(this.#store.get("meter")), usage)));
  }

  /** Events and `working`: to every socket that has said `hello`. */
  #broadcast(message: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets(CLIENT_TAG)) {
      if (readAttachment(ws)?.helloed) sendMessage(ws, message);
    }
  }

  /** Acks and errors: to every client socket. There's normally one. */
  #toClients(message: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets(CLIENT_TAG)) sendMessage(ws, message);
  }

  #serially<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(task, task);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  // ─── The flush ───────────────────────────────────────────────────────────────────────────────

  #identity(): SessionIdentity | undefined {
    const store = this.#store;
    const sessionId = store.get("sid");
    const userId = store.get("uid");
    const workspaceId = store.get("wid");
    return sessionId && userId && workspaceId ? { sessionId, userId, workspaceId } : undefined;
  }

  /** After each message: flush once 20 events wait, or the oldest has waited 30 s. */
  #maybeFlush(): void {
    const store = this.#store;
    const pending = store.lastSeq - store.getNumber("enqueued_seq", -1);
    if (pending <= 0) return;
    const since = store.getNumber("unflushed_since_ms", this.#now());
    if (
      pending >= FLUSH_TIMING.maxPendingEvents ||
      this.#now() - since >= FLUSH_TIMING.maxPendingMs
    ) {
      this.ctx.waitUntil(this.#flush());
    }
  }

  /**
   * Hands every event not yet enqueued to the Queue, packed into messages of at most 64 KB, and
   * records `enqueued_seq` once the send resolves. One flush at a time; a failed send leaves the
   * range for the next window.
   */
  #flush(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    const store = this.#store;
    const from = store.getNumber("enqueued_seq", -1) + 1;
    const to = store.lastSeq;
    const identity = this.#identity();
    if (from > to || !identity || this.#isPurged()) return Promise.resolve();
    const messages = packFlushMessages(identity, store.flushEvents(from, to));
    const flushing = (async () => {
      try {
        await this.#deps.sink.send(messages);
        if (this.#isPurged()) return;
        store.transaction(() => {
          store.set("enqueued_seq", to);
          if (store.lastSeq > to) store.set("unflushed_since_ms", this.#now());
          else store.delete("unflushed_since_ms");
        });
        this.#log.info("flush sent", { messages: messages.length, events: to - from + 1 });
      } catch (error) {
        this.#log.warn("flush send failed", { cause: errorName(error) });
        if (!this.#isPurged()) {
          store.transaction(() => store.set("unflushed_since_ms", this.#now()));
        }
      } finally {
        this.#flushing = null;
      }
      await this.#schedule();
    })();
    this.#flushing = flushing;
    return flushing;
  }

  /** After the end: sends again every event Postgres hasn't confirmed. */
  async #resend(now: number): Promise<void> {
    const store = this.#store;
    const identity = this.#identity();
    if (!identity) return;
    const from = store.getNumber("flushed_seq", -1) + 1;
    const count = store.getNumber("resend_count", 0);
    const messages = packFlushMessages(identity, store.flushEvents(from));
    try {
      await this.#deps.sink.send(messages);
      this.#log.info("flush resent", { messages: messages.length, attempt: count + 1 });
      store.transaction(() => {
        store.set("resend_count", count + 1);
        store.set("resend_due_ms", resendDueMs(store.getNumber("ended_ms", now), count + 1));
      });
    } catch (error) {
      this.#log.warn("flush resend failed", { cause: errorName(error) });
      store.transaction(() => store.set("resend_due_ms", now + FLUSH_TIMING.resendRetryMs));
    }
  }

  // ─── Alarms ──────────────────────────────────────────────────────────────────────────────────

  /** When the object next has something to do, or null. */
  #nextDue(): number | null {
    const store = this.#store;
    const now = this.#now();
    if (this.#isPurged()) {
      return store.getNumber("purged_ms", now) + FLUSH_TIMING.tombstoneMs;
    }
    const dues: number[] = [];
    const lastSeq = store.lastSeq;
    const enqueued = store.getNumber("enqueued_seq", -1);
    if (lastSeq > enqueued) {
      dues.push(store.getNumber("unflushed_since_ms", now) + FLUSH_TIMING.maxPendingMs);
    }
    if (store.get("ended_seq") !== undefined) {
      const cleanup = store.getNumber("cleanup_due_ms");
      const resend = store.getNumber("resend_due_ms");
      if (cleanup !== undefined) dues.push(cleanup);
      else if (
        store.getNumber("flushed_seq", -1) < lastSeq &&
        enqueued >= lastSeq &&
        resend !== undefined
      ) {
        dues.push(resend);
      }
    } else if (store.get("started_seq") !== undefined) {
      dues.push(this.#idleEndDue());
    }
    return dues.length > 0 ? Math.min(...dues) : null;
  }

  /** When an abandoned session is ended: after both the capture limit and its last event. */
  #idleEndDue(): number {
    const store = this.#store;
    const started = store.getNumber("capture_started_ms", this.#now());
    const lastEvent = store.lastEventMs ?? started;
    return Math.max(started + SESSION_LIMITS.captureMs, lastEvent) + FLUSH_TIMING.idleEndMs;
  }

  /**
   * Moves the alarm earlier when something is due sooner. It never moves it later: an early alarm
   * finds nothing due and sets the next one, which costs one row write, as moving it would.
   */
  async #schedule(): Promise<void> {
    const due = this.#nextDue();
    if (due === null) return;
    if (this.#alarmAt !== null && this.#alarmAt <= due) return;
    this.#alarmAt = due;
    try {
      await this.ctx.storage.setAlarm(due);
    } catch (error) {
      // The next message or RPC tries again.
      this.#alarmAt = null;
      this.#log.warn("alarm not set", { cause: errorName(error) });
    }
  }

  /**
   * The flush window's end, re-sends after the end, the cleanup a day after Postgres confirms the
   * whole log, ending an abandoned session, and deleting a purge's tombstone. Idempotent: it acts
   * only on what is due, so a retried or early alarm does no harm.
   */
  override async alarm(): Promise<void> {
    this.#alarmAt = null;
    const store = this.#store;
    const now = this.#now();
    if (this.#isPurged()) {
      if (now >= store.getNumber("purged_ms", now) + FLUSH_TIMING.tombstoneMs) {
        await this.#wipe();
        return;
      }
      await this.#schedule();
      return;
    }
    if (store.get("sid") === undefined) return;

    if (store.lastSeq > store.getNumber("enqueued_seq", -1)) await this.#flush();
    if (store.get("ended_seq") !== undefined) {
      const lastSeq = store.lastSeq;
      const cleanupDue = store.getNumber("cleanup_due_ms");
      if (store.getNumber("flushed_seq", -1) >= lastSeq) {
        if (cleanupDue === undefined) {
          store.transaction(() =>
            store.set("cleanup_due_ms", now + FLUSH_TIMING.cleanupAfterConfirmMs),
          );
        } else if (now >= cleanupDue) {
          await this.#wipe();
          this.#log.info("session storage deleted", { reason: "flushed" });
          return;
        }
      } else {
        // Events arrived after Postgres confirmed the end: they must be confirmed first.
        if (cleanupDue !== undefined) store.transaction(() => store.delete("cleanup_due_ms"));
        const resendDue = store.getNumber("resend_due_ms");
        if (
          store.getNumber("enqueued_seq", -1) >= lastSeq &&
          resendDue !== undefined &&
          now >= resendDue
        ) {
          await this.#resend(now);
        }
      }
    } else if (store.get("started_seq") !== undefined && now >= this.#idleEndDue()) {
      await this.#serially(async () => this.#finish(null, new Date(now).toISOString()));
    }
    await this.#schedule();
  }

  /** Deletes the object's storage, tables and alarm included. */
  async #wipe(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) closeWith(ws, "session_ended");
    await this.ctx.storage.deleteAll();
    this.#store.forget();
    this.#alarmAt = null;
  }

  // ─── RPC for the Queue consumer and for deletion ─────────────────────────────────────────────

  /**
   * Events `fromSeq..toSeq` as the flush sends them, for the consumer's gap repair, as one JSON
   * array (`parseRange` reads it). Empty once the session is purged or cleaned up.
   */
  readRange(fromSeq: number, toSeq: number): string {
    if (this.#isPurged() || this.#store.get("sid") === undefined) return "[]";
    if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq < 0 || toSeq < fromSeq) {
      return "[]";
    }
    return JSON.stringify(
      this.#store.flushEvents(fromSeq, Math.min(toSeq, this.#store.lastSeq), MAX_RANGE_EVENTS),
    );
  }

  /**
   * Postgres holds every event up to `seq`. Once that covers the whole log after the end, the
   * cleanup alarm is set for a day later.
   */
  async confirmFlushed(seq: number): Promise<void> {
    const store = this.#store;
    if (this.#isPurged() || store.get("sid") === undefined || !Number.isInteger(seq)) return;
    const confirmed = Math.min(seq, store.lastSeq);
    if (confirmed <= store.getNumber("flushed_seq", -1)) return;
    const now = this.#now();
    store.transaction(() => {
      store.set("flushed_seq", confirmed);
      if (
        store.get("ended_seq") !== undefined &&
        confirmed >= store.lastSeq &&
        store.get("cleanup_due_ms") === undefined
      ) {
        store.set("cleanup_due_ms", now + FLUSH_TIMING.cleanupAfterConfirmMs);
      }
    });
    await this.#schedule();
  }

  /**
   * Deletes everything the object holds, for account and session deletion (spec decision 16):
   * closes the socket, cancels a running turn, and deletes the storage. A tombstone then refuses
   * connections for a few minutes, longer than any ticket issued before the deletion lives, and
   * is deleted by an alarm.
   */
  async purge(): Promise<void> {
    this.#purged = true;
    for (const controller of this.#controllers) {
      controller.abort(new DOMException("the session was deleted", "AbortError"));
    }
    for (const ws of this.ctx.getWebSockets()) closeWith(ws, "session_ended");
    await this.ctx.storage.deleteAll();
    this.#store.forget();
    const now = this.#now();
    this.#store.transaction(() => this.#store.set("purged_ms", now));
    this.#alarmAt = now + FLUSH_TIMING.tombstoneMs;
    await this.ctx.storage.setAlarm(this.#alarmAt);
    this.#log.info("session purged");
  }

  /** The health check's probe (docs/adr/0003): counts calls in its own table. */
  ping(): { ok: true; pings: number } {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS health (k TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    sql.exec(
      "INSERT INTO health (k, n) VALUES ('pings', 1) ON CONFLICT (k) DO UPDATE SET n = n + 1",
    );
    const { n } = sql.exec<{ n: number }>("SELECT n FROM health WHERE k = 'pings'").one();
    return { ok: true, pings: n };
  }

  // ─── State ───────────────────────────────────────────────────────────────────────────────────

  #isPurged(): boolean {
    return this.#purged || this.#store.get("purged_ms") !== undefined;
  }
}
