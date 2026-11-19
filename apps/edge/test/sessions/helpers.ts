// A small session client for the tests: tickets, the handshake, a socket that records every frame,
// message builders, and access to a session's SQLite.

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { DEMO_CALL_TIME, DEMO_ENTITIES, DEMO_TIME_ZONE } from "@earshot/agent/testing";
import {
  type ClientMessageOf,
  DEV_SESSION_TICKET_SECRET,
  type EventEnvelope,
  parseServerMessage,
  SESSION_SUBPROTOCOL,
  type ServerMessage,
  type ServerMessageOf,
  signTicket,
  ticketClaims,
  ticketSubprotocol,
  type UtteranceFinalV2,
  uuidv7,
} from "@earshot/core";
import type { FlushMessage } from "../../src/flush-message";
import { recordedFlushes, setTestSetting } from "./worker";

export const ORIGIN = "http://localhost:3000";
export const ANTHROPIC = { provider: "anthropic", model: "claude-haiku-5-5" } as const;
export const GROQ = { provider: "groq", model: "openai/gpt-oss-20b" } as const;

export interface SessionIds {
  readonly sid: string;
  readonly uid: string;
  readonly wid: string;
}

export function newSession(): SessionIds {
  return { sid: uuidv7(), uid: `user-${crypto.randomUUID()}`, wid: crypto.randomUUID() };
}

export function sessionStub(sid: string) {
  return env.SESSION.get(env.SESSION.idFromName(sid));
}

export async function ticketFor(
  ids: SessionIds,
  options: { now?: Date; ttlSeconds?: number; jti?: string; secret?: string } = {},
): Promise<string> {
  return signTicket(
    options.secret ?? DEV_SESSION_TICKET_SECRET,
    ticketClaims({
      sid: ids.sid,
      uid: ids.uid,
      wid: ids.wid,
      now: options.now ?? new Date(),
      ...(options.ttlSeconds ? { ttlSeconds: options.ttlSeconds } : {}),
      ...(options.jti ? { jti: options.jti } : {}),
    }),
  );
}

/** A canary key per test, shaped like an Anthropic key or like no known key at all. */
export function canaryKey(shape: "anthropic" | "plain" = "anthropic"): string {
  const random = crypto.randomUUID().replaceAll("-", "");
  return shape === "anthropic" ? `sk-ant-api03-canary${random}` : `canary${random}${random}`;
}

/** The client end of a session socket, recording every frame it receives. */
export class TestSocket {
  /** Every server message, in arrival order. */
  readonly received: ServerMessage[] = [];
  /** Every frame as text, `pong`s included. */
  readonly frames: string[] = [];
  /** Frames that weren't valid server messages (a key-shaped string would land here). */
  readonly invalid: string[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #ws: WebSocket;
  readonly #listeners = new Set<() => void>();

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.accept();
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (event) => {
        resolve({ code: event.code, reason: event.reason });
        for (const listener of this.#listeners) listener();
      });
    });
    ws.addEventListener("message", (event) => {
      const frame = typeof event.data === "string" ? event.data : "<binary>";
      this.frames.push(frame);
      if (frame !== "pong") {
        const parsed = parseServerMessage(frame);
        if (parsed.ok) this.received.push(parsed.message);
        else this.invalid.push(frame);
      }
      for (const listener of this.#listeners) listener();
    });
  }

  send(message: object): void {
    this.#ws.send(JSON.stringify(message));
  }

  sendRaw(frame: string | ArrayBuffer): void {
    this.#ws.send(frame);
  }

  close(code = 1000): void {
    try {
      this.#ws.close(code, "test closed it");
    } catch {
      // Already closed.
    }
  }

  /** The first message (old or new) that matches, within `timeoutMs`. */
  waitFor(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const check = () => {
        const found = this.received.find(predicate);
        if (!found) return;
        if (timer !== null) clearTimeout(timer);
        this.#listeners.delete(check);
        resolve(found);
      };
      timer = setTimeout(() => {
        this.#listeners.delete(check);
        reject(new Error(`timed out; received ${this.received.map((m) => m.t).join(", ")}`));
      }, timeoutMs);
      this.#listeners.add(check);
      check();
    });
  }

  /** Resolves once `count` messages match. */
  async waitForCount(
    predicate: (message: ServerMessage) => boolean,
    count: number,
    timeoutMs = 5_000,
  ) {
    await this.waitFor(() => this.received.filter(predicate).length >= count, timeoutMs);
    return this.received.filter(predicate);
  }

  ack(msgId: string, timeoutMs = 5_000): Promise<ServerMessageOf<"ack">> {
    return this.waitFor(
      (message) => message.t === "ack" && message.msgId === msgId,
      timeoutMs,
    ) as Promise<ServerMessageOf<"ack">>;
  }

  error(msgId?: string, timeoutMs = 5_000): Promise<ServerMessageOf<"error">> {
    return this.waitFor(
      (message) => message.t === "error" && (msgId === undefined || message.msgId === msgId),
      timeoutMs,
    ) as Promise<ServerMessageOf<"error">>;
  }

  /** Sends a message and waits for its ack. */
  async request(message: { msgId: string }, timeoutMs = 5_000): Promise<ServerMessageOf<"ack">> {
    this.send(message);
    return this.ack(message.msgId, timeoutMs);
  }

  /** Like `request`, at a pace the socket's rate limit (20 a second) allows for long runs. */
  async requestPaced(message: { msgId: string }): Promise<ServerMessageOf<"ack">> {
    await sleep(60);
    return this.request(message);
  }

  events(): EventEnvelope[] {
    return this.received.flatMap((message) => (message.t === "event" ? [message.event] : []));
  }

  /** The `event` messages received so far, of one type. */
  eventsOf(type: string): EventEnvelope[] {
    return this.events().filter((event) => event.type === type);
  }
}

