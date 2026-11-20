// The session socket protocol (Phase 3 spec §4.2): JSON text frames between the browser's
// SessionClient and SessionDO, behind the edge Worker's ticket check (session-ticket.ts).
//
// These schemas aren't exported to JSON Schema or Pydantic: only TypeScript speaks the protocol,
// and its key-shape check has no JSON Schema form, so an export would accept messages Zod refuses.
import { z } from "zod";
import { containsKeyShape } from "../key-shapes";
import { EntityRef } from "./entity-ref";
import { EventEnvelope } from "./event-envelope";
import { SessionProviders } from "./events/session-started";
import { Timestamp } from "./events/shared";
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

/** The longest IANA time zone name `start` accepts; real names are under 40 characters. */
export const MAX_TIME_ZONE_CHARS = 64;

/**
 * Whether `value` names a time zone this runtime knows. Uses `Intl`, which Workers, browsers, and
 * Node all ship with full time zone data.
 */
export function isIanaTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
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
const SocketUtterance = UtteranceFinalV2.extend({
  text: UtteranceFinalV2.shape.text.max(MAX_UTTERANCE_TEXT_CHARS),
});

/**
 * `utterance.final` v2 from the unbiased witness, capped like the biased stream's. Only the
 * `witness` message carries one.
 */
const UnbiasedSocketUtterance = SocketUtterance.extend({ witness: z.literal("unbiased") });

const EntityName = z.string().min(1).max(MAX_ENTITY_NAME_CHARS);
const EntityId = z.string().min(1).max(MAX_ENTITY_ID_CHARS);

/** `EntityRef`, with its lengths capped for the socket. */
const SocketEntityRef = EntityRef.extend({
  id: EntityId,
  name: EntityName,
  aliases: z.array(EntityName).max(MAX_ENTITY_ALIASES),
  parentId: EntityId.optional(),
});

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

const End = z.strictObject({
  t: z.literal("end"),
  msgId: MsgId,
  /** When capture stopped, by the client's clock; `session.ended` keeps it. */
  endedAt: Timestamp,
});

/**
 * Why `SessionDO` refused or failed a message. `retryable` on the `error` message says whether
 * resending can help.
 */
export const SessionErrorCode = z.enum([
  /** Not a JSON text frame, an unknown `t`, a schema failure, or a key outside `turn_end.key`. */
  "bad_message",
  /** Over `MAX_MESSAGE_BYTES`. */
  "too_large",
  /** A message that needs `start` came before it. */
  "not_started",
  /** A message that changes the session came after `end`. */
  "already_ended",
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
 * A message from the browser to `SessionDO`. Anything shaped like a provider key is refused
 * everywhere except `turn_end.key`, and so is that turn's key itself, so a client bug can't put
 * a key into a stored event.
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
  ])
  .superRefine((message, ctx) => {
    const turnKey = message.t === "turn_end" ? message.key : undefined;
    const path = findStrayKey(message, turnKey);
    if (path) {
      ctx.addIssue({
        code: "custom",
        path,
        message: "a key-shaped string is allowed only in turn_end.key",
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
 * The path to the first string that looks like a provider key, or that contains `turnKey`,
 * anywhere in `message` except `turn_end.key` itself. A key-shaped property name reports the
 * object holding it, so the path never quotes the key. Iterative, so depth can't overflow.
 */
function findStrayKey(message: object, turnKey: string | undefined): PropertyKey[] | undefined {
  const looksLikeKey = (text: string) =>
    containsKeyShape(text) || (turnKey !== undefined && text.includes(turnKey));
  const root: Visit = { value: message };
  const stack: Visit[] = [root];
  for (let visit = stack.pop(); visit; visit = stack.pop()) {
    const { value } = visit;
    if (typeof value === "string") {
      const isTurnKey = turnKey !== undefined && visit.parent === root && visit.key === "key";
      if (!isTurnKey && looksLikeKey(value)) return pathTo(visit);
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
