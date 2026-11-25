// The session socket protocol (Phase 3 spec §4.2): JSON text frames between the browser's
// SessionClient and SessionDO, behind the edge Worker's ticket check (session-ticket.ts).
//
// These schemas aren't exported to JSON Schema or Pydantic: only TypeScript speaks the protocol,
// and its key-shape check has no JSON Schema form, so an export would accept messages Zod refuses.
import { z } from "zod";
import { containsKeyShape } from "../key-shapes";
import { ApprovalPolicyRules } from "./approval-policy";
import { EntityRef } from "./entity-ref";
import { EventEnvelope } from "./event-envelope";
import { MAX_TARGET_CANDIDATES } from "./events/proposal-created";
import {
  ProposalReviewedV3,
  ReviewSeen,
  ReviewTarget,
  SeenTarget,
} from "./events/proposal-reviewed";
import { ProposalSnoozedV1 } from "./events/proposal-snoozed";
import { RecapLensId } from "./events/recap-created";
import { SessionProviders } from "./events/session-started";
import { isIanaTimeZone, MAX_TIME_ZONE_CHARS, Timestamp } from "./events/shared";
import { CaptureMode } from "./events/turn-measured";
import { WitnessReason } from "./events/turn-witnessed";
import { UtteranceFinalV2 } from "./events/utterance-final";

/** The protocol version that `hello` and `welcome` carry. */
export const SESSION_PROTOCOL_VERSION = 1;
/**
 * The WebSocket subprotocol a session socket speaks. The browser offers it with its ticket
 * (`ticketSubprotocol`), and the edge answers with it alone, so the ticket is never echoed.
 */
export const SESSION_SUBPROTOCOL = "earshot.v1";
/** The largest client message `SessionDO` reads: 64 KiB of UTF-8 (target). */
export const MAX_MESSAGE_BYTES = 65_536;
/** The longest utterance text a client may send, in UTF-16 code units (target). */
export const MAX_UTTERANCE_TEXT_CHARS = 4_000;

// The longest time zone name `start` accepts, and the check it runs, live with the event contracts
// (`session.started` v2 stores the zone); exported from here too, where they began.
export { isIanaTimeZone, MAX_TIME_ZONE_CHARS };

/** The most CRM entities a `start` message may carry (target). */
export const MAX_SESSION_ENTITIES = 250;
/** The longest entity name or alias a `start` message may carry, in UTF-16 code units. */
export const MAX_ENTITY_NAME_CHARS = 200;
/**
 * The longest record id a `start` message may carry, in UTF-16 code units: an entity's `id` and
 * `parentId`, and `focusEntityId`.
 */
export const MAX_ENTITY_ID_CHARS = 128;
/** The most aliases one entity in a `start` message may carry. */
export const MAX_ENTITY_ALIASES = 20;
/**
 * The most reviews one `review` message may carry (target): one decision, or one slice of an
 * "accept all". A longer batch goes in several messages with the same `batchId`.
 */
export const MAX_REVIEWS_PER_MESSAGE = 25;
/** Bounds on the length of `turn_end.key`. */
export const TURN_KEY_MIN_LENGTH = 20;
export const TURN_KEY_MAX_LENGTH = 512;
/**
 * The heartbeat: literal text frames, not JSON. `SessionDO` answers `ping` with `pong` through
 * `setWebSocketAutoResponse`, which neither wakes it nor bills. The parsers below don't accept
 * them, so check for them first.
 */
export const HEARTBEAT_PING = "ping";
export const HEARTBEAT_PONG = "pong";

/** UUIDv7, minted by the client. A resend reuses it, so `SessionDO` does the work only once. */
const MsgId = z.uuidv7();
/** A turn, named by the client's voice engine. `turn.completed` and `turn.measured` repeat it. */
const TurnId = z.uuid();
/** The last seq one side holds: -1 before the first event. */
const LastSeq = z.int().min(-1);
const Seq = z.int().nonnegative();
/** A provider or model id, such as `anthropic` or `claude-haiku-5-5`. */
const Name = z.string().min(1).max(128);

