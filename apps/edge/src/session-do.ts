// SessionDO: one Durable Object per capture session (docs/adr/0003, Phase 3 spec WP6).
//
// - It holds the session's socket with the hibernation API, so an idle session costs nothing.
// - It writes every event to its own SQLite before anything leaves it, numbered from 0, with
//   UUIDv7 ids and the DO's clock (spec §4.4).
// - Every client message that changes state carries a msgId: its events and its `client_msgs` row
//   commit together, so a resend gets the same answer and changes nothing.
// - A client resumes from its last seq after any drop: `hello` replays what it missed.
// - `turn_end` runs extraction through `@earshot/agent`'s `runTurn`, one turn at a time, with the
//   turn's LLM key used for that call and referenced nowhere else. From Phase 4 (WP8) the turn
//   runs the understanding step too (spec §4.3): the extractor quotes the words that named each
//   record, and the entity linker resolves them against `start`'s records, with the account open
//   in Earshot and the session's earlier links as context. The link index is built lazily, once
//   per instance: after every wake, from the stored entities. Extraction reads only the biased
//   witness's utterances.
// - `witness` (Phase 4 WP9) brings a turn's second, unbiased transcript, which the browser made on
//   its own provider key. It's compared with the turn's proposals as soon as both exist, with the
//   link context the turn kept (`turns`): right away for a finished turn, or right after
//   extraction, in the session's order, for one still running. Each conflict appends
//   `proposal.flagged` (a flag, and a downgrade to "ask" for a decided target), then
//   `turn.witnessed` says how the witness ended.
// - `review` and `snooze` (Phase 5 WP3) are the tray's reviews: checked with `@earshot/events`'
//   writer rules against the session's folded proposals, filled in with who sent them (the pinned
//   user, and how and when the ticket's web session signed in) and when an approval may sync, and
//   appended as `proposal.reviewed` v2 and `proposal.snoozed`. A later witness flag on an approved
//   or edited proposal reopens it (`mode: "system"`).
// - Approval policies (Phase 5 spec §4.6, WP11): `start` may carry the workspace's policy, signed
//   for this session by the web app with the ticket secret. A snapshot that doesn't verify against
//   this session's id refuses the `start`; one that does is kept in `meta`. Right after each turn's
//   understanding step, every new proposal a rule matches (unmarked, linked, superseding nothing,
//   none of the rule's held-back fields) is approved in the turn's own transaction, as a
//   `proposal.reviewed` v2 with `mode: "policy"`, by the session's user with no sign-in. Without a
//   usable audit key no policy applies, and a later flag reopens an auto-approval as any other.
// - The recap (Phase 5 spec §4.9, WP10): right after `session.ended`, in the serial queue, one
//   forced tool call on the session's provider, on the key `end.recap` carried, within a 15 s
//   deadline (target), appends `recap.created` and its `usage.recorded`. No key, no speech, a
//   failure, or the deadline gives a `recap.created` that says so, so every ended session gets
//   exactly one. The key lives in the call's closure only, never in storage or a log. The tray
//   keeps working meanwhile: reviews don't wait in the serial queue.
// - The seal (Phase 5 spec §4.3): a minute after `end`, or after the last write that followed it,
//   capped at 30 minutes, the alarm appends `session.sealed`, the last event this object ever
//   writes, and flushes it. It runs in the serial queue, so after the recap; a recap still owed
//   then (lost to a restart mid-call) is recorded as failed, `timeout`, with the seal. After it
//   every client message but `hello` and `ack` is refused with `sealed`, and the web Worker writes
//   the session's reviews in Postgres instead.
// - Corrections and follow-up questions (Phase 5 spec WP13; ADR-0038): after each turn's proposals,
//   `followup.asked` for a value a proposal needs (at most two a turn, none on a loud card, none on
//   one a policy approved); `correct`, sent instead of `turn_end` for a correction turn, reads that
//   turn's utterances into a proposal that supersedes the one corrected (`correctProposal`: the
//   linker, the normalizers, the words as said; no model call and no key), then `followup.closed`
//   for each question it answers, or refuses words it can't read with `unreadable` and writes
//   nothing; `followup` skips a question. Typed utterances (`input: "typed"`) are a correction's
//   words: taken from `start` until the seal, and never ended by `turn_end`.
// - The log flushes to Postgres through a Queue (WP7), and the object deletes itself a day after
//   Postgres confirms the whole session, seal included; `purge()` deletes it at once, for account
//   deletion. `sealNow()` seals an ended session at once, for the web Worker's repair path.
//
// The entry modules (src/index.ts, src/e2e.ts, the tests' worker) each export a `SessionDO`
// subclass that picks its dependencies: the agent, the flush sink, and the price table.

import { DurableObject } from "cloudflare:workers";
import {
  failedRecap,
  type ProposalLink,
  RECAP_RETRY_POLICY,
  type RecapResult,
  type RetryPolicy,
  recapProposals,
  skippedRecap,
  TARGET_KINDS,
  type WitnessTurnResult,
  withRecentLinks,
  witnessTurn,
} from "@earshot/agent";
import {
  type ClientMessage,
  type ClientMessageOf,
  correctionProposalId,
  type EntityRef,
  type FollowupAskedV1,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  MAX_TARGET_CANDIDATES,
  type MessageParseFailure,
  PolicySnapshot,
  type PolicyVersion,
  type ProposalCreatedV2,
  type ProposalFlaggedV1,
  type ProposalReviewedV2,
  type ProposalSnoozedV1,
  parseClientMessage,
  type RecapCreatedV1,
  type RecapRequest,
  type Reviewer,
  type ReviewSeen,
  SESSION_PROTOCOL_VERSION,
  type ServerMessage,
  type SessionCloseName,
  type SessionErrorCode,
  type SignInMethod,
  type TicketClaims,
  UNDO_WINDOW_MS,
  type UsageRecordedV1,
  type UtteranceFinalV2,
  type UtteranceFinalV3,
  uuidv7,
  verifyPolicySnapshot,
} from "@earshot/core";
import {
  CORRECTION_LIMITS,
  carriedFlag,
  checkCorrection,
  checkFollowupSkip,
  checkReview,
  checkReviews,
  checkSnooze,
  defaultRegistry,
  type EventEnvelope,
  type PolicyExclusion,
  type ProposalView,
  policyRuleFor,
  proposalsProjection,
  type SessionEvent,
  type TierOf,
} from "@earshot/events";
import type { AuditSigningState } from "@earshot/keys/server";
import { correctProposal } from "@earshot/understanding/correct";
import { followupsFor } from "@earshot/understanding/followups";
import { buildLinkIndex, type LinkIndex } from "@earshot/understanding/link";
import { tierOf } from "@earshot/understanding/tiers";
import type { PriceResult, SttUsageInput } from "@earshot/voice/prices";
import type { TurnAgent, TurnResult } from "./agent";
import { readAuditSigning, readTicketKey } from "./config";
import { type FlushSink, packFlushMessages, type SessionIdentity } from "./flush-message";
import { createLogger, type Logger } from "./log";
import { hasUnstorableString, toStorable } from "./session/jsonb";
import {
  FLUSH_TIMING,
  newBucket,
  type RateBucket,
  RECAP_TIMING,
  recentStarts,
  recentTurnStarts,
  resendDueMs,
  SEAL_TIMING,
  SESSION_LIMITS,
  TYPED_CORRECTION_GRACE_MS,
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
  /**
   * The audit signing key's state, which decides whether `review` is taken (fail closed without
   * a usable key). Defaults to `readAuditSigning` on the Worker's environment; tests stub it.
   */
  readonly auditSigning?: (env: Env) => Promise<AuditSigningState>;
  /**
   * The recap's retries and deadline (Phase 5 WP10): `@earshot/agent`'s, two attempts within
   * 15 s, unless a test passes a shorter deadline.
   */
  readonly recapPolicy?: RetryPolicy;
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
  /**
   * How and when the web session that minted the socket's ticket signed in (`am`, `sat`), which
   * each review this socket sends records as `by.auth`. Absent for a ticket without them.
   */
  readonly am?: SignInMethod;
  readonly sat?: number;
  /** Whether the client sent `hello`: only then does it get events as they're appended. */
  helloed: boolean;
  /** The client's cumulative ack. */
  ackedSeq: number;
}

/** What `sealNow()` found: still capturing, sealed by this call, sealed before, or nothing held. */
export type SealAnswer = "live" | "sealing" | "sealed" | "gone";

/**
 * The likely-edit tier (Phase 5 spec §4.4): what the writer rules read for "accept all" and
 * policies, and what SessionDO's own reviews record as seen. One function decides everywhere.
 */
const TIER_OF: TierOf = tierOf;