export interface Handshake {
  readonly status: number;
  readonly protocol: string | null;
  readonly socket: TestSocket | undefined;
}

/** Opens a session socket through the edge route, as a browser would. */
export async function connect(
  sid: string,
  options: { ticket?: string; origin?: string | null; protocols?: string[]; path?: string } = {},
): Promise<Handshake> {
  const headers = new Headers({ Upgrade: "websocket" });
  if (options.origin !== null) headers.set("Origin", options.origin ?? ORIGIN);
  const protocols = options.protocols ?? [
    SESSION_SUBPROTOCOL,
    ...(options.ticket ? [ticketSubprotocol(options.ticket)] : []),
  ];
  if (protocols.length > 0) headers.set("Sec-WebSocket-Protocol", protocols.join(", "));
  const response = await exports.default.fetch(
    `https://edge.test${options.path ?? `/v1/sessions/${sid}/ws`}`,
    { headers },
  );
  return {
    status: response.status,
    protocol: response.headers.get("Sec-WebSocket-Protocol"),
    socket: response.webSocket ? new TestSocket(response.webSocket) : undefined,
  };
}

/** Connects with a fresh ticket and says hello; resolves after `welcome`. */
export async function open(ids: SessionIds = newSession(), lastSeq = -1) {
  const ticket = await ticketFor(ids);
  const { socket, status } = await connect(ids.sid, { ticket });
  if (!socket || status !== 101) throw new Error(`handshake failed with ${status}`);
  socket.send({ t: "hello", protocol: 1, lastSeq });
  const welcome = (await socket.waitFor((m) => m.t === "welcome")) as ServerMessageOf<"welcome">;
  return { ids, socket, welcome, stub: sessionStub(ids.sid) };
}

// ─── Messages ──────────────────────────────────────────────────────────────────────────────────

export function startMessage(
  overrides: Partial<ClientMessageOf<"start">> = {},
): ClientMessageOf<"start"> {
  return {
    t: "start",
    msgId: uuidv7(),
    mode: "debrief",
    engine: "cascaded",
    providers: {
      speechToText: { provider: "assemblyai", model: "universal-streaming-english" },
      llm: { ...ANTHROPIC },
    },
    startedAt: DEMO_CALL_TIME,
    entities: DEMO_ENTITIES.map((entity) => ({ ...entity, aliases: [...entity.aliases] })),
    timeZone: DEMO_TIME_ZONE,
    ...overrides,
  };
}

export function utteranceMessage(
  turnId: string,
  utterance: UtteranceFinalV2,
): ClientMessageOf<"utterance"> {
  return { t: "utterance", msgId: uuidv7(), turnId, utterance };
}

