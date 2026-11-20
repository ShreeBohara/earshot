// An in-memory SessionDO for SessionClient tests and keyless local work: pass `server.factory` as
// the client's `socket` and `() => server.issueTicket()` as its `getTicket`. It follows WP6's
// SessionDO where the client can tell:
//
// - a ticket opens one socket (a reused one closes 4004, an unknown one 4003), and the newest
//   socket replaces older ones (4005);
// - `hello` gets `welcome`, then every event after `lastSeq` in seq order; events go out live
//   only to sockets that said `hello`;
// - each message's events and its answer are recorded together, so a resend gets the same ack and
//   appends nothing, and a `turn_end` resent while its turn runs starts nothing;
// - acks and errors go to every socket; `working` precedes a turn's events;
// - a turn's `witness` (Phase 4 WP9) is refused for a turn with no `turn_end` and for a second
//   witness, waits for a held turn, and appends the unbiased utterance, any flags `compare` gives,
//   and `turn.witnessed`;
// - `review` and `snooze` (Phase 5 WP3) are checked with the writers' rules against the log's
//   proposals, idempotent by msgId and by review and snooze id, and filled in with `reviewer`;
// - `seal()` appends `session.sealed`, after which every message but `hello` and `ack` is refused
//   with `sealed` (a resend of one answered before gets its first answer);
// - `ping` gets `pong` (the runtime's auto-response).
//
// Faults are switches on the instance: drop a socket after a given event, skip one event once
// (a gap), refuse the next messages for rate, refuse the next connections with a code, hold
// turns until `completeTurns()`, stop answering pings, or purge the session (4006).
import {
  type ClientMessage,
  type ClientMessageOf,
  createUuidv7,
  type EventEnvelope,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  type ProposalCreatedV2,
  type ProposalFlaggedV1,
  type ProposalReviewedV2,
  parseClientMessage,
  type Reviewer,
  SESSION_CLOSE_CODES,
  SESSION_PROTOCOL_VERSION,
  SESSION_SUBPROTOCOL,
  type ServerMessage,
  type SessionErrorCode,
  TICKET_SUBPROTOCOL_PREFIX,
  UNDO_WINDOW_MS,
  type UtteranceFinalV2,
} from "@earshot/core";
import {
  anyFlagTier,
  checkReviews,
  checkSnooze,
  defaultRegistry,
  proposalsProjection,
  replay,
} from "@earshot/events";
import { PRICE_TABLE_DATE, priceStt } from "../prices";
import type { SocketFactory } from "../stt/socket";
import { type FakeServerSocket, FakeSocketServer } from "./fake-socket";

/**
 * The schema version SessionDO writes for each event type where that isn't the latest. None
 * since Phase 4 WP8: extractor v2 writes `proposal.created` v2, as this fake does.
 */
const WRITTEN_VERSIONS: Readonly<Record<string, number>> = {};

/** A target the linker couldn't settle on anything: no record named. For drafts in tests. */
export const NO_TARGET: ProposalCreatedV2["target"] = {
  decision: "none",
  entityId: null,
  kind: null,
  basis: null,
  p: null,
  mention: null,
  company: null,
  candidates: [],
};

/** One turn as the fake's extractor sees it. */
export interface FakeTurn {
  readonly turnId: string;
  readonly utterances: readonly UtteranceFinalV2[];
  readonly llm: { readonly provider: string; readonly model: string };
}

/**
 * A proposal the fake's extractor drafts, as `proposal.created` v2 without its id, which the
 * server gives it. `supersedes` and `linker` may be left out: null and "linker.v1".
 */
export type FakeProposal = Omit<ProposalCreatedV2, "proposalId" | "supersedes" | "linker"> &
  Partial<Pick<ProposalCreatedV2, "supersedes" | "linker">>;