/** What ended a turn: releasing push-to-talk, the provider's end of turn, or the UI. */
export const TurnTrigger = z.enum(["ptt_release", "provider_eot", "manual"]);
export type TurnTrigger = z.infer<typeof TurnTrigger>;

/** The LLM providers a turn's extraction can use. */
export const LlmProvider = z.enum(["anthropic", "groq"]);
export type LlmProvider = z.infer<typeof LlmProvider>;

/**
 * The LLM key that rides on `turn_end`, checked only for basic shape: 20 to 512 printable ASCII
 * characters with no spaces. Provider prefixes aren't checked, so a provider changing its key
 * format can't break every turn; a wrong key fails at the provider instead.
 */
export const TurnKey = z
  .string()
  .min(TURN_KEY_MIN_LENGTH)
  .max(TURN_KEY_MAX_LENGTH)
  .regex(/^[\x21-\x7e]+$/);

/** A moment on the client's monotonic clock (`performance.now()`), in ms. */
const ClientClockMs = z.number().nonnegative();

/**
 * When one turn's stages happened, on the client's clock alone. `SessionDO` turns them into
 * `turn.measured`: `speechEndToFinalMs = finalMs - speechEndMs`, `finalToProposalMs =
 * proposalMs - finalMs`, `proposalToPaintMs = paintMs - proposalMs`, and `totalMs = paintMs -
 * speechEndMs`, each rounded and floored at 0. A rep who holds push-to-talk after speaking can
 * get the last final before the release; that stage then took no time.
 */
export const TurnMarks = z.strictObject({
  mode: CaptureMode,
  /** The release in push-to-talk; hands-free, when the VAD heard speech stop. */
  speechEndMs: ClientClockMs,
  /** The turn's last final transcript arrived from the provider. */
  finalMs: ClientClockMs,
  /** The turn's first proposal arrived from `SessionDO`. */
  proposalMs: ClientClockMs,
  /** That proposal's card was painted. */
  paintMs: ClientClockMs,
});
export type TurnMarks = z.infer<typeof TurnMarks>;

/** `utterance.final` v2, with the text capped for the socket. */
const CappedUtterance = UtteranceFinalV2.extend({
  text: UtteranceFinalV2.shape.text.max(MAX_UTTERANCE_TEXT_CHARS),
});

/**
 * An utterance as the `utterance` message carries it: `utterance.final` v2 capped for the socket,
 * always speech. `SessionDO` writes it as v3 with `input: "speech"` (Phase 5 WP13). Typed words
 * never come this way: they ride on the `correct` message they belong to.
 */
const SocketUtterance = CappedUtterance;

/** The longest typed correction, in UTF-16 code units (target): a name, a date, a sentence. */
export const MAX_CORRECTION_TEXT_CHARS = 500;

/**
 * `utterance.final` v2 from the unbiased witness, capped like the biased stream's. Only the
 * `witness` message carries one, and it's always speech.
 */
const UnbiasedSocketUtterance = CappedUtterance.extend({ witness: z.literal("unbiased") });

/**
 * What a correction corrects (Phase 5 spec §4.2, WP13): `target`, the proposal's record, or one of
 * its fields by name, such as `dueDate`. No proposal type has a field called `target`.
 */
export const MAX_CORRECTION_FIELD_CHARS = 64;
export const CorrectionField = z
  .string()
  .max(MAX_CORRECTION_FIELD_CHARS)
  .regex(/^[a-z][A-Za-z0-9]*$/);
export type CorrectionField = z.infer<typeof CorrectionField>;

const EntityName = z.string().min(1).max(MAX_ENTITY_NAME_CHARS);
const EntityId = z.string().min(1).max(MAX_ENTITY_ID_CHARS);

/** `EntityRef`, with its lengths capped for the socket. */
const SocketEntityRef = EntityRef.extend({
  id: EntityId,
  name: EntityName,
  aliases: z.array(EntityName).max(MAX_ENTITY_ALIASES),
  parentId: EntityId.optional(),
});