/** The approval policy as `meta` keeps it: the verified snapshot, without its signature. */
const StoredPolicy = PolicySnapshot.omit({ sig: true });

/** The session's proposals as the log folds them, and each one's linker, as of event `seq`. */
interface FoldedLog {
  readonly seq: number;
  readonly proposals: readonly ProposalView[];
  readonly linkers: ReadonlyMap<string, string | null>;
}

/** A turn's proposals as the session's policy judged them: approvals by proposal, the rest by why. */
interface PolicyJudgement {
  readonly approvals: ReadonlyMap<string, ProposalReviewedV2>;
  readonly excluded: Partial<Record<PolicyExclusion | "refused", number>>;
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

/** Where a client frame's msgId sits: the client writes `t`, then `msgId`, near the start. */
const RAW_MSG_ID =
  /"msgId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"/;

/**
 * The msgId of a frame that failed to parse, read from its first 256 characters without parsing
 * the rest (it may be oversized or not JSON at all); none if it isn't there.
 */
function rawMsgIdOf(frame: string | ArrayBuffer): { msgId?: string } {
  if (typeof frame !== "string") return {};
  const match = RAW_MSG_ID.exec(frame.slice(0, 256));
  return match?.[1] ? { msgId: match[1] } : {};
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

/** The session's earlier links, as `link_recent` stores them, or none. */
function readRecent(stored: string | undefined): string[] {
  if (!stored) return [];
  try {
    const recent: unknown = JSON.parse(stored);
    return Array.isArray(recent) ? recent.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** A turn's link context, as `turns.links` stores it, or none. */
function readLinks(stored: string): ProposalLink[] {
  try {
    const links: unknown = JSON.parse(stored);
    return Array.isArray(links) ? (links as ProposalLink[]) : [];
  } catch {
    return [];
  }
}

/** The span of a turn's biased utterances on the session's clock, or null when it has none. */
function turnWindow(
  utterances: readonly UtteranceFinalV2[],
): { readonly startMs: number; readonly endMs: number } | null {
  if (utterances.length === 0) return null;
  return {
    startMs: Math.min(...utterances.map((utterance) => utterance.startMs)),
    endMs: Math.max(...utterances.map((utterance) => utterance.endMs)),
  };
}

/** Whether an utterance and its words lie within `slackMs` of a turn's window. */
function withinWindow(
  utterance: UtteranceFinalV2,
  window: { readonly startMs: number; readonly endMs: number },
  slackMs: number,
): boolean {
  const lo = window.startMs - slackMs;
  const hi = window.endMs + slackMs;
  const inside = (start: number, end: number) => start >= lo && end <= hi;
  return (
    inside(utterance.startMs, utterance.endMs) &&
    (utterance.words ?? []).every((word) => inside(word.startMs, word.endMs))
  );
}

/** How many of a turn's targets the linker linked, asked about, made new, or left without one. */
function countDecisions(
  proposals: TurnResult["proposals"],
): Record<"linked" | "ask" | "new" | "none", number> {
  const counts = { linked: 0, ask: 0, new: 0, none: 0 };
  for (const proposal of proposals) counts[proposal.target.decision] += 1;
  return counts;
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

/**
 * What a card shows for a proposal, as a review's `seen` records it: for SessionDO's own reviews,
 * which no card showed, the proposal as the log now has it.
 */
function seenOf(proposal: ProposalView): ReviewSeen {
  const { target } = proposal;
  return {
    tier: TIER_OF(proposal).tier,
    fields: Object.fromEntries(
      Object.entries(proposal.fields).map(([name, field]) => [name, { proposed: field.value }]),
    ),
    target:
      target.decision === "none"
        ? null
        : {
            entityId: target.entityId,
            offered: target.candidates
              .slice(0, MAX_TARGET_CANDIDATES)
              .map((candidate) => candidate.entityId),
          },
    relinked: null,
    clip: "none",
  };
}

/** The proposals as they stand once `event` is folded in: the projection's own step. */
function foldInto(
  proposals: readonly ProposalView[],
  sessionId: string,
  event: Pick<SessionEvent, "type" | "schemaVersion" | "payload">,
): readonly ProposalView[] {
  const envelope = { id: uuidv7(), sessionId, seq: -1, ts: new Date(0).toISOString(), ...event };
  return proposalsProjection.apply(proposals, envelope as SessionEvent);
}

export class SessionRuntime extends DurableObject<Env> {
  readonly #deps: SessionDeps;
  readonly #now: () => number;
  readonly #store: SessionStore;
  readonly #log: Logger;
  /** Turns and `end` run one at a time, in arrival order. */
  #chain: Promise<unknown> = Promise.resolve();
  /**
   * msgIds of `turn_end`, `witness`, and `end` messages running or queued, so a resend starts
   * nothing.
   */
  readonly #inflight = new Set<string>();
  /** Turns whose `turn_end` is queued or running here, by turn id. */
  readonly #runningTurns = new Set<string>();
  /** Turns with a witness waiting for them here: turn id to the witness's msgId. */
  readonly #witnessing = new Map<string, string>();
  readonly #controllers = new Set<AbortController>();
  readonly #buckets = new Map<string, RateBucket>();
  #flushing: Promise<void> | null = null;
  /** The pending alarm, as last set or read. */
  #alarmAt: number | null = null;
  /** Set once `purge()` runs in this instance; `meta.purged_ms` says the same across instances. */
  #purged = false;
  /**
   * The linker's index of `start`'s records, built on the first turn that needs it. The
   * constructor runs again after every hibernation and eviction, so a woken object builds it anew
   * from the stored entities (spec WP8 step 4).
   */
  #linkIndex: LinkIndex | null = null;
  /**
   * The session's proposals as its log folds them, and the linker each one's `proposal.created`
   * names, as of the last event folded: carried on from there, so a message costs the events since
   * rather than a replay of the whole log. In memory; a woken object folds anew.
   */
  #folded: FoldedLog | null = null;

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
      // The protocol checked they come together, and that `sat` isn't after the ticket.
      ...(claims.am !== undefined && claims.sat !== undefined
        ? { am: claims.am, sat: claims.sat }
        : {}),
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
    // Once the socket went over the rate, frames still arriving before the close are dropped
    // unhandled, so nothing after the first refused message can run out of order.
    if (bucket.closed) return;
    if (takeMessage(bucket, now) === "close") {
      this.#log.warn("socket closed", { close: "rate_limited" });
      closeWith(ws, "rate_limited");
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
    // With the msgId the client can drop the message for good, instead of resending it on
    // every reconnect.
    sendMessage(ws, {
      t: "error",
      code: reason === "too_large" ? "too_large" : "bad_message",
      retryable: false,
      ...rawMsgIdOf(frame),
    });
  }

  async #handle(ws: WebSocket, attachment: Attachment, message: ClientMessage): Promise<void> {
    if (message.t !== "hello" && message.t !== "ack" && this.#isSealed()) {
      // A resend of a message handled before the seal gets its first answer; anything new is
      // refused for good, and the tray sends its reviews to the web route instead.
      if (this.#answered(message.msgId)) return;
      this.#refuse(message.msgId, "sealed", false);
      return;
    }
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
      case "witness":
        return this.#witness(message);
      case "metric":
        return this.#metric(message);
      case "end":
        return this.#end(message);
      case "review":
        return this.#review(attachment, message);
      case "snooze":
        return this.#snooze(attachment, message);
      case "correct":
        return this.#correct(message);
      case "followup":
        return this.#followup(message);
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

  /**
   * `session.started`, once. A second `start` under a new msgId gets the first one's seq. The
   * approval policy it may carry (Phase 5 WP11) must verify against this session's id: a forged
   * snapshot, or one signed for another session, refuses the `start` with `bad_message`, and one
   * that verifies is kept in `meta` for the session's turns. The policy a session started with is
   * the one it keeps: a later `start`'s snapshot changes nothing, and a change to the workspace's
   * policy applies from the next session.
   */
  async #start(message: ClientMessageOf<"start">): Promise<void> {
    // Before any check: verifying the snapshot yields, and everything after it runs in one go.
    const policy =
      message.policy === undefined ? undefined : await this.#verifyPolicy(message.policy);
    const store = this.#store;
    if (this.#answered(message.msgId)) return;
    if (policy === "unavailable") {
      this.#refuse(message.msgId, "internal", false);
      return;
    }
    if (policy === null) {
      // A fixed reason only: never the snapshot or its signature.
      this.#log.warn("start refused", { reason: "policy_signature" });
      this.#refuse(message.msgId, "bad_message", false);
      return;
    }
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
          // The protocol has checked it's one of the entities.
          if (message.focusEntityId) store.set("focus_entity_id", message.focusEntityId);
          // Verified above; kept without its signature, which nothing needs again.
          if (policy) store.set("policy", JSON.stringify(policy));
        },
      },
    );
    this.#linkIndex = null;
    this.#log.info("session started", {
      entities: message.entities.length,
      focus: message.focusEntityId !== undefined,
      policyVersion: policy?.version ?? null,
      policyRules: policy?.rules.autoApprove.length ?? 0,
    });
  }

  /**
   * The approval policy `start` carried, once its signature verifies against this session's id
   * with the ticket secret (`verifyPolicySnapshot`, compared in constant time): its id, version,
   * and rules. Null for a snapshot that doesn't verify; `unavailable` when the secret can't be
   * read here, which the socket route would have refused first.
   */
  async #verifyPolicy(snapshot: PolicySnapshot): Promise<PolicyVersion | null | "unavailable"> {
    const sid = this.#store.get("sid");
    if (sid === undefined) return null;
    let key: CryptoKey;
    try {
      key = await readTicketKey(this.env);
    } catch (error) {
      this.#log.error("policy unverifiable", { cause: errorName(error) });
      return "unavailable";
    }
    if (!(await verifyPolicySnapshot(key, snapshot, sid))) return null;
    return { id: snapshot.id, version: snapshot.version, rules: snapshot.rules };
  }