export interface FakeSessionServerOptions {
  readonly sessionId: string;
  /** The socket URL tickets name. */
  readonly edgeUrl?: string;
  /** The server's clock for envelope `ts`, in epoch ms. Defaults to a fixed start plus 1 s a call. */
  readonly now?: () => number;
  /**
   * A monotonic clock in ms. With it, each socket gets SessionDO's token bucket (20 messages a
   * second, burst 20), refusing what's over with `rate_limited`; `rateRefusals` counts them.
   */
  readonly rateClock?: () => number;
  /** Envelope and proposal ids. Defaults to a deterministic UUIDv7 generator. */
  readonly newId?: () => string;
  /** Drafts proposals for a turn: the cassette extractor's stand-in. Defaults to none. */
  readonly propose?: (turn: FakeTurn) => readonly FakeProposal[];
  /**
   * Compares a turn's proposals with its unbiased transcript: the stand-in for SessionDO's
   * witness comparison. Returns `proposal.flagged` payloads; defaults to none.
   */
  readonly compare?: (input: {
    readonly turnId: string;
    readonly proposals: readonly ProposalCreatedV2[];
    readonly unbiased: UtteranceFinalV2;
  }) => readonly ProposalFlaggedV1[];
  /** Who the socket's reviews and snoozes are by. Defaults to a user with no recorded sign-in. */
  readonly reviewer?: Reviewer;
}

export interface FakeSessionTicket {
  readonly sessionId: string;
  readonly ticket: string;
  readonly ticketExpiresAt: string;
  readonly edgeUrl: string;
}

interface Answer {
  readonly seq: number | null;
  readonly error: { readonly code: SessionErrorCode; readonly retryable: boolean } | null;
}

/** One accepted socket, as the server sees it. */
export class FakeSessionConnection {
  readonly socket: FakeServerSocket;
  readonly ticket: string;
  helloed = false;
  ackedSeq = -1;
  /** SessionDO's token bucket, when the server has a `rateClock`. */
  bucket: { tokens: number; at: number } | undefined;
  /** The client messages this socket carried, parsed, in order. */
  readonly messages: ClientMessage[] = [];
  /** Text frames sent to the client, parsed, in order (pongs excluded). */
  readonly sent: ServerMessage[] = [];

  constructor(socket: FakeServerSocket, ticket: string) {
    this.socket = socket;
    this.ticket = ticket;
  }

  get isOpen(): boolean {
    return this.socket.isOpen;
  }

  send(message: ServerMessage): void {
    if (!this.socket.isOpen) return;
    this.sent.push(message);
    this.socket.sendJson(message);
  }
}

const START_MS = Date.UTC(2026, 10, 10, 19, 15, 0);

export class FakeSessionServer {
  readonly sessionId: string;
  readonly edgeUrl: string;
  /** The session's log, as SessionDO's SQLite holds it. */
  readonly log: EventEnvelope[] = [];
  readonly connections: FakeSessionConnection[] = [];
  /** Every client message, parsed, in arrival order across sockets. */
  readonly received: ClientMessage[] = [];
  /** How many times each msgId's work was committed: always 1 if dedupe works. */
  readonly commits = new Map<string, number>();
  /** Keys that arrived on `turn_end`, in order: the one place a key may go. */
  readonly turnKeys: string[] = [];
  /** Messages the token bucket refused (only with a `rateClock`). */
  rateRefusals = 0;

  // Fault switches.
  respondToPings = true;
  /** Answer `hello` (with `welcome` and the replay); off, the socket stays mute. */
  answerHellos = true;
  /** Answer turns only on `completeTurns()`. */
  holdTurns = false;
  /** Refuse this many upcoming messages with `rate_limited`, unparsed and without a msgId. */
  refuseNext = 0;
  /** Close codes for the next connections, one each, after the handshake. */
  readonly refuseConnections: number[] = [];
  /** Seqs to leave out once, wherever they'd next be sent: a gap. */
  readonly skipOnce = new Set<number>();
  /** Seqs never sent at all: a gap no resume can fill. */
  readonly withhold = new Set<number>();
  /** After sending this seq to a socket, close it with this code, once. */
  readonly dropAfter = new Map<number, number>();