/** A record id in a review, capped like `start`'s; `null` is a new record. */
const ReviewEntityId = EntityId.nullable();

/**
 * `proposal.reviewed` as a person sends it (v3 since Phase 6 WP1; v2's shape, since a person
 * reopens only to undo): over the socket in a `review` message, and to the web route after the
 * seal (Phase 5 spec §4.2). It leaves out `by` and `syncEligibleAt`, which the writer fills from
 * the sender's sign-in and its own clock, and takes only the modes a person reviews in, so it
 * carries no policy and reopens only to undo. Record ids are capped like
 * `start`'s, and, like every client message, it's refused if anything in it is shaped like a key.
 * `checkReview` in `@earshot/events` holds the rules a schema can't.
 */
export const ReviewInput = ProposalReviewedV3.omit({ by: true, syncEligibleAt: true })
  .extend({
    target: ReviewTarget.extend({ entityId: ReviewEntityId }).nullable(),
    mode: z.enum(["single", "batch"]),
    policy: z.null(),
    reason: z.literal("undo").nullable(),
    seen: ReviewSeen.extend({
      target: SeenTarget.extend({
        entityId: ReviewEntityId,
        offered: z.array(ReviewEntityId).max(MAX_TARGET_CANDIDATES),
      }).nullable(),
      relinked: EntityId.nullable(),
    }).nullable(),
  })
  .superRefine(refuseStrayKeys);
export type ReviewInput = z.infer<typeof ReviewInput>;

/** `proposal.snoozed` as a person sends it, without `by`, which the writer fills. */
export const SnoozeInput = ProposalSnoozedV1.omit({ by: true });
export type SnoozeInput = z.infer<typeof SnoozeInput>;

/** The length of a policy snapshot's `sig`: an HMAC-SHA256's 32 bytes in unpadded base64url. */
export const POLICY_SIGNATURE_CHARS = 43;

/**
 * The workspace's approval policy as `POST /api/sessions` signed it for this one session (Phase 5
 * spec §4.6, WP11): its id, version, and rules, and `sig`, base64url HMAC-SHA256 with the ticket
 * secret over `"earshot.policy.v1." + canonical({ id, version, rules, sid })`
 * (`signPolicySnapshot`). SessionDO verifies it against its own session id before it keeps it, so
 * a client can neither forge one nor bring one from another session; the policy it carries applies
 * to this session only, and a later change applies from the next one.
 */