  /** The approval policy this session started with, or null: none came, or it's unreadable. */
  #policy(): PolicyVersion | null {
    const stored = this.#store.get("policy");
    if (stored === undefined) return null;
    try {
      const parsed = StoredPolicy.safeParse(JSON.parse(stored));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** The linker's index of the session's records: built once per instance, on first use. */
  #index(): LinkIndex {
    this.#linkIndex ??= buildLinkIndex(readEntities(this.#store.get("entities")));
    return this.#linkIndex;
  }

  /**
   * `utterance.final` v3 (Phase 5 WP13): the client's words, said into the microphone, written with
   * `input: "speech"`. Typed words never come this way: they ride on the `correct` message they
   * belong to. The same utterance under a new msgId gets the first one's seq.
   */
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
    const payload: UtteranceFinalV3 = { ...message.utterance, input: "speech" };
    this.#commit(
      message.msgId,
      [{ type: "utterance.final", schemaVersion: 3, payload: { ...payload } }],
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
    // Typed words are a correction's (Phase 5 WP13): their turn ends with `correct`, never with an
    // extraction call.
    if (store.turnUtterances(message.turnId).some((utterance) => utterance.input === "typed")) {
      this.#log.warn("turn refused", { reason: "typed_words" });
      this.#refuse(message.msgId, "bad_message", false);
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
    this.#runningTurns.add(message.turnId);
    try {
      await this.#serially(() => this.#runTurn(message));
    } finally {
      this.#inflight.delete(message.msgId);
      this.#runningTurns.delete(message.turnId);
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

    // The session's approval policy (Phase 5 WP11), and whether its approvals can be recorded:
    // without a usable audit key the flush couldn't store them with their audit rows, so none is
    // made (fail closed). Read before the call, so everything after it runs in one go.
    const policy = this.#policy();
    const applyPolicy = policy !== null && (await this.#auditReady());
    if (policy !== null && !applyPolicy) {
      this.#log.warn("policy not applied", { reason: "audit_unavailable" });
    }

    const controller = new AbortController();
    this.#controllers.add(controller);
    let result: TurnResult;
    try {
      // Validated as `utterance.final` v2 when they arrived. Extraction never reads the second
      // witness's words (spec §4.2): only the biased stream's are the turn's transcript.
      const utterances = (
        store.turnUtterances(message.turnId) as unknown as UtteranceFinalV2[]
      ).filter((utterance) => utterance.witness !== "unbiased");
      result = await agent.runTurn({
        extractor,
        turnId: message.turnId,
        utterances,
        session: {
          index: this.#index(),
          focusEntityId: store.get("focus_entity_id") ?? null,
          recent: readRecent(store.get("link_recent")),
        },
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
    // Model output: cleaned of anything Postgres's jsonb would refuse.
    const created = result.proposals.map(
      (proposal) => toStorable(proposal) as unknown as ProposalCreatedV2,
    );
    // The policy's approvals (spec §4.6), by proposal. Anything going wrong in the evaluation is a
    // bug: the turn's proposals are still recorded, every one waiting for a person.
    let judged: PolicyJudgement = { approvals: new Map(), excluded: {} };
    if (applyPolicy && policy !== null) {
      try {
        judged = this.#judgeProposals(created, policy);
      } catch (error) {
        this.#log.error("policy not applied", {
          reason: "evaluation_failed",
          cause: errorName(error),
        });
      }
    }
    const events: NewEvent[] = [];
    /** The policy's approvals among `events`, by position, for the `writes` table. */
    const approvals: { readonly index: number; readonly review: ProposalReviewedV2 }[] = [];
    for (const payload of created) {
      events.push({
        type: "proposal.created",
        schemaVersion: 2,
        payload: payload as unknown as Record<string, unknown>,
      });
      // Each approval right after its proposal, in the turn's own commit.
      const review = judged.approvals.get(payload.proposalId);
      if (!review) continue;
      approvals.push({ index: events.length, review });
      events.push({
        type: "proposal.reviewed",
        schemaVersion: 2,
        payload: review as unknown as Record<string, unknown>,
      });
    }
    // Follow-up questions (Phase 5 WP13), right after the proposals they ask about, about the
    // turn's proposals as they'll stand, its approvals included. A bug here asks nothing: the turn
    // is still recorded.
    let questions: FollowupAskedV1[] = [];
    try {
      questions = this.#followups(message.turnId, created, judged.approvals);
    } catch (error) {
      this.#log.error("follow-ups not asked", { cause: errorName(error) });
    }
    for (const question of questions) {
      events.push({ type: "followup.asked", schemaVersion: 1, payload: { ...question } });
    }
    if (usage) {
      events.push({
        type: "usage.recorded",
        schemaVersion: 1,
        payload: { ...usage } as Record<string, unknown>,
      });
    }
    events.push({
      type: "turn.completed",
      schemaVersion: 1,
      payload: { ...result.completed } as Record<string, unknown>,
    });
    const commitTurn = (
      list: readonly NewEvent[],
      reviews: readonly { readonly index: number; readonly review: ProposalReviewedV2 }[],
    ) =>
      this.#commit(message.msgId, list, {
        during: (appended) => {
          if (usage) this.#addToMeter(usage);
          store.set("link_recent", JSON.stringify(result.recent));
          // What each proposal's linker read, for the second witness's comparison (WP9).
          store.addTurn(
            message.turnId,
            appended.at(-1)?.seq ?? store.lastSeq,
            JSON.stringify(result.links),
          );
          // The policy's approvals, by review id, so no client can reuse one.
          for (const { index, review } of reviews) {
            const event = appended[index];
            if (!event) continue;
            store.addWrite(review.reviewId, {
              kind: "review",
              seq: event.seq,
              proposalId: review.proposalId,
            });
          }
        },
        error: result.error,
      });
    let autoApproved = approvals.length;
    let asked = questions.length;
    try {
      try {
        commitTurn(events, approvals);
      } catch (error) {
        if (approvals.length === 0 && questions.length === 0) throw error;
        // An approval or a question the registry refused: a bug in the policy's review or the
        // follow-up rules. Keep the turn's proposals, unapproved and unasked, for a person.
        this.#log.error("policy approvals or follow-ups not recorded", {
          cause: errorName(error),
        });
        autoApproved = 0;
        asked = 0;
        commitTurn(
          events.filter(
            (event) => event.type !== "proposal.reviewed" && event.type !== "followup.asked",
          ),
          [],
        );
      }
    } catch (error) {
      // An event the registry refused: a bug in the extractor's output. Don't run it again.
      this.#log.error("turn not recorded", { cause: errorName(error) });
      this.#commit(message.msgId, [], { error: { code: "internal", retryable: false } });
      return;
    }
    this.#log.info("turn completed", {
      outcome: result.outcome,
      proposals: result.proposals.length,
      // Counts only, never names or ids: how the linker decided this turn's targets.
      targets: countDecisions(result.proposals),
      attempts: result.completed.attempts,
      llmMs: result.completed.llmMs,
      failure: result.failure,
      // The approval policy's part: counts and codes only.
      ...(applyPolicy ? { autoApproved, policyExcluded: judged.excluded } : {}),
      followups: asked,
    });
  }

  /**
   * The follow-up questions a turn's proposals raise (Phase 5 spec WP13 step 3): `followupsFor`
   * over the turn's proposals folded into the session's as the turn will leave them, its policy
   * approvals included, so a proposal already approved asks nothing. At most two, none on a loud
   * card. Each gets a fresh id.
   */
  #followups(
    turnId: string,
    created: readonly ProposalCreatedV2[],
    approvals: ReadonlyMap<string, ProposalReviewedV2>,
  ): FollowupAskedV1[] {
    if (created.length === 0) return [];
    const sessionId = this.#store.get("sid") ?? "";
    let folded = this.#proposals();
    for (const payload of created) {
      folded = foldInto(folded, sessionId, { type: "proposal.created", schemaVersion: 2, payload });
      const review = approvals.get(payload.proposalId);
      if (review) {
        folded = foldInto(folded, sessionId, {
          type: "proposal.reviewed",
          schemaVersion: 2,
          payload: review,
        });
      }
    }
    const ids = new Set(created.map((payload) => payload.proposalId));
    return followupsFor(folded.filter((proposal) => ids.has(proposal.proposalId))).map(
      (question) => ({
        questionId: uuidv7(),
        turnId,
        proposalId: question.proposalId,
        field: question.field,
        rule: question.rule,
        text: question.text,
      }),
    );
  }

  /**
   * Which of a turn's new proposals the session's policy approves (spec §4.6), each with its
   * approval: every proposal, folded in turn into the session's proposals as the log has them, run
   * through `policyRuleFor`, and each approval checked with the writers' rules (`from: "session"`)
   * before it's folded in too. The rest are counted by why, for the log.
   */
  #judgeProposals(created: readonly ProposalCreatedV2[], policy: PolicyVersion): PolicyJudgement {
    const sessionId = this.#store.get("sid") ?? "";
    const now = this.#now();
    const approvals = new Map<string, ProposalReviewedV2>();
    const excluded: PolicyJudgement["excluded"] = {};
    let folded = this.#proposals();
    for (const payload of created) {
      folded = foldInto(folded, sessionId, { type: "proposal.created", schemaVersion: 2, payload });
      const view = folded.find((candidate) => candidate.proposalId === payload.proposalId);
      if (!view) continue;
      const match = policyRuleFor(view, policy.rules, { tierOf: TIER_OF });
      if (!match.ok) {
        excluded[match.reason] = (excluded[match.reason] ?? 0) + 1;
        continue;
      }
      const review = this.#policyApproval(view, policy, match.rule.id, now);
      const check = checkReview(folded, review, { tierOf: TIER_OF, from: "session" });
      if (!check.ok) {
        // A bug: the evaluation and the writers' rules disagree. The proposal waits for a person.
        this.#log.error("policy approval not recorded", { reason: check.reason });
        excluded.refused = (excluded.refused ?? 0) + 1;
        continue;
      }
      approvals.set(payload.proposalId, review);
      folded = foldInto(folded, sessionId, {
        type: "proposal.reviewed",
        schemaVersion: 2,
        payload: review,
      });
    }
    return { approvals, excluded };
  }

  /**
   * An approval policy's approval of a new proposal (spec §4.6): written by this object
   * (`mode: "policy"`), naming the policy's id, version, and the rule that matched, by the
   * session's user with no sign-in (`auth: null`), no input, the `session` surface, and zero
   * timings, so it never counts as a person's review. Like any approval it may sync only after
   * the undo window, and the rep can undo it as any other.
   */
  #policyApproval(
    proposal: ProposalView,
    policy: PolicyVersion,
    rule: string,
    now: number,
  ): ProposalReviewedV2 {
    return {
      reviewId: uuidv7(),
      proposalId: proposal.proposalId,
      decision: "approved",
      target: null,
      mode: "policy",
      batchId: null,
      policy: { id: policy.id, version: policy.version, rule },
      undoes: null,
      reason: null,
      seen: seenOf(proposal),
      timing: { decisionMs: 0, handlingMs: 0 },
      input: "none",
      surface: "session",
      syncEligibleAt: new Date(now + UNDO_WINDOW_MS).toISOString(),
      by: { userId: this.#store.get("uid") ?? "", auth: null },
    };
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

  /**
   * A turn's second witness (Phase 4 spec §4.2, WP9). It's refused for a turn that never ended
   * here, a second witness for the same turn, an utterance id already in the log, and an utterance
   * whose times fall more than 1 s outside the turn's own words. A witness for a finished turn is
   * compared at once; one for a turn still running waits for it in the session's order, its ack
   * coming when its events are written. A resend gets the same answer and changes nothing.
   */
  async #witness(message: ClientMessageOf<"witness">): Promise<void> {
    const store = this.#store;
    if (this.#answered(message.msgId) || this.#inflight.has(message.msgId)) return;
    if (store.getNumber("started_seq") === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    if (store.get("ended_seq") !== undefined) {
      this.#refuse(message.msgId, "already_ended", false);
      return;
    }
    const refusal = this.#witnessRefusal(message);
    if (refusal) {
      this.#log.warn("witness refused", { reason: refusal });
      this.#refuse(message.msgId, "bad_message", false);
      return;
    }
    if (!this.#runningTurns.has(message.turnId)) {
      this.#settleWitness(message);
      return;
    }
    // Its turn's extraction is queued or running: compare right after it, before anything queued
    // later (the session's `end` included).
    this.#inflight.add(message.msgId);
    this.#witnessing.set(message.turnId, message.msgId);
    try {
      await this.#serially(async () => this.#settleWitness(message));
    } finally {
      this.#inflight.delete(message.msgId);
      this.#witnessing.delete(message.turnId);
    }
  }

  /** Why a witness can't be taken, as a fixed code for the log, or undefined. */
  #witnessRefusal(
    message: ClientMessageOf<"witness">,
  ): "unknown_turn" | "second_witness" | "utterance_reused" | "outside_window" | undefined {
    const store = this.#store;
    const turn = store.turn(message.turnId);
    if (!turn && !this.#runningTurns.has(message.turnId)) return "unknown_turn";
    if ((turn && turn.witnessMsg !== null) || this.#witnessing.has(message.turnId)) {
      return "second_witness";
    }
    if (message.outcome !== "transcribed") return undefined;
    const { utterance } = message;
    if (store.utteranceSeq(utterance.utteranceId) !== undefined) return "utterance_reused";
    // Every utterance of the turn arrived before its turn_end, so the window is whole now.
    const window = turnWindow(this.#biasedUtterances(message.turnId));
    if (!window || !withinWindow(utterance, window, SESSION_LIMITS.witnessWindowMs)) {
      return "outside_window";
    }
    return undefined;
  }

  /** A turn's utterances from the biased stream: its transcript, which proposals quote. */
  #biasedUtterances(turnId: string): UtteranceFinalV2[] {
    // Validated as `utterance.final` v2 when they arrived.
    return (this.#store.turnUtterances(turnId) as unknown as UtteranceFinalV2[]).filter(
      (utterance) => utterance.witness !== "unbiased",
    );
  }

  /**
   * Writes a witness's events after its turn's: the unbiased utterance, a `proposal.flagged` for
   * each conflict, then `turn.witnessed`; or `turn.witnessed` alone for a witness that failed or
   * was skipped.
   */
  #settleWitness(message: ClientMessageOf<"witness">): void {
    const store = this.#store;
    if (this.#isPurged() || store.done(message.msgId)) return;
    if (store.get("ended_seq") !== undefined) {
      this.#refuse(message.msgId, "already_ended", false);
      return;
    }
    const turn = store.turn(message.turnId);
    if (!turn || turn.witnessMsg !== null) {
      // Its turn ended without a record (a failure that wrote nothing), or another witness won.
      this.#log.warn("witness refused", { reason: turn ? "second_witness" : "unknown_turn" });
      this.#refuse(message.msgId, "bad_message", false);
      return;
    }
    let result: WitnessTurnResult = { flagged: [], compared: 0, unavailable: 0 };
    if (message.outcome === "transcribed") {
      try {
        result = witnessTurn({
          links: readLinks(turn.links),
          utterances: this.#biasedUtterances(message.turnId),
          unbiased: message.utterance,
          session: { index: this.#index(), focusEntityId: store.get("focus_entity_id") ?? null },
        });
      } catch (error) {
        // A bug: the witness is still recorded, with nothing flagged.
        this.#log.error("witness comparison failed", { cause: errorName(error) });
      }
    }
    const record = (flagged: WitnessTurnResult["flagged"]) => {
      const events: NewEvent[] = [];
      /** The reopens among `events`, by position, for the `writes` table. */
      const reopens: { readonly index: number; readonly review: ProposalReviewedV2 }[] = [];
      if (message.outcome === "transcribed") {
        events.push({
          type: "utterance.final",
          schemaVersion: 2,
          payload: { ...message.utterance },
        });
      }
      const sessionId = store.get("sid") ?? "";
      let proposals = flagged.length > 0 ? this.#proposals() : [];
      // A proposal corrected before this witness answered stands replaced: each flag also goes to
      // the replacement, for the words it kept (Codex on #67). Read before any flag is folded in.
      const before = proposals;
      const writes = flagged.flatMap((raw) => {
        const carried = carriedFlag(before, raw);
        return carried ? [raw, carried] : [raw];
      });
      for (const raw of writes) {
        const payload = toStorable(raw) as ProposalFlaggedV1;
        events.push({
          type: "proposal.flagged",
          schemaVersion: 1,
          payload: payload as unknown as Record<string, unknown>,
        });
        proposals = foldInto(proposals, sessionId, {
          type: "proposal.flagged",
          schemaVersion: 1,
          payload,
        });
        // Decision 15: a flag on an approval or an edit reopens it, right after the flag.
        const flaggedProposal = proposals.find((p) => p.proposalId === payload.proposalId);
        if (flaggedProposal?.status !== "approved" && flaggedProposal?.status !== "edited") {
          continue;
        }
        const reopen = this.#systemReopen(flaggedProposal);
        const check = checkReview(proposals, reopen, { tierOf: TIER_OF, from: "session" });
        if (!check.ok) {
          this.#log.error("reopen not recorded", { reason: check.reason });
          continue;
        }
        reopens.push({ index: events.length, review: reopen });
        events.push({
          type: "proposal.reviewed",
          schemaVersion: 2,
          payload: reopen as unknown as Record<string, unknown>,
        });
        proposals = foldInto(proposals, sessionId, {
          type: "proposal.reviewed",
          schemaVersion: 2,
          payload: reopen,
        });
      }
      events.push({
        type: "turn.witnessed",
        schemaVersion: 1,
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
      this.#commit(message.msgId, events, {
        during: (appended) => {
          if (message.outcome === "transcribed" && appended[0]) {
            store.addUtterance(message.utterance.utteranceId, message.turnId, appended[0].seq);
          }
          for (const { index, review } of reopens) {
            const event = appended[index];
            if (!event) continue;
            store.addWrite(review.reviewId, {
              kind: "review",
              seq: event.seq,
              proposalId: review.proposalId,
            });
          }
          store.markWitnessed(message.turnId, message.msgId);
        },
      });
      return reopens.length;
    };
    let reopened = 0;
    try {
      reopened = record(result.flagged);
    } catch (error) {
      // A flag the registry refused: a bug in the comparison. Keep the witness without its flags.
      this.#log.error("witness flags not recorded", { cause: errorName(error) });
      try {
        result = { ...result, flagged: [] };
        record([]);
      } catch (retryError) {
        this.#log.error("witness not recorded", { cause: errorName(retryError) });
        this.#commit(message.msgId, [], { error: { code: "internal", retryable: false } });
        return;
      }
    }
    // Counts and codes only: never a name or a word.
    this.#log.info("turn witnessed", {
      outcome: message.outcome,
      reason: message.outcome === "transcribed" ? null : message.reason,
      compared: result.compared,
      unavailable: result.unavailable,
      conflicts: result.flagged.length,
      downgrades: result.flagged.filter((flagged) => flagged.target !== null).length,
      reopened,
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

  /**
   * The tray's reviews (Phase 5 spec §4.2): one decision, or one slice of an "accept all", taken
   * from `start` until the seal. Each review is filled in with who sent it (the pinned user, and
   * how and when the socket's ticket says its web session signed in) and, for an approval or an
   * edit, when it may sync (this object's clock plus the undo window). Reviews whose `reviewId` the
   * log holds are skipped, so a review sent again under a new msgId gets the first one's seq; the
   * rest are checked together with the writers' rules (`checkReviews`) against the session's
   * proposals as the log folds them, and appended as `proposal.reviewed` v2 in one transaction, or
   * refused together with `bad_message`. Without a usable audit signing key, refused with
   * `internal`: the flush couldn't store them with their audit rows (fail closed).
   */
  async #review(attachment: Attachment, message: ClientMessageOf<"review">): Promise<void> {
    // Before any check: loading the key can yield, and everything after it runs in one go.
    const auditReady = await this.#auditReady();
    if (this.#answered(message.msgId)) return;
    if (this.#isSealed()) {
      this.#refuse(message.msgId, "sealed", false);
      return;
    }
    const store = this.#store;
    if (store.getNumber("started_seq") === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    if (!auditReady) {
      this.#log.error("review refused", { reason: "audit_unavailable" });
      this.#refuse(message.msgId, "internal", false);
      return;
    }
    const now = this.#now();
    const by = this.#reviewer(attachment);
    const fresh: ProposalReviewedV2[] = [];
    let resentSeq = -1;
    for (const input of message.reviews) {
      const prior = store.recordedWrite(input.reviewId);
      if (prior) {
        if (prior.kind !== "review" || prior.proposalId !== input.proposalId) {
          this.#log.warn("review refused", { reason: "id_reused" });
          this.#refuse(message.msgId, "bad_message", false);
          return;
        }
        resentSeq = Math.max(resentSeq, prior.seq);
        continue;
      }
      const decides = input.decision === "approved" || input.decision === "edited";
      fresh.push({
        ...input,
        syncEligibleAt: decides ? new Date(now + UNDO_WINDOW_MS).toISOString() : null,
        by,
      });
    }
    if (fresh.length === 0) {
      this.#ackExisting(message.msgId, resentSeq);
      return;
    }
    const check = checkReviews(this.#proposals(), fresh, { tierOf: TIER_OF, from: "client" });
    if (!check.ok) {
      // A fixed code and a position: never an id or a value.
      this.#log.warn("review refused", { reason: check.reason, index: check.index });
      this.#refuse(message.msgId, "bad_message", false);
      return;
    }
    this.#commit(
      message.msgId,
      fresh.map((review) => ({
        type: "proposal.reviewed",
        schemaVersion: 2,
        payload: review as unknown as Record<string, unknown>,
      })),
      {
        during: (appended) => {
          for (const [index, event] of appended.entries()) {
            const review = fresh[index];
            if (!review) continue;
            store.addWrite(review.reviewId, {
              kind: "review",
              seq: event.seq,
              proposalId: review.proposalId,
            });
          }
        },
      },
    );
    this.#log.info("reviews recorded", {
      reviews: fresh.length,
      resent: message.reviews.length - fresh.length,
    });
  }

  /**
   * A snooze, or a wake (`until: null`), under the rules `review` follows, as
   * `proposal.snoozed`. It approves nothing, so it needs no audit key.
   */
  #snooze(attachment: Attachment, message: ClientMessageOf<"snooze">): void {
    if (this.#answered(message.msgId)) return;
    const store = this.#store;
    if (store.getNumber("started_seq") === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    const prior = store.recordedWrite(message.snoozeId);
    if (prior) {
      if (prior.kind !== "snooze" || prior.proposalId !== message.proposalId) {
        this.#log.warn("snooze refused", { reason: "id_reused" });
        this.#refuse(message.msgId, "bad_message", false);
        return;
      }
      this.#ackExisting(message.msgId, prior.seq);
      return;
    }
    const snooze: ProposalSnoozedV1 = {
      snoozeId: message.snoozeId,
      proposalId: message.proposalId,
      until: message.until,
      by: this.#reviewer(attachment),
    };
    const check = checkSnooze(this.#proposals(), snooze);
    if (!check.ok) {
      this.#log.warn("snooze refused", { reason: check.reason });
      this.#refuse(message.msgId, "bad_message", false);
      return;
    }
    this.#commit(
      message.msgId,
      [{ type: "proposal.snoozed", schemaVersion: 1, payload: { ...snooze } }],
      {
        during: ([event]) => {
          if (event) {
            store.addWrite(snooze.snoozeId, {
              kind: "snooze",
              seq: event.seq,
              proposalId: snooze.proposalId,
            });
          }
        },
      },
    );
  }

  /**
   * A correction (Phase 5 spec WP13 step 4), sent instead of `turn_end` for a correction turn, from
   * `start` until the seal. Its words are the turn's utterances, said before it, or the typed words
   * it carries, which are written as a typed utterance in the correction's own transaction, so
   * typed words exist only with a correction that passed its checks. They're read into a proposal
   * that supersedes the one corrected (`correctProposal`: the linker over `start`'s records with
   * the open account and earlier links, the normalizers on the call's time and the rep's time zone,
   * the words as said for the rest; no model call and no key), after the writers' rules
   * (`checkCorrection`, a chain of corrections under its cap included). The new proposal's id
   * derives from the correction's id, so a resend under a new msgId gets the first one's answer.
   * Appended with a `followup.closed` for each open question it answers.
   *
   * Its limits (ADR-0038, after a security review): `CORRECTION_LIMITS`' corrections per window
   * and per session, typed characters per session, and the depth of a chain, refused with
   * `turn_limit`; typed words not past the capture limit by more than `TYPED_CORRECTION_GRACE_MS`,
   * refused with `duration_limit`. A correction doesn't keep the session alive: the idle end counts
   * from before it. Words with no value of the field's kind are refused with `unreadable`, and
   * nothing is appended. Refusals aren't recorded: a resend is checked again, to the same answer.
   * It approves nothing, so it needs no audit key.
   */
  async #correct(message: ClientMessageOf<"correct">): Promise<void> {
    if (this.#answered(message.msgId) || this.#inflight.has(message.msgId)) return;
    const store = this.#store;
    const startedMs = store.getNumber("capture_started_ms");
    if (store.getNumber("started_seq") === undefined || startedMs === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    const sessionId = store.get("sid") ?? "";
    // Before the other checks: the digest yields, and everything after it runs in one go.
    const proposalId = await correctionProposalId(sessionId, message.correctionId);
    if (this.#answered(message.msgId)) return;
    if (this.#isSealed()) {
      this.#refuse(message.msgId, "sealed", false);
      return;
    }
    const refuse = (reason: string) => {
      // A fixed reason: never an id, a field's value, or the words.
      this.#log.warn("correction refused", { reason });
      this.#refuse(message.msgId, "bad_message", false);
    };
    const limited = (reason: string) => {
      // Refused, not recorded: the client hears a refusal, and a resend is checked again.
      this.#log.warn("correction refused", { reason });
      this.#refuse(message.msgId, "turn_limit", false);
    };
    const prior = store.recordedWrite(message.correctionId);
    if (prior) {
      if (prior.kind !== "correction") return refuse("id_reused");
      this.#ackExisting(message.msgId, prior.seq);
      return;
    }
    // A correction turn is its own: nothing else ended it.
    if (store.turn(message.turnId) || this.#runningTurns.has(message.turnId)) {
      return refuse("turn_taken");
    }
    // Validated as `utterance.final` when they arrived; v2 for an older object's, read as speech.
    const said = (store.turnUtterances(message.turnId) as unknown as UtteranceFinalV3[]).filter(
      (utterance) => utterance.witness !== "unbiased",
    );
    const { typed } = message;
    const now = this.#now();
    if (typed) {
      // Typed words are the correction's own: its turn holds no speech, and they're new.
      if (said.length > 0) return refuse("typed_and_spoken");
      if (store.utteranceSeq(typed.utteranceId) !== undefined) return refuse("utterance_reused");
      if (now - startedMs >= SESSION_LIMITS.captureMs + TYPED_CORRECTION_GRACE_MS) {
        this.#log.warn("correction refused", { reason: "duration_limit" });
        this.#refuse(message.msgId, "duration_limit", false);
        return;
      }
      if (
        store.getNumber("typed_chars", 0) + typed.text.length >
        CORRECTION_LIMITS.typedCharsPerSession
      ) {
        return limited("typed_chars");
      }
    } else if (said.length === 0) {
      return refuse("no_words");
    }
    if (store.countCorrections() >= CORRECTION_LIMITS.perSession) return limited("per_session");
    const starts = recentStarts(store.get("correction_starts"), now, CORRECTION_LIMITS.windowMs);
    if (starts.length >= CORRECTION_LIMITS.perWindow) return limited("per_window");
    // Every attempt that gets this far counts, read or not, as each turn's start does.
    store.transaction(() => store.set("correction_starts", JSON.stringify([...starts, now])));

    const { proposals, linkers } = this.#fold();
    const check = checkCorrection(proposals, {
      proposalId: message.proposalId,
      field: message.field,
      questionId: message.questionId ?? null,
    });
    if (!check.ok) return check.reason === "too_deep" ? limited("too_deep") : refuse(check.reason);
    const at = store.lastAudioMs();
    const typedUtterance: UtteranceFinalV3 | null = typed
      ? {
          utteranceId: typed.utteranceId,
          text: typed.text,
          confidence: 1,
          startMs: at,
          endMs: at,
          witness: "biased",
          input: "typed",
        }
      : null;
    const recent = readRecent(store.get("link_recent"));
    const result = correctProposal(
      { ...check.proposal, linker: linkers.get(check.proposal.proposalId) ?? null },
      message.field,
      typedUtterance ? [typedUtterance] : said,
      {
        index: this.#index(),
        focusEntityId: store.get("focus_entity_id") ?? null,
        recent,
        kinds: TARGET_KINDS[check.proposal.type],
        callTime: store.get("call_time") ?? new Date(startedMs).toISOString(),
        timeZone: store.get("time_zone") ?? "UTC",
      },
    );
    if (!result.ok) {
      // Nothing appended, the typed words included, and the card stays as it was: refused, so the
      // client hears it, and a resend is read again to the same answer. Codes only.
      this.#log.info("correction unreadable", { reason: result.reason, kind: result.kind });
      this.#refuse(message.msgId, "unreadable", false);
      return;
    }
    // The words: cleaned of anything Postgres's jsonb would refuse.
    const created = toStorable({ proposalId, ...result.proposal }) as unknown as ProposalCreatedV2;
    const events: NewEvent[] = [
      ...(typedUtterance
        ? [{ type: "utterance.final", schemaVersion: 3, payload: { ...typedUtterance } }]
        : []),
      {
        type: "proposal.created",
        schemaVersion: 2,
        payload: created as unknown as Record<string, unknown>,
      },
      ...check.answers.map((question) => ({
        type: "followup.closed",
        schemaVersion: 1,
        payload: { questionId: question.questionId, outcome: "answered", proposalId },
      })),
    ];
    this.#commit(message.msgId, events, {
      idleNeutral: true,
      during: (appended) => {
        const [first] = appended;
        if (!first) return;
        if (typedUtterance) {
          store.addUtterance(typedUtterance.utteranceId, message.turnId, first.seq);
          store.set("typed_chars", store.getNumber("typed_chars", 0) + typedUtterance.text.length);
        }
        // The commit's last seq, which its ack carries: a resend gets the same answer.
        const last = appended.at(-1)?.seq ?? first.seq;
        store.addWrite(message.correctionId, { kind: "correction", seq: last, proposalId });
        // The turn is used: a later `turn_end` or `correct` for it is refused.
        store.addTurn(message.turnId, last, "[]");
        // A record the rep named is the session's latest link, as a turn's is.
        store.set("link_recent", JSON.stringify(withRecentLinks(recent, [created])));
      },
    });
    this.#log.info("correction recorded", {
      input: typed ? "typed" : "speech",
      field: message.field === "target" ? "target" : "field",
      decision: created.target.decision,
      flags: created.riskFlags.length,
      answered: check.answers.length,
    });
  }

  /**
   * A follow-up question skipped (Phase 5 spec WP13 step 4), from `start` until the seal:
   * `followup.closed` with `skipped`, once `checkFollowupSkip` passes. A question skipped before
   * gets that skip's seq, whatever the msgId.
   */
  #followup(message: ClientMessageOf<"followup">): void {
    if (this.#answered(message.msgId)) return;
    const store = this.#store;
    if (store.getNumber("started_seq") === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    const proposals = this.#proposals();
    const skipped = proposals
      .flatMap((proposal) => proposal.followups)
      .find((followup) => followup.questionId === message.questionId);
    if (skipped?.status === "skipped" && skipped.closedSeq !== null) {
      this.#ackExisting(message.msgId, skipped.closedSeq);
      return;
    }
    const check = checkFollowupSkip(proposals, message.questionId);
    if (!check.ok) {
      this.#log.warn("follow-up refused", { reason: check.reason });
      this.#refuse(message.msgId, "bad_message", false);
      return;
    }
    this.#commit(
      message.msgId,
      [
        {
          type: "followup.closed",
          schemaVersion: 1,
          payload: { questionId: message.questionId, outcome: "skipped", proposalId: null },
        },
      ],
      { idleNeutral: true },
    );
  }

  /**
   * Who made a review or a snooze over this socket: the session's pinned user, and how and when
   * the web session that minted the socket's ticket signed in. A ticket without the sign-in claims
   * (one minted before Phase 5's web app, during a deploy) records `auth: null`: unknown, not
   * unauthenticated, since the ticket itself proves the web app signed the user in.
   */
  #reviewer(attachment: Attachment): Reviewer {
    const userId = this.#store.get("uid") ?? attachment.uid;
    if (attachment.am === undefined || attachment.sat === undefined) return { userId, auth: null };
    return {
      userId,
      auth: { method: attachment.am, signedInAt: new Date(attachment.sat * 1000).toISOString() },
    };
  }

  /** The session's proposals, folded from its log, as the writers' rules read them. */
  #proposals(): readonly ProposalView[] {
    return this.#fold().proposals;
  }

  /**
   * The fold, carried on from the last event it saw to the log's end: each event upcast and folded
   * as `replay` would (the store validated it on the way in). Folded anew if the log is shorter
   * than the fold (storage deleted under it).
   */
  #fold(): FoldedLog {
    const store = this.#store;
    let folded = this.#folded;
    if (folded === null || folded.seq > store.lastSeq) {
      folded = { seq: -1, proposals: [], linkers: new Map() };
    }
    if (folded.seq < store.lastSeq) {
      let { proposals } = folded;
      const linkers = new Map(folded.linkers);
      for (const raw of store.events(store.get("sid") ?? "", folded.seq + 1)) {
        const event = defaultRegistry.toLatest(raw) as SessionEvent;
        proposals = proposalsProjection.apply(proposals, event);
        if (event.type === "proposal.created") {
          linkers.set(event.payload.proposalId, event.payload.linker);
        }
      }
      folded = { seq: store.lastSeq, proposals, linkers };
    }
    this.#folded = folded;
    return folded;
  }

  /** Whether reviews' audit checkpoints can be signed: a usable key, or development's. */
  async #auditReady(): Promise<boolean> {
    const state = await (this.#deps.auditSigning ?? readAuditSigning)(this.env);
    return state.status === "configured" || state.status === "development";
  }

  /**
   * A reopen of an approval or an edit that a later flag put in doubt (spec decision 15): written
   * by this object (`mode: "system"`), with no sign-in, input, or time, naming the review it
   * reverses, and what the proposal looks like after the flag as `seen`.
   */
  #systemReopen(proposal: ProposalView): ProposalReviewedV2 {
    return {
      reviewId: uuidv7(),
      proposalId: proposal.proposalId,
      decision: "reopened",
      target: null,
      mode: "system",
      batchId: null,
      policy: null,
      undoes: proposal.review?.reviewId ?? null,
      reason: "flagged",
      seen: seenOf(proposal),
      timing: { decisionMs: 0, handlingMs: 0 },
      input: "none",
      surface: "session",
      syncEligibleAt: null,
      by: { userId: this.#store.get("uid") ?? "", auth: null },
    };
  }

  /**
   * `session.ended`, after any turn still running, then an immediate flush; then, in the same turn
   * of the serial queue, the recap (Phase 5 WP10), so the seal comes after it. The ack comes with
   * `session.ended`: the client drops the recap's key then, and this object holds it only in the
   * closure below until the recap's call returns.
   */
  async #end(message: ClientMessageOf<"end">): Promise<void> {
    if (this.#answered(message.msgId) || this.#inflight.has(message.msgId)) return;
    if (this.#store.getNumber("started_seq") === undefined) {
      this.#refuse(message.msgId, "not_started", true);
      return;
    }
    this.#inflight.add(message.msgId);
    const recap = message.recap ?? null;
    try {
      await this.#serially(async () => {
        if (this.#finish(message.msgId, message.endedAt)) await this.#recap(recap);
      });
    } finally {
      this.#inflight.delete(message.msgId);
    }
  }

  /**
   * Ends the session: for the client's `end` (msgId), or for an abandoned session (null). True
   * when this call ended it, and so owes the session its recap.
   */
  #finish(msgId: string | null, endedAt: string): boolean {
    if (this.#isPurged()) return false;
    const store = this.#store;
    if (msgId !== null && store.done(msgId)) return false;
    const endedSeq = store.getNumber("ended_seq");
    if (endedSeq !== undefined) {
      if (msgId !== null) this.#ackExisting(msgId, endedSeq);
      return false;
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
          // The seal's grace starts now, whoever ended the session, the idle alarm included.
          store.set("seal_due_ms", now + SEAL_TIMING.graceMs);
          // Every ended session owes one `recap.created`, written next (WP10).
          store.set("recap_due", 1);
        },
      },
    );
    this.#log.info("session ended", { events: store.lastSeq + 1, by: msgId ? "client" : "idle" });
    this.ctx.waitUntil(this.#flushNow());
    return true;
  }

  // ─── The recap ───────────────────────────────────────────────────────────────────────────────

  /**
   * The session's recap (Phase 5 spec §4.9, WP10), right after `session.ended`: `recap.created`,
   * and `usage.recorded` for its calls, in one transaction, then a flush. Without a request (no
   * key came with `end`, or the session ended itself after idling) it's skipped, `no_key`; with
   * no speech, skipped, `no_speech`, with no call; a provider or validation failure, or the 15 s
   * deadline, is failed with its reason. Runs in the serial queue, which the seal waits on.
   */
  async #recap(request: RecapRequest | null): Promise<void> {
    if (this.#isPurged() || this.#store.get("recap_due") === undefined) return;
    const result: RecapResult =
      request === null
        ? {
            recap: skippedRecap("no_key", {}),
            usage: null,
            failure: null,
            trace: [],
            attempts: 0,
            latencyMs: 0,
          }
        : await this.#writeRecap(request);
    if (this.#isPurged()) {
      this.#log.info("recap discarded", { reason: "purged" });
      return;
    }
    this.#recordRecap(result);
  }

  /** The recap's call, on the request's provider and key. Never throws: failures are outcomes. */
  async #writeRecap(request: RecapRequest): Promise<RecapResult> {
    const { agent } = this.#deps;
    const failed = (llm: RecapCreatedV1["llm"]): RecapResult => ({
      recap: failedRecap("provider_error", { llm }),
      usage: null,
      failure: null,
      trace: [],
      attempts: 0,
      latencyMs: 0,
    });
    let recapper: ReturnType<TurnAgent["createRecapper"]>;
    try {
      recapper = agent.createRecapper({
        provider: request.llm.provider,
        model: request.llm.model,
        gateway: agent.aiGatewayFromEnv(this.env),
      });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      // A model with no adapter or price, or an AI Gateway id that can't be part of a URL: fail
      // closed, never direct, and never refuse the end itself.
      this.#log.warn("recap refused", { reason: "unsupported_model_or_gateway" });
      return failed(null);
    }
    const controller = new AbortController();
    this.#controllers.add(controller);
    try {
      return await agent.runRecap({
        recapper,
        utterances: this.#sessionUtterances(),
        proposals: recapProposals(this.#proposals(), this.#entityNames()),
        lens: request.lens ?? null,
        // The recap's key: used for this call and referenced nowhere else.
        apiKey: request.key,
        signal: controller.signal,
        policy: this.#deps.recapPolicy ?? {
          ...RECAP_RETRY_POLICY,
          deadlineMs: RECAP_TIMING.deadlineMs,
        },
      });
    } catch (error) {
      // runRecap turns every provider and validation failure into an outcome, so this is a bug.
      this.#log.error("recap failed", { cause: errorName(error) });
      return failed({ provider: recapper.provider, model: recapper.model });
    } finally {
      this.#controllers.delete(controller);
    }
  }

  /** Appends the recap and its usage, and flushes them at once. */
  #recordRecap(result: RecapResult): void {
    const store = this.#store;
    const write = (recap: RecapCreatedV1, usage: RecapResult["usage"]) =>
      this.#commit(
        null,
        [
          {
            type: "recap.created",
            schemaVersion: 1,
            // Model output: cleaned of anything Postgres's jsonb would refuse.
            payload: toStorable(recap) as unknown as Record<string, unknown>,
          },
          ...(usage
            ? [
                {
                  type: "usage.recorded",
                  schemaVersion: 1,
                  payload: { ...usage } as Record<string, unknown>,
                },
              ]
            : []),
        ],
        {
          during: (appended) => {
            store.set("recap_seq", appended[0]?.seq ?? store.lastSeq);
            store.delete("recap_due");
            if (usage) this.#addToMeter(usage);
          },
        },
      );
    try {
      write(result.recap, result.usage);
    } catch (error) {
      // A recap the registry refused: a bug in the checks. The session still gets its one recap.
      this.#log.error("recap not recorded", { cause: errorName(error) });
      write(failedRecap("invalid_output", { llm: result.recap.llm }), result.usage);
    }
    const { recap } = result;
    // Counts and codes only: never a sentence, a quote, or a name.
    this.#log.info("recap recorded", {
      outcome: recap.outcome,
      reason: recap.reason,
      sentences: recap.sentences.length,
      dropped: recap.dropped,
      weak: recap.sentences.filter((sentence) => sentence.weakSupport).length,
      lens: recap.lens?.id ?? null,
      mentioned: recap.lens?.fields.filter((field) => field.evidence !== null).length ?? null,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
      failure: result.failure ? `${result.failure.code}:${result.failure.detail}` : null,
    });
    this.ctx.waitUntil(this.#flushNow());
  }

  /** The session's utterances, in order: the recap reads the biased stream's (runRecap filters). */
  #sessionUtterances(): UtteranceFinalV2[] {
    const sessionId = this.#store.get("sid") ?? "";
    const utterances: UtteranceFinalV2[] = [];
    for (const event of this.#store.events(sessionId, 0)) {
      // Validated as `utterance.final` v2 when they arrived.
      if (event.type === "utterance.final") {
        utterances.push(event.payload as unknown as UtteranceFinalV2);
      }
    }
    return utterances;
  }

  /** The CRM's name for each of the session's records, from `start`. */
  #entityNames(): (entityId: string) => string | undefined {
    const names = new Map(
      readEntities(this.#store.get("entities")).map((entity) => [entity.id, entity.name]),
    );
    return (entityId) => names.get(entityId);
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
      /**
       * A write that doesn't keep the session alive (a correction or a skip, Phase 5 WP13): the
       * idle end still counts from the last event before it.
       */
      readonly idleNeutral?: boolean;
    } = {},
  ): readonly EventEnvelope[] {
    const store = this.#store;
    const sessionId = store.get("sid");
    if (!sessionId) throw new Error("the session has no id");
    const now = this.#now();
    const pendingBefore = store.lastSeq > store.getNumber("enqueued_seq", -1);
    const error = options.error ?? null;
    const appended = store.transaction(() => {
      const lastBefore = store.lastEventMs;
      const appended = store.append(sessionId, events, { now, newId: uuidv7 });
      if (appended.length > 0) {
        if (!options.idleNeutral) store.delete("idle_anchor_ms");
        else if (store.get("idle_anchor_ms") === undefined) {
          store.set("idle_anchor_ms", lastBefore ?? store.getNumber("capture_started_ms", now));
        }
      }
      options.during?.(appended, now);
      if (!pendingBefore && appended.length > 0) store.set("unflushed_since_ms", now);
      if (msgId !== null) store.markDone(msgId, { seq: appended.at(-1)?.seq ?? null, error }, now);
      // A client's write after `end` restarts the seal's grace, up to its cap.
      if (msgId !== null && appended.length > 0 && this.#awaitingSeal()) {
        const endedMs = store.getNumber("ended_ms", now);
        store.set(
          "seal_due_ms",
          Math.min(endedMs + SEAL_TIMING.maxAfterEndMs, now + SEAL_TIMING.graceMs),
        );
      }
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
   * Flushes now, after any flush already under way: `end` and the seal don't wait for the window,
   * and an event appended while another flush was sending goes in a flush of its own.
   */
  async #flushNow(): Promise<void> {
    await this.#flush();
    await this.#flush();
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
      if (this.#awaitingSeal()) dues.push(this.#sealDueMs());
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

  /**
   * When the seal is due: the grace after `end` or after the last client write that followed it
   * (`seal_due_ms`), and never later than the cap after `end`. An object that ended before the
   * seal existed has no `seal_due_ms`, so its grace runs from `end`, long over: it seals at once.
   */
  #sealDueMs(): number {
    const store = this.#store;
    const endedMs = store.getNumber("ended_ms", this.#now());
    const due = store.getNumber("seal_due_ms") ?? endedMs + SEAL_TIMING.graceMs;
    return Math.min(endedMs + SEAL_TIMING.maxAfterEndMs, due);
  }

  /**
   * Appends `session.sealed`, the last event the object ever writes, and flushes it at once. Runs
   * in the session's serial queue, so after any turn, witness, or `end` queued before it.
   */
  #writeSeal(): void {
    const store = this.#store;
    const now = this.#now();
    // The serial queue ran any recap this object started before getting here, so a recap still
    // owed was lost with the memory that held its key (a restart mid-call): say so, then seal.
    const owed = store.get("recap_due") !== undefined;
    const lost: NewEvent[] = owed
      ? [
          {
            type: "recap.created",
            schemaVersion: 1,
            payload: failedRecap("timeout", { llm: null }) as unknown as Record<string, unknown>,
          },
        ]
      : [];
    this.#commit(
      null,
      [
        ...lost,
        {
          type: "session.sealed",
          schemaVersion: 1,
          payload: { sealedAt: new Date(now).toISOString(), by: "session" },
        },
      ],
      {
        during: (appended) => {
          if (owed) {
            store.set("recap_seq", appended[0]?.seq ?? store.lastSeq);
            store.delete("recap_due");
          }
          store.set("sealed_seq", appended.at(-1)?.seq ?? store.lastSeq);
          store.delete("seal_due_ms");
        },
      },
    );
    if (owed) this.#log.warn("recap lost", { reason: "restarted" });
    this.#log.info("session sealed", { events: store.lastSeq + 1 });
    this.ctx.waitUntil(this.#flushNow());
  }

  /** The alarm's seal: only once the grace is over, since a write while it waited restarts it. */
  #sealIfDue(): void {
    if (this.#isPurged() || !this.#awaitingSeal()) return;
    if (this.#now() < this.#sealDueMs()) return;
    this.#writeSeal();
  }

  /**
   * When an abandoned session is ended: after both the capture limit and its last event that keeps
   * it alive (a correction or a skip doesn't, Phase 5 WP13).
   */
  #idleEndDue(): number {
    const store = this.#store;
    const started = store.getNumber("capture_started_ms", this.#now());
    const lastEvent = store.getNumber("idle_anchor_ms") ?? store.lastEventMs ?? started;
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
   * The flush window's end, the seal once its grace is over, re-sends after the end, the cleanup a
   * day after Postgres confirms the whole log ending in `session.sealed`, ending an abandoned
   * session, and deleting a purge's tombstone. Idempotent: it acts only on what is due, so a
   * retried or early alarm does no harm.
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
      if (this.#awaitingSeal() && now >= this.#sealDueMs()) {
        await this.#serially(async () => this.#sealIfDue());
      }
      const lastSeq = store.lastSeq;
      const cleanupDue = store.getNumber("cleanup_due_ms");
      if (this.#isSealed() && store.getNumber("flushed_seq", -1) >= lastSeq) {
        // Postgres holds the whole log, seal included: nothing more will ever be written here.
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
        // Not sealed yet, or events since Postgres's last confirmation: they come first.
        if (cleanupDue !== undefined) store.transaction(() => store.delete("cleanup_due_ms"));
        const resendDue = store.getNumber("resend_due_ms");
        if (
          store.getNumber("flushed_seq", -1) < lastSeq &&
          store.getNumber("enqueued_seq", -1) >= lastSeq &&
          resendDue !== undefined &&
          now >= resendDue
        ) {
          await this.#resend(now);
        }
      }
    } else if (store.get("started_seq") !== undefined && now >= this.#idleEndDue()) {
      // No client, so no key: the recap is skipped, `no_key`.
      await this.#serially(async () => {
        if (this.#finish(null, new Date(now).toISOString())) await this.#recap(null);
      });
    }
    await this.#schedule();
  }

  /** Deletes the object's storage, tables and alarm included. */
  async #wipe(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) closeWith(ws, "session_ended");
    await this.ctx.storage.deleteAll();
    this.#store.forget();
    this.#linkIndex = null;
    this.#folded = null;
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
   * Postgres holds every event up to `seq`. Once that covers the whole log and the log ends in
   * `session.sealed`, the cleanup alarm is set for a day later: before the seal, more events may
   * still come (Phase 5 spec §4.3).
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
        this.#isSealed() &&
        confirmed >= store.lastSeq &&
        store.get("cleanup_due_ms") === undefined
      ) {
        store.set("cleanup_due_ms", now + FLUSH_TIMING.cleanupAfterConfirmMs);
      }
    });
    await this.#schedule();
  }

  /**
   * Seals an ended session at once, for the web Worker's repair path (`sealSessions`): `sealing`
   * when this call wrote the seal (Postgres has it once its flush lands), `sealed` when it was
   * sealed before, `live` while the session is still capturing (not ended: left alone), and `gone`
   * when the object holds no log (never started, cleaned up, or purged), so the web Worker may seal
   * Postgres's copy itself.
   */
  async sealNow(): Promise<SealAnswer> {
    const store = this.#store;
    if (this.#isPurged() || store.get("sid") === undefined) return "gone";
    if (store.get("started_seq") === undefined) return "gone";
    if (this.#isSealed()) return "sealed";
    if (store.get("ended_seq") === undefined) return "live";
    return this.#serially(async (): Promise<SealAnswer> => {
      if (this.#isPurged()) return "gone";
      if (this.#isSealed()) return "sealed";
      this.#writeSeal();
      this.#log.info("session sealed early", { by: "repair" });
      return "sealing";
    });
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
    this.#linkIndex = null;
    this.#folded = null;
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

  /** Whether `session.sealed` is in the log: then nothing more ever is. */
  #isSealed(): boolean {
    return this.#store.get("sealed_seq") !== undefined;
  }

  /** Ended, and not sealed yet: the grace in which the tray's writes are still taken. */
  #awaitingSeal(): boolean {
    return this.#store.get("ended_seq") !== undefined && !this.#isSealed();
  }
}