  readonly #sockets = new FakeSocketServer();
  readonly #rateClock: (() => number) | undefined;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #propose: ((turn: FakeTurn) => readonly FakeProposal[]) | undefined;
  readonly #compare: FakeSessionServerOptions["compare"];
  /** Turns whose `turn_end` arrived, with their proposals once the turn has run. */
  readonly #turnRuns = new Map<string, { proposals: ProposalCreatedV2[] | null }>();
  /** Turns that have a witness. */
  readonly #witnessed = new Set<string>();
  readonly #answers = new Map<string, Answer>();
  readonly #inflight = new Set<string>();
  readonly #held: (() => void)[] = [];
  readonly #issued = new Set<string>();
  readonly #used = new Set<string>();
  /** utteranceId → seq, and turnId → its utterances' seqs. */
  readonly #utterances = new Map<string, number>();
  readonly #turns = new Map<string, number[]>();
  /** Reviews and snoozes by their client-made ids. */
  readonly #writes = new Map<
    string,
    { kind: "review" | "snooze"; seq: number; proposalId: string }
  >();
  readonly #reviewer: Reviewer;
  #ticketCount = 0;
  #purged = false;
  #costUsd = 0;
  #startedSeq: number | undefined;
  #endedSeq: number | undefined;
  #sealedSeq: number | undefined;

  constructor(options: FakeSessionServerOptions) {
    this.sessionId = options.sessionId;
    this.edgeUrl = options.edgeUrl ?? `wss://edge.test/v1/sessions/${options.sessionId}/ws`;
    let tick = 0;
    this.#now = options.now ?? (() => START_MS + 1_000 * tick++);
    let ids = 0;
    this.#newId =
      options.newId ??
      createUuidv7({
        now: () => START_MS + ids++,
        random: (bytes) => bytes.fill(7),
      });
    this.#propose = options.propose;
    this.#compare = options.compare;
    this.#reviewer = options.reviewer ?? { userId: "fake-user", auth: null };
    this.#rateClock = options.rateClock;
    this.#sockets.onConnection = (socket) => this.#onConnection(socket);
  }

  /** Pass as SessionClient's `socket`. */
  get factory(): SocketFactory {
    return this.#sockets.factory;
  }

  /** The newest accepted socket. */
  get current(): FakeSessionConnection | undefined {
    return this.connections.at(-1);
  }

  /** Every socket the client opened, refused ones included. */
  get sockets(): readonly FakeServerSocket[] {
    return this.#sockets.sockets;
  }

  get ticketsIssued(): number {
    return this.#ticketCount;
  }

  /** A fresh single-use ticket, as `POST /api/sessions/:id/ticket` answers. */
  issueTicket(): FakeSessionTicket {
    this.#ticketCount += 1;
    const ticket = `fake-ticket-${this.#ticketCount}`;
    this.#issued.add(ticket);
    return {
      sessionId: this.sessionId,
      ticket,
      ticketExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      edgeUrl: this.edgeUrl,
    };
  }

  /** Loads a recorded log (such as the demo fixture) as if SessionDO had written it. */
  seed(events: readonly EventEnvelope[]): void {
    for (const event of events) {
      if (event.sessionId !== this.sessionId || event.seq !== this.log.length) {
        throw new Error("seed events must be this session's, in seq order from the log's end");
      }
      defaultRegistry.validate(event);
      this.log.push(structuredClone(event));
    }
  }

  /** Appends an event outside any client message, and sends it to every socket that said hello. */
  append(type: string, payload: Record<string, unknown>): EventEnvelope {
    const event = this.#append(type, payload);
    this.#broadcast(event);
    return event;
  }