export const PolicySnapshot = z.strictObject({
  id: z.uuid(),
  version: z.int().positive(),
  rules: ApprovalPolicyRules,
  /** `POLICY_SIGNATURE_CHARS` base64url characters. */
  sig: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type PolicySnapshot = z.infer<typeof PolicySnapshot>;

const Hello = z.strictObject({
  t: z.literal("hello"),
  protocol: z.literal(SESSION_PROTOCOL_VERSION),
  /** The last seq the client holds; `SessionDO` replays everything after it. */
  lastSeq: LastSeq,
});

const Start = z
  .strictObject({
    t: z.literal("start"),
    msgId: MsgId,
    mode: z.literal("debrief"),
    engine: z.literal("cascaded"),
    providers: SessionProviders,
    /** When capture started, by the client's clock; `session.started` keeps it. */
    startedAt: Timestamp,
    /** The CRM records the session may mention, from `POST /api/sessions`. */
    entities: z.array(SocketEntityRef).max(MAX_SESSION_ENTITIES),
    /**
     * The rep's IANA time zone (for example `America/Chicago`), so the extractor resolves "by
     * Thursday" against the rep's calendar rather than UTC. Optional: without it, dates resolve in
     * UTC.
     */
    timeZone: z.string().max(MAX_TIME_ZONE_CHARS).refine(isIanaTimeZone).optional(),
    /**
     * The account open in Earshot, if any: the linker's context for short mentions and for a
     * proposal that names no record. It must be one of `entities`.
     */
    focusEntityId: EntityId.optional(),
    /**
     * The workspace's approval policy, signed for this session by `POST /api/sessions` (Phase 5
     * WP11). SessionDO refuses a `start` whose signature doesn't verify (`bad_message`). Without
     * it, every proposal waits for a person.
     */
    policy: PolicySnapshot.optional(),
  })
  .superRefine((start, ctx) => {
    const focus = start.focusEntityId;
    if (focus !== undefined && !start.entities.some((entity) => entity.id === focus)) {
      ctx.addIssue({
        code: "custom",
        path: ["focusEntityId"],
        message: "the focus account must be one of start.entities",
      });
    }
  });

const Utterance = z.strictObject({
  t: z.literal("utterance"),
  msgId: MsgId,
  turnId: TurnId,
  utterance: SocketUtterance,
});

const TurnEnd = z.strictObject({
  t: z.literal("turn_end"),
  msgId: MsgId,
  turnId: TurnId,
  trigger: TurnTrigger,
  llm: z.strictObject({ provider: LlmProvider, model: Name }),
  /** Used for this turn's extraction, then dropped: never stored, logged, or sent on. */
  key: TurnKey,
});

const Usage = z.strictObject({
  t: z.literal("usage"),
  msgId: MsgId,
  /** The speech-to-text provider and model the client used. */
  provider: Name,
  model: Name,
  audioMs: z.int().nonnegative(),
  socketMs: z.int().nonnegative(),
});

/** The `witness` message's fields shared by every outcome. */
const witnessShape = {
  t: z.literal("witness"),
  msgId: MsgId,
  /** The turn the unbiased transcript is of. `SessionDO` takes one witness per turn. */
  turnId: TurnId,
  /** The unbiased witness's provider and model, such as `groq` and `whisper-large-v3-turbo`. */
  provider: Name,
  model: Name,
  /** How long the witness took, by the client's clock, in whole ms. */
  latencyMs: z.int().nonnegative().optional(),
};

/**
 * A turn's second witness (Phase 4 spec §4.2): the browser re-transcribed the turn's audio on its
 * own provider key, without keyterms, and sends the unbiased utterance, or why there's none. The
 * audio and the key go from the browser to the provider; neither rides on this message.
 */
const Witness = z.discriminatedUnion("outcome", [
  z.strictObject({
    ...witnessShape,
    outcome: z.literal("transcribed"),
    utterance: UnbiasedSocketUtterance,
  }),
  z.strictObject({
    ...witnessShape,
    outcome: z.enum(["failed", "skipped"]),
    reason: WitnessReason,
  }),
]);

const Metric = z.strictObject({
  t: z.literal("metric"),
  msgId: MsgId,
  turnId: TurnId,
  marks: TurnMarks,
});

const ClientAck = z.strictObject({
  t: z.literal("ack"),
  /** Cumulative: the client holds every event up to and including this seq. */
  seq: Seq,
});

/**
 * What `end` asks of the recap (Phase 5 spec §4.2, WP10): the session's LLM, its key, and the
 * device's methodology lens, if it chose one. The key is used for the recap's call, after
 * `session.ended`, and referenced nowhere else: like `turn_end.key`, it's the one other place a
 * key may appear, held apart in the client's outbox and dropped on the ack.
 */
export const RecapRequest = z.strictObject({
  llm: z.strictObject({ provider: LlmProvider, model: Name }),
  /** Used for the recap's call, then dropped: never stored, logged, or sent on. */
  key: TurnKey,
  lens: RecapLensId.optional(),
});
export type RecapRequest = z.infer<typeof RecapRequest>;

const End = z.strictObject({
  t: z.literal("end"),
  msgId: MsgId,
  /** When capture stopped, by the client's clock; `session.ended` keeps it. */
  endedAt: Timestamp,
  /**
   * The recap, written after `session.ended` and before the seal (Phase 5 WP10). Without it,
   * `SessionDO` records the recap as skipped, `no_key`.
   */
  recap: RecapRequest.optional(),
});

/**
 * Reviews from the tray (Phase 5 spec §4.2), taken from `start` until the seal: one decision, or
 * one slice of an "accept all", which `SessionDO` checks as one request and appends as
 * `proposal.reviewed` v3. A resend is idempotent by `msgId`, and a repeated `reviewId` gets the
 * first one's seq. Refused with `sealed` once the session is sealed: send them to the web route
 * instead, with the same review ids.
 */
const Review = z.strictObject({
  t: z.literal("review"),
  msgId: MsgId,
  reviews: z.array(ReviewInput).min(1).max(MAX_REVIEWS_PER_MESSAGE),
});

/** A snooze, or a wake (`until: null`), under the same rules as `review`. */
const Snooze = z.strictObject({
  t: z.literal("snooze"),
  msgId: MsgId,
  ...SnoozeInput.shape,
});

/**
 * A correction (Phase 5 spec §4.2, WP13), sent instead of `turn_end` for a correction turn.
 * `SessionDO` reads its words into a proposal that supersedes `proposalId` (`correctProposal`, no
 * model call and no key): the turn's `utterance` messages, sent first, for a spoken correction; or
 * `typed`, for a typed one, which `SessionDO` writes as a typed utterance in the same transaction
 * as the correction, so typed words never exist without the correction they belong to. With
 * `questionId` it answers that follow-up question. Taken from `start` until the seal, like
 * `review`, within the correction limits; idempotent by `msgId`, and a repeated `correctionId`
 * gets the first one's answer. Words with no value of the field's kind are refused with
 * `unreadable`, and nothing is written.
 */
const Correct = z.strictObject({
  t: z.literal("correct"),
  msgId: MsgId,
  /** The correction turn: a fresh turn id, ended by nothing else. */
  turnId: TurnId,
  /** UUIDv7 from the client. The superseding proposal's id derives from it. */
  correctionId: z.uuid(),
  proposalId: z.uuid(),
  field: CorrectionField,
  questionId: z.uuid().optional(),
  /** A typed correction's words, with the id their utterance takes; absent for a spoken one. */
  typed: z
    .strictObject({
      utteranceId: z.uuid(),
      text: z.string().min(1).max(MAX_CORRECTION_TEXT_CHARS),
    })
    .optional(),
});

/** A follow-up question skipped (Phase 5 spec §4.2, WP13): `SessionDO` closes it. */
const Followup = z.strictObject({
  t: z.literal("followup"),
  msgId: MsgId,
  questionId: z.uuid(),
  outcome: z.literal("skipped"),
});

/**
 * Why `SessionDO` refused or failed a message. `retryable` on the `error` message says whether
 * resending can help.
 */
export const SessionErrorCode = z.enum([
  /**
   * Not a JSON text frame, an unknown `t`, a schema failure, or a key outside `turn_end.key` and
   * `end.recap.key`.
   */
  "bad_message",
  /** Over `MAX_MESSAGE_BYTES`. */
  "too_large",
  /** A message that needs `start` came before it. */
  "not_started",
  /** A message that changes the session came after `end`. */
  "already_ended",
  /**
   * The session is sealed: `SessionDO` takes no more writes for it, ever. Not retryable; send
   * reviews and snoozes to the web route instead. `hello` and `ack` still work.
   */
  "sealed",
  /**
   * A correction's words hold no value of the field's kind ("I couldn't read a date in …"), so
   * nothing was written and the card stays as it was. Not retryable: say or type it again.
   */
  "unreadable",
  /** Too many messages a second on this socket. */
  "rate_limited",
  /** Too many turns in the session's window. */
  "turn_limit",
  /** The session's capture time ran out. */
  "duration_limit",
  /** The LLM provider refused the turn's key. */
  "llm_key_rejected",
  /** The LLM provider kept answering 429 until the turn's deadline. */
  "llm_rate_limited",
  /** The LLM provider failed or couldn't be reached. */
  "llm_unavailable",
  /** Anything else. The log has the cause; the client gets only this code. */
  "internal",
]);
export type SessionErrorCode = z.infer<typeof SessionErrorCode>;

function closeCode<C extends number, R extends string, X extends boolean>(
  code: C,
  reason: R,
  reconnect: X,
) {
  return Object.freeze({ code, reason, reconnect });
}

/**
 * How the server ends a session socket: close codes in the private range 4000–4099, each with a
 * fixed reason (at most 123 bytes of UTF-8; Workers' `close()` throws on longer ones). The edge
 * Worker and `SessionDO` close with these, and the client acts on the code, never the reason.
 * `reconnect` says which kind each one is.
 *
 * Reconnect, with backoff and a fresh ticket, after:
 * - `going_away` (4000): the server is shutting the socket, for a redeploy or eviction. The
 *   end-to-end test's forced network drop uses it too.
 * - `internal_error` (4001): something failed on the server.
 * - `rate_limited` (4002): too many messages on this socket. Back off before reconnecting.
 * - `ticket_refused` (4003): the ticket didn't verify: expired, malformed, signed with another
 *   secret, or for another session. A fresh ticket usually fixes it; stop if that one is refused too.
 * - `ticket_reused` (4004): the ticket's `jti` was already used. Every connection needs its own.
 *
 * Final, so don't reconnect:
 * - `replaced` (4005): a newer connection to the session took over. Reconnecting would fight it.
 * - `session_ended` (4006): the session has ended, or was deleted.
 * - `forbidden` (4007): the session belongs to another user or workspace.
 * - `unsupported_protocol` (4008): the server doesn't speak this client's protocol version. Reload.
 *
 * Any other code, such as 1001 or 1006, means the network or the runtime dropped the socket:
 * reconnect, as after `going_away`.
 */
export const SESSION_CLOSE_CODES = Object.freeze({
  going_away: closeCode(4000, "server going away", true),
  internal_error: closeCode(4001, "internal error", true),
  rate_limited: closeCode(4002, "too many messages", true),
  ticket_refused: closeCode(4003, "ticket refused", true),
  ticket_reused: closeCode(4004, "ticket already used", true),
  replaced: closeCode(4005, "replaced by a newer connection", false),
  session_ended: closeCode(4006, "session ended", false),
  forbidden: closeCode(4007, "session belongs to another user", false),
  unsupported_protocol: closeCode(4008, "protocol version unsupported", false),
});
export type SessionCloseName = keyof typeof SESSION_CLOSE_CODES;
export type SessionClose = (typeof SESSION_CLOSE_CODES)[SessionCloseName];
export type SessionCloseCode = SessionClose["code"];

const CLOSES_BY_CODE: ReadonlyMap<number, SessionClose & { readonly name: SessionCloseName }> =
  new Map(
    (Object.keys(SESSION_CLOSE_CODES) as SessionCloseName[]).map((name) => {
      const close = SESSION_CLOSE_CODES[name];
      return [close.code, Object.freeze({ name, ...close })];
    }),
  );

/** True if `code` is one of `SESSION_CLOSE_CODES`. */
export function isSessionCloseCode(code: number): code is SessionCloseCode {
  return CLOSES_BY_CODE.has(code);
}

/**
 * The session close a code stands for, with its name, or undefined for any other code. A client
 * reconnects unless this returns one with `reconnect: false`.
 */
export function sessionCloseFor(
  code: number,
): (SessionClose & { readonly name: SessionCloseName }) | undefined {
  return CLOSES_BY_CODE.get(code);
}

const Welcome = z.strictObject({
  t: z.literal("welcome"),
  sessionId: z.uuid(),
  /** The last seq `SessionDO` holds, or -1 before the first event. */
  lastSeq: LastSeq,
  protocol: z.literal(SESSION_PROTOCOL_VERSION),
});

const EventMessage = z.strictObject({
  t: z.literal("event"),
  /** Sent in seq order, on resume too. Validate the payload with `@earshot/events`' registry. */
  event: EventEnvelope,
});

const ServerAck = z.strictObject({
  t: z.literal("ack"),
  msgId: MsgId,
  /** The seq of the last event the message appended, if it appended any. Resends get the same. */
  seq: Seq.optional(),
});

const Working = z.strictObject({
  t: z.literal("working"),
  turnId: TurnId,
  state: z.enum(["thinking", "retrying"]),
  /** With `retrying`: how long until the next attempt. */
  retryInMs: z.int().nonnegative().optional(),
});

const ErrorMessage = z.strictObject({
  t: z.literal("error"),
  code: SessionErrorCode,
  retryable: z.boolean(),
  /** The client message this answers, when it parsed far enough to name one. */
  msgId: MsgId.optional(),
});

/** `params.reason` on the issue raised for a key-shaped string where no key belongs. */
const STRAY_KEY = "stray_key";

/**
 * Refuses anything shaped like a key, anywhere in `value`. For schemas that other writers parse
 * on their own, such as `ReviewInput` in the web route, so the guard goes wherever they do.
 */
export function refuseStrayKeys(value: object, ctx: z.RefinementCtx): void {
  const path = findStrayKey(value, undefined);
  if (path) {
    ctx.addIssue({
      code: "custom",
      path,
      message: "a key-shaped string can't be stored",
      params: { reason: STRAY_KEY },
    });
  }
}

/**
 * A message from the browser to `SessionDO`. Anything shaped like a provider key is refused
 * everywhere except `turn_end.key` and `end.recap.key` (Phase 5 WP10), and so is the message's
 * own key anywhere else in it, so a client bug can't put a key into a stored event.
 */
export const ClientMessage = z
  .discriminatedUnion("t", [
    Hello,
    Start,
    Utterance,
    TurnEnd,
    Usage,
    Witness,
    Metric,
    ClientAck,
    End,
    Review,
    Snooze,
    Correct,
    Followup,
  ])
  .superRefine((message, ctx) => {
    const path = findStrayKey(message, keySlotOf(message));
    if (path) {
      ctx.addIssue({
        code: "custom",
        path,
        message: "a key-shaped string is allowed only in turn_end.key and end.recap.key",
        params: { reason: STRAY_KEY },
      });
    }
  });
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ClientMessageOf<T extends ClientMessage["t"]> = Extract<ClientMessage, { t: T }>;

/** A message from `SessionDO` to the browser. It never carries anything shaped like a key. */
export const ServerMessage = z
  .discriminatedUnion("t", [Welcome, EventMessage, ServerAck, Working, ErrorMessage])
  .superRefine((message, ctx) => {
    const path = findStrayKey(message, undefined);
    if (path) {
      ctx.addIssue({
        code: "custom",
        path,
        message: "a server message can't carry a key-shaped string",
        params: { reason: STRAY_KEY },
      });
    }
  });
export type ServerMessage = z.infer<typeof ServerMessage>;
export type ServerMessageOf<T extends ServerMessage["t"]> = Extract<ServerMessage, { t: T }>;

/**
 * Why a frame didn't parse: not a text frame, over the size cap, not JSON, not a valid message,
 * or a valid message carrying a key where none belongs. Answer `too_large` with the error code
 * `too_large` and every other reason with `bad_message`. Log the reason and nothing else: Zod's
 * issues can quote property names from the input.
 */
export type MessageParseFailure = "not_text" | "too_large" | "not_json" | "invalid" | "stray_key";

export type MessageParseResult<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly reason: MessageParseFailure };

/**
 * Parses a frame from the browser, as `SessionDO`'s `webSocketMessage` receives it. The byte cap
 * applies before any JSON parsing, so an oversized frame costs a length check and no more.
 */
export function parseClientMessage(frame: unknown): MessageParseResult<ClientMessage> {
  if (typeof frame !== "string") return { ok: false, reason: "not_text" };
  if (exceedsUtf8Bytes(frame, MAX_MESSAGE_BYTES)) return { ok: false, reason: "too_large" };
  return parseFrame(frame, ClientMessage);
}

/**
 * Parses a frame from `SessionDO`. No size cap: the server is trusted, and an `event` frame runs
 * a little longer than the client message it echoes.
 */
export function parseServerMessage(frame: unknown): MessageParseResult<ServerMessage> {
  if (typeof frame !== "string") return { ok: false, reason: "not_text" };
  return parseFrame(frame, ServerMessage);
}

function parseFrame<T>(frame: string, schema: z.ZodType<T>): MessageParseResult<T> {
  let data: unknown;
  try {
    data = JSON.parse(frame);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, message: result.data };
  const stray = result.error.issues.some(
    (issue) => issue.code === "custom" && issue.params?.reason === STRAY_KEY,
  );
  return { ok: false, reason: stray ? "stray_key" : "invalid" };
}

/** A value met while walking a message, linked to its parent so a path costs nothing until used. */
interface Visit {
  readonly value: unknown;
  readonly parent?: Visit;
  readonly key?: PropertyKey;
}

/**
 * Where a message may carry a key, and the key itself: `turn_end.key`, or `end.recap.key`
 * (Phase 5 WP10). Nowhere else, ever.
 */
interface KeySlot {
  /** The property path from the message to the key: `["key"]` or `["recap", "key"]`. */
  readonly path: readonly string[];
  readonly key: string;
}

/** The message's own key slot, if it has one and the key is there. */
function keySlotOf(message: {
  readonly t: string;
  readonly key?: unknown;
  readonly recap?: { readonly key?: unknown } | undefined;
}): KeySlot | undefined {
  if (message.t === "turn_end" && typeof message.key === "string") {
    return { path: ["key"], key: message.key };
  }
  if (message.t === "end" && typeof message.recap?.key === "string") {
    return { path: ["recap", "key"], key: message.recap.key };
  }
  return undefined;
}

/** Whether `visit` sits exactly at `path` from the root: the key slot itself, nothing deeper. */
function isAt(visit: Visit, path: readonly string[]): boolean {
  let at: Visit | undefined = visit;
  for (let index = path.length - 1; index >= 0; index--) {
    if (at === undefined || at.key !== path[index]) return false;
    at = at.parent;
  }
  return at !== undefined && at.parent === undefined;
}

/**
 * The path to the first string that looks like a provider key, or that contains the message's own
 * key, anywhere in `message` except that key's slot itself (`turn_end.key` or `end.recap.key`). A
 * key-shaped property name reports the object holding it, so the path never quotes the key.
 * Iterative, so depth can't overflow.
 */
function findStrayKey(message: object, slot: KeySlot | undefined): PropertyKey[] | undefined {
  const own = slot?.key;
  const looksLikeKey = (text: string) =>
    containsKeyShape(text) || (own !== undefined && text.includes(own));
  const root: Visit = { value: message };
  const stack: Visit[] = [root];
  for (let visit = stack.pop(); visit; visit = stack.pop()) {
    const { value } = visit;
    if (typeof value === "string") {
      const isOwnKey = slot !== undefined && isAt(visit, slot.path);
      if (!isOwnKey && looksLikeKey(value)) return pathTo(visit);
    } else if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        stack.push({ value: value[index], parent: visit, key: index });
      }
    } else if (typeof value === "object" && value !== null) {
      for (const [name, child] of Object.entries(value)) {
        if (looksLikeKey(name)) return pathTo(visit);
        stack.push({ value: child, parent: visit, key: name });
      }
    }
  }
  return undefined;
}

function pathTo(visit: Visit): PropertyKey[] {
  const path: PropertyKey[] = [];
  for (let at: Visit | undefined = visit; at?.key !== undefined; at = at.parent) path.push(at.key);
  return path.reverse();
}

/** True if `text` takes more than `limit` bytes as UTF-8. Counts without allocating. */
function exceedsUtf8Bytes(text: string, limit: number): boolean {
  if (text.length > limit) return true; // every UTF-16 code unit takes at least one byte
  if (text.length * 3 <= limit) return false; // and at most three
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4; // a surrogate pair: one code point beyond the BMP
      i++;
    } else bytes += 3; // the rest of the BMP, and lone surrogates, which encode as U+FFFD
    if (bytes > limit) return true;
  }
  return false;
}