/** An utterance with made-up text, for tests that don't run extraction on it. */
export function utteranceOf(text: string, startMs = 0): UtteranceFinalV2 {
  return {
    utteranceId: uuidv7(),
    text,
    confidence: 0.9,
    startMs,
    endMs: startMs + 1_000,
    witness: "biased",
  };
}

export function turnEndMessage(
  turnId: string,
  key: string,
  llm: { provider: "anthropic" | "groq"; model: string } = ANTHROPIC,
): ClientMessageOf<"turn_end"> {
  return { t: "turn_end", msgId: uuidv7(), turnId, trigger: "ptt_release", llm, key };
}

export function usageMessage(
  provider: string,
  model: string,
  audioMs: number,
  socketMs: number,
): ClientMessageOf<"usage"> {
  return { t: "usage", msgId: uuidv7(), provider, model, audioMs, socketMs };
}

export function metricMessage(turnId: string): ClientMessageOf<"metric"> {
  return {
    t: "metric",
    msgId: uuidv7(),
    turnId,
    marks: {
      mode: "push_to_talk",
      speechEndMs: 1_000,
      finalMs: 1_620.4,
      proposalMs: 2_900,
      paintMs: 3_010,
    },
  };
}

export function endMessage(): ClientMessageOf<"end"> {
  return { t: "end", msgId: uuidv7(), endedAt: "2026-11-10T19:16:00.000Z" };
}

// ─── The session's SQLite ──────────────────────────────────────────────────────────────────────

type Stub = ReturnType<typeof sessionStub>;

/** Runs `fn` against the session's SQLite, inside its Durable Object. */
export function withSql<T>(stub: Stub, fn: (sql: SqlStorage, state: DurableObjectState) => T) {
  return runInDurableObject(stub, (_instance, state) => fn(state.storage.sql, state));
}

export function meta(stub: Stub): Promise<Record<string, string>> {
  return withSql(stub, (sql) => {
    const exists = sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .toArray().length;
    if (!exists) return {};
    return Object.fromEntries(
      sql
        .exec<{ k: string; v: string }>("SELECT k, v FROM meta")
        .toArray()
        .map((r) => [r.k, String(r.v)]),
    );
  });
}

/**
 * Writes settings straight into `meta`, then evicts the object (its sockets hibernate and stay
 * open), so the next instance reads them: SessionDO keeps `meta` in memory.
 */
export async function setMeta(stub: Stub, values: Record<string, string | number>): Promise<void> {
  await withSql(stub, (sql) => {
    for (const [k, v] of Object.entries(values)) {
      sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, String(v));
    }
  });
  await evictDurableObject(stub, { webSockets: "hibernate" });
}

/** Schedules the object's alarm, to run it with `runDurableObjectAlarm`. */
export async function armAlarm(stub: Stub): Promise<void> {
  await withSql(stub, async (_sql, state) => {
    await state.storage.setAlarm(Date.now() + 60_000);
  });
}

/** Every table the session holds, every row, as JSON: what the leak tests scan. */
export function dumpStorage(stub: Stub): Promise<string> {
  return withSql(stub, (sql) => {
    const tables = sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray();
    const dump: Record<string, unknown> = {};
    for (const { name } of tables) {
      try {
        dump[name] = sql.exec(`SELECT * FROM "${name}"`).toArray();
      } catch {
        dump[name] = "<unreadable>";
      }
    }
    return JSON.stringify(dump);
  });
}

export function tableNames(stub: Stub): Promise<string[]> {
  return withSql(stub, (sql) =>
    sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
      .toArray()
      .map((row) => row.name),
  );
}

export function flushes(stub: Stub): Promise<FlushMessage[]> {
  return withSql(stub, (sql) => recordedFlushes(sql));
}

/** Picks the cassette the session's next turns replay (see worker.ts). */
export function useCassette(stub: Stub, name: string | null): Promise<void> {
  return withSql(stub, (sql) => setTestSetting(sql, "cassette", name));
}

export function failSink(stub: Stub, failing: boolean): Promise<void> {
  return withSql(stub, (sql) => setTestSetting(sql, "sink", failing ? "fail" : null));
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