  /** Closes every open socket from the server's side, as a deploy or a network drop does. */
  dropAll(code = 1006, reason = ""): void {
    for (const connection of this.connections) connection.socket.close(code, reason);
  }

  /** Runs the turns `holdTurns` kept waiting. */
  completeTurns(): void {
    for (const run of this.#held.splice(0)) run();
  }

  /**
   * Seals the session, as SessionDO's alarm does after the grace: `session.sealed`, after which
   * every message but `hello` and `ack` is refused with `sealed`. Ends it first if it hasn't ended.
   */
  seal(): EventEnvelope {
    if (this.#sealedSeq !== undefined) throw new Error("the session is already sealed");
    if (this.#endedSeq === undefined) {
      this.#endedSeq = this.append("session.ended", {
        endedAt: new Date(this.#now()).toISOString(),
        costUsd: this.#costUsd,
      }).seq;
    }
    const sealed = this.append("session.sealed", {
      sealedAt: new Date(this.#now()).toISOString(),
      by: "session",
    });
    this.#sealedSeq = sealed.seq;
    return sealed;
  }

  /** Deletes the session, as account deletion does: every socket closes with 4006. */
  purge(): void {
    this.#purged = true;
    const { code, reason } = SESSION_CLOSE_CODES.session_ended;
    this.dropAll(code, reason);
  }

  // ─── Sockets ────────────────────────────────────────────────────────────────────────────────

  #onConnection(socket: FakeServerSocket): void {
    // The edge route: earshot.v1 plus exactly one ticket, or no upgrade at all.
    const tickets = socket.protocols.filter((p) => p.startsWith(TICKET_SUBPROTOCOL_PREFIX));
    const ticket = tickets.length === 1 ? tickets[0]?.slice(TICKET_SUBPROTOCOL_PREFIX.length) : "";
    if (!socket.protocols.includes(SESSION_SUBPROTOCOL) || !ticket) {
      socket.refuse(1006);
      return;
    }
    const refuse = (code: number) => {
      socket.accept(SESSION_SUBPROTOCOL);
      socket.close(code, "");
    };
    if (this.#purged) {
      refuse(SESSION_CLOSE_CODES.session_ended.code);
      return;
    }
    if (!this.#issued.has(ticket)) {
      refuse(SESSION_CLOSE_CODES.ticket_refused.code);
      return;
    }
    if (this.#used.has(ticket)) {
      refuse(SESSION_CLOSE_CODES.ticket_reused.code);
      return;
    }
    this.#used.add(ticket);
    const forced = this.refuseConnections.shift();
    if (forced !== undefined) {
      refuse(forced);
      return;
    }

    socket.accept(SESSION_SUBPROTOCOL);
    const connection = new FakeSessionConnection(socket, ticket);
    for (const other of this.connections) {
      const { code, reason } = SESSION_CLOSE_CODES.replaced;
      if (other.isOpen) other.socket.close(code, reason);
    }
    this.connections.push(connection);
    socket.onMessage = (data) => this.#onFrame(connection, data);
  }

  #onFrame(connection: FakeSessionConnection, data: string | Uint8Array): void {
    // Frames the client sent before closing still arrive, as they would over a real socket; the
    // answers to them are lost, as they would be.
    if (data === HEARTBEAT_PING) {
      if (this.respondToPings) connection.socket.sendText(HEARTBEAT_PONG);
      return;
    }
    if (this.refuseNext > 0 || !this.#takeToken(connection)) {
      if (this.refuseNext > 0) this.refuseNext -= 1;
      else this.rateRefusals += 1;
      connection.send({ t: "error", code: "rate_limited", retryable: true });
      return;
    }
    const parsed = parseClientMessage(data);
    if (!parsed.ok) {
      connection.send({
        t: "error",
        code: parsed.reason === "too_large" ? "too_large" : "bad_message",
        retryable: false,
      });
      return;
    }
    const message = parsed.message;
    connection.messages.push(message);
    this.received.push(message);
    if (message.t !== "hello" && message.t !== "ack" && this.#sealedSeq !== undefined) {
      if (!this.#answered(message.msgId)) this.#refuse(message.msgId, "sealed", false);
      return;
    }
    switch (message.t) {
      case "hello":
        this.#hello(connection, message);
        return;
      case "ack":
        connection.ackedSeq = Math.max(connection.ackedSeq, message.seq);
        return;
      case "start":
        this.#start(message);
        return;
      case "utterance":
        this.#utterance(message);
        return;
      case "turn_end":
        this.#turnEnd(message);
        return;
      case "usage":
        this.#usage(message);
        return;
      case "witness":
        this.#witness(message);
        return;
      case "metric":
        this.#metric(message);
        return;
      case "end":
        this.#end(message);
        return;
      case "review":
        this.#review(message);
        return;
      case "snooze":
        this.#snooze(message);
        return;
    }
  }

  /** SessionDO's bucket: 20 a second, burst 20, per socket. Always true without a `rateClock`. */
  #takeToken(connection: FakeSessionConnection): boolean {
    if (!this.#rateClock) return true;
    const now = this.#rateClock();
    const bucket = connection.bucket ?? { tokens: 20, at: now };
    bucket.tokens = Math.min(20, bucket.tokens + ((now - bucket.at) / 1000) * 20);
    bucket.at = now;
    connection.bucket = bucket;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  // ─── Messages ───────────────────────────────────────────────────────────────────────────────

  #hello(connection: FakeSessionConnection, message: ClientMessageOf<"hello">): void {
    if (!this.answerHellos) return;
    connection.helloed = true;
    connection.send({
      t: "welcome",
      sessionId: this.sessionId,
      lastSeq: this.log.length - 1,
      protocol: SESSION_PROTOCOL_VERSION,
    });
    for (const event of this.log.slice(message.lastSeq + 1)) {
      if (!connection.isOpen) return;
      this.#sendEvent(connection, event);
    }
  }

  #start(message: ClientMessageOf<"start">): void {
    if (this.#answered(message.msgId)) return;
    if (this.#endedSeq !== undefined) {
      this.#refuse(message.msgId, "already_ended", false);
      return;
    }
    if (this.#startedSeq !== undefined) {
      this.#ackExisting(message.msgId, this.#startedSeq);
      return;
    }
    const [started] = this.#commit(message.msgId, [
      {
        type: "session.started",
        payload: {
          mode: message.mode,
          engine: message.engine,
          providers: message.providers,
          startedAt: message.startedAt,
        },
      },
    ]);
    this.#startedSeq = started?.seq;
  }

  #utterance(message: ClientMessageOf<"utterance">): void {
    if (this.#answered(message.msgId)) return;
    const refusal = this.#speechRefusal();
    if (refusal) {
      this.#refuse(message.msgId, refusal.code, refusal.retryable);
      return;
    }
    const existing = this.#utterances.get(message.utterance.utteranceId);
    if (existing !== undefined) {
      this.#ackExisting(message.msgId, existing);
      return;
    }
    const [event] = this.#commit(message.msgId, [
      { type: "utterance.final", payload: message.utterance },
    ]);
    if (!event) return;
    this.#utterances.set(message.utterance.utteranceId, event.seq);
    this.#turns.set(message.turnId, [...(this.#turns.get(message.turnId) ?? []), event.seq]);
  }

  #turnEnd(message: ClientMessageOf<"turn_end">): void {
    this.turnKeys.push(message.key);
    if (this.#answered(message.msgId) || this.#inflight.has(message.msgId)) return;
    const refusal = this.#speechRefusal();
    if (refusal) {
      this.#refuse(message.msgId, refusal.code, refusal.retryable);
      return;
    }
    this.#inflight.add(message.msgId);
    if (!this.#turnRuns.has(message.turnId))
      this.#turnRuns.set(message.turnId, { proposals: null });
    for (const connection of this.connections) {
      if (connection.isOpen && connection.helloed) {
        connection.send({ t: "working", turnId: message.turnId, state: "thinking" });
      }
    }
    const run = () => {
      this.#inflight.delete(message.msgId);
      if (this.#answers.has(message.msgId)) return;
      const utterances = (this.#turns.get(message.turnId) ?? []).map(
        (seq) => this.log[seq]?.payload as unknown as UtteranceFinalV2,
      );
      const drafts =
        utterances.length > 0
          ? (this.#propose?.({ turnId: message.turnId, utterances, llm: message.llm }) ?? [])
          : [];
      const proposals: ProposalCreatedV2[] = drafts.map((draft) => ({
        proposalId: this.#newId(),
        supersedes: null,
        linker: "linker.v1",
        ...draft,
      }));
      this.#turnRuns.set(message.turnId, { proposals });
      this.#commit(message.msgId, [
        ...proposals.map((proposal) => ({ type: "proposal.created", payload: proposal })),
        {
          type: "turn.completed",
          payload: {
            turnId: message.turnId,
            utteranceIds: utterances.map((utterance) => utterance.utteranceId),
            outcome: proposals.length > 0 ? "proposals" : "nothing_to_propose",
            proposalIds: proposals.map((proposal) => proposal.proposalId),
            attempts: utterances.length > 0 ? 1 : 0,
            llmMs: utterances.length > 0 ? 420 : 0,
          },
        },
      ]);
    };
    if (this.holdTurns) this.#held.push(run);
    else run();
  }

  #usage(message: ClientMessageOf<"usage">): void {
    if (this.#answered(message.msgId)) return;
    if (this.#startedSeq === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    const price = priceStt({
      provider: message.provider,
      model: message.model,
      audioMs: message.audioMs,
      socketMs: message.socketMs,
    });
    const costUsd = price.ok ? price.costUsd : 0;
    this.#costUsd = Math.round((this.#costUsd + costUsd) * 1e9) / 1e9;
    this.#commit(message.msgId, [
      {
        type: "usage.recorded",
        payload: {
          usageId: this.#newId(),
          kind: "stt",
          provider: message.provider,
          model: message.model,
          audioMs: message.audioMs,
          socketMs: message.socketMs,
          costUsd,
          priceTable: price.ok ? price.priceTable : PRICE_TABLE_DATE,
        },
      },
    ]);
  }

  #witness(message: ClientMessageOf<"witness">): void {
    if (this.#answered(message.msgId) || this.#inflight.has(message.msgId)) return;
    const refusal = this.#speechRefusal();
    if (refusal) {
      this.#refuse(message.msgId, refusal.code, refusal.retryable);
      return;
    }
    // As SessionDO: no witness for a turn it never saw end, and one witness a turn.
    if (!this.#turnRuns.has(message.turnId) || this.#witnessed.has(message.turnId)) {
      this.#refuse(message.msgId, "bad_message", false);
      return;
    }
    this.#witnessed.add(message.turnId);
    const run = () => {
      this.#inflight.delete(message.msgId);
      if (this.#answers.has(message.msgId)) return;
      const proposals = this.#turnRuns.get(message.turnId)?.proposals ?? [];
      const drafts: { type: string; payload: unknown }[] = [];
      let flagged: readonly ProposalFlaggedV1[] = [];
      if (message.outcome === "transcribed") {
        drafts.push({ type: "utterance.final", payload: message.utterance });
        flagged =
          this.#compare?.({
            turnId: message.turnId,
            proposals,
            unbiased: message.utterance,
          }) ?? [];
        for (const flag of flagged) drafts.push({ type: "proposal.flagged", payload: flag });
      }
      drafts.push({
        type: "turn.witnessed",
        payload: {
          turnId: message.turnId,
          outcome: message.outcome === "transcribed" ? "compared" : message.outcome,
          provider: message.provider,
          model: message.model,
          utteranceIds: message.outcome === "transcribed" ? [message.utterance.utteranceId] : [],
          conflicts: flagged.length,
          latencyMs: message.latencyMs ?? null,
          reason: message.outcome === "transcribed" ? null : message.reason,
        },
      });
      const appended = this.#commit(message.msgId, drafts);
      if (message.outcome === "transcribed" && appended[0]) {
        this.#utterances.set(message.utterance.utteranceId, appended[0].seq);
      }
    };
    // A witness for a turn still running waits for it, as SessionDO's does.
    if (this.#turnRuns.get(message.turnId)?.proposals === null && this.holdTurns) {
      this.#inflight.add(message.msgId);
      this.#held.push(run);
    } else run();
  }

  #metric(message: ClientMessageOf<"metric">): void {
    if (this.#answered(message.msgId)) return;
    if (this.#startedSeq === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    const { marks } = message;
    const stage = (from: number, to: number) => Math.max(0, Math.round(to - from));
    this.#commit(message.msgId, [
      {
        type: "turn.measured",
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

  #end(message: ClientMessageOf<"end">): void {
    if (this.#answered(message.msgId) || this.#inflight.has(message.msgId)) return;
    if (this.#startedSeq === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    const run = () => {
      this.#inflight.delete(message.msgId);
      if (this.#answers.has(message.msgId)) return;
      if (this.#endedSeq !== undefined) {
        this.#ackExisting(message.msgId, this.#endedSeq);
        return;
      }
      const [ended] = this.#commit(message.msgId, [
        { type: "session.ended", payload: { endedAt: message.endedAt, costUsd: this.#costUsd } },
      ]);
      this.#endedSeq = ended?.seq;
    };
    // As SessionDO does, `end` waits for any turn still running.
    if (this.#held.length > 0) {
      this.#inflight.add(message.msgId);
      this.#held.push(run);
    } else run();
  }

  #review(message: ClientMessageOf<"review">): void {
    if (this.#answered(message.msgId)) return;
    if (this.#startedSeq === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    const fresh: ProposalReviewedV2[] = [];
    let resentSeq = -1;
    for (const input of message.reviews) {
      const prior = this.#writes.get(input.reviewId);
      if (prior) {
        if (prior.kind !== "review" || prior.proposalId !== input.proposalId) {
          this.#refuse(message.msgId, "bad_message", false);
          return;
        }
        resentSeq = Math.max(resentSeq, prior.seq);
        continue;
      }
      const decides = input.decision === "approved" || input.decision === "edited";
      fresh.push({
        ...input,
        syncEligibleAt: decides ? new Date(this.#now() + UNDO_WINDOW_MS).toISOString() : null,
        by: this.#reviewer,
      });
    }
    if (fresh.length === 0) {
      this.#ackExisting(message.msgId, resentSeq);
      return;
    }
    const check = checkReviews(this.#proposals(), fresh, { tierOf: anyFlagTier, from: "client" });
    if (!check.ok) {
      this.#refuse(message.msgId, "bad_message", false);
      return;
    }
    const appended = this.#commit(
      message.msgId,
      fresh.map((review) => ({ type: "proposal.reviewed", payload: review })),
    );
    for (const [index, event] of appended.entries()) {
      const review = fresh[index];
      if (review) {
        this.#writes.set(review.reviewId, {
          kind: "review",
          seq: event.seq,
          proposalId: review.proposalId,
        });
      }
    }
  }

  #snooze(message: ClientMessageOf<"snooze">): void {
    if (this.#answered(message.msgId)) return;
    if (this.#startedSeq === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    const prior = this.#writes.get(message.snoozeId);
    if (prior) {
      if (prior.kind !== "snooze" || prior.proposalId !== message.proposalId) {
        this.#refuse(message.msgId, "bad_message", false);
      } else {
        this.#ackExisting(message.msgId, prior.seq);
      }
      return;
    }
    const snooze = {
      snoozeId: message.snoozeId,
      proposalId: message.proposalId,
      until: message.until,
      by: this.#reviewer,
    };
    if (!checkSnooze(this.#proposals(), snooze).ok) {
      this.#refuse(message.msgId, "bad_message", false);
      return;
    }
    const [event] = this.#commit(message.msgId, [{ type: "proposal.snoozed", payload: snooze }]);
    if (event) {
      this.#writes.set(snooze.snoozeId, {
        kind: "snooze",
        seq: event.seq,
        proposalId: snooze.proposalId,
      });
    }
  }

  /** The log's proposals, folded, as the writers' rules read them. */
  #proposals() {
    return replay(this.log, { proposals: proposalsProjection }).proposals;
  }

  // ─── Answers and the log ────────────────────────────────────────────────────────────────────

  #speechRefusal(): { code: SessionErrorCode; retryable: boolean } | undefined {
    if (this.#startedSeq === undefined) return { code: "not_started", retryable: true };
    if (this.#endedSeq !== undefined) return { code: "already_ended", retryable: false };
    return undefined;
  }

  #answered(msgId: string): boolean {
    if (!this.#answers.has(msgId)) return false;
    this.#answer(msgId);
    return true;
  }

  #ackExisting(msgId: string, seq: number): void {
    this.#answers.set(msgId, { seq, error: null });
    this.#answer(msgId);
  }

  #refuse(msgId: string, code: SessionErrorCode, retryable: boolean): void {
    this.#toClients({ t: "error", code, retryable, msgId });
  }

  #commit(
    msgId: string,
    drafts: readonly { type: string; payload: unknown }[],
    error: Answer["error"] = null,
  ): EventEnvelope[] {
    const appended = drafts.map((draft) =>
      this.#append(draft.type, draft.payload as Record<string, unknown>),
    );
    this.#answers.set(msgId, { seq: appended.at(-1)?.seq ?? null, error });
    this.commits.set(msgId, (this.commits.get(msgId) ?? 0) + 1);
    for (const event of appended) this.#broadcast(event);
    this.#answer(msgId);
    return appended;
  }

  #answer(msgId: string): void {
    const answer = this.#answers.get(msgId);
    if (!answer) return;
    this.#toClients(
      answer.seq === null ? { t: "ack", msgId } : { t: "ack", msgId, seq: answer.seq },
    );
    if (answer.error) this.#toClients({ t: "error", ...answer.error, msgId });
  }

  #append(type: string, payload: Record<string, unknown>): EventEnvelope {
    const schemaVersion = WRITTEN_VERSIONS[type] ?? defaultRegistry.latestVersion(type);
    if (schemaVersion === undefined) throw new Error(`unknown event type ${type}`);
    const event: EventEnvelope = {
      id: this.#newId(),
      sessionId: this.sessionId,
      seq: this.log.length,
      type,
      schemaVersion,
      ts: new Date(this.#now()).toISOString(),
      payload,
    };
    defaultRegistry.validate(event);
    this.log.push(event);
    return event;
  }

  #broadcast(event: EventEnvelope): void {
    for (const connection of this.connections) {
      if (connection.isOpen && connection.helloed) this.#sendEvent(connection, event);
    }
  }

  #toClients(message: ServerMessage): void {
    for (const connection of this.connections) connection.send(message);
  }

  #sendEvent(connection: FakeSessionConnection, event: EventEnvelope): void {
    if (this.withhold.has(event.seq) || this.skipOnce.delete(event.seq)) return;
    connection.send({ t: "event", event });
    const code = this.dropAfter.get(event.seq);
    if (code !== undefined) {
      this.dropAfter.delete(event.seq);
      connection.socket.close(code, "");
    }
  }
}
