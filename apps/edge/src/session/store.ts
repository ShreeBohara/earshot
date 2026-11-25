// SessionDO's SQLite: the event log, written before anything leaves the object (spec WP6 step 3).
//
//   meta         one row per setting: who the session belongs to, its lifecycle, flush progress,
//                the cost meter, and limits
//   events       the log: contiguous seq from 0, UUIDv7 ids, the DO clock's ts
//   client_msgs  every client message that was handled, so a resend gets the same answer
//   tickets      every ticket `jti` that opened a socket, so a ticket opens one socket
//   utterances   which turn each utterance belongs to (`utterance.final` doesn't say), and a
//                guard against the same utterance being final twice
//   turns        each completed turn: the seq of its `turn.completed`, what its proposals' linker
//                read (so the second witness is compared in the same context, Phase 4 WP9, even
//                after the object hibernates), and the witness message that settled it
//   writes       every review and snooze by its client-made id (`reviewId`, `snoozeId`), with its
//                seq and proposal, so the same review sent again under a new msgId gets the first
//                one's seq (Phase 5 WP3)
//
// All methods are synchronous: SQLite-backed Durable Object storage runs queries synchronously,
// and `transactionSync` makes a message's writes atomic.
import { defaultRegistry, type EventEnvelope, parseEnvelope } from "@earshot/events";
import type { FlushEvent } from "../flush-message";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL, schema_version INTEGER NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL)`,
  "CREATE TABLE IF NOT EXISTS client_msgs (msg_id TEXT PRIMARY KEY, seq INTEGER, done_at TEXT NOT NULL, error TEXT)",
  "CREATE TABLE IF NOT EXISTS tickets (jti TEXT PRIMARY KEY, used_at TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS utterances (utterance_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL,
    seq INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS utterances_turn_seq ON utterances (turn_id, seq)",
  `CREATE TABLE IF NOT EXISTS turns (turn_id TEXT PRIMARY KEY, completed_seq INTEGER NOT NULL,
    links TEXT NOT NULL, witness_msg TEXT)`,
  `CREATE TABLE IF NOT EXISTS writes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, seq INTEGER NOT NULL,
    proposal_id TEXT NOT NULL)`,
];

/** Every setting `meta` holds. Values are strings; numbers are stored in decimal. */
export type MetaKey =
  // Pinned on the first connection, from its verified ticket.
  | "sid"
  | "uid"
  | "wid"
  // `start`: the seq of `session.started`, when it arrived by the DO's clock, and its settings,
  // the account open in Earshot (`focusEntityId`) among them.
  | "started_seq"
  | "capture_started_ms"
  | "call_time"
  | "time_zone"
  | "entities"
  | "focus_entity_id"
  // The approval policy `start` carried, once its signature verified (Phase 5 WP11): its id,
  // version, and rules (JSON), never the signature. Absent: no policy, every proposal waits.
  | "policy"
  // The records turns linked from words that were said, most recent first, at most 20 (JSON): the
  // linker's `recent` context (Phase 4 spec, WP8 step 4).
  | "link_recent"
  // `end` (or an idle session ended by the DO): the seq of `session.ended`, and when.
  | "ended_seq"
  | "ended_ms"
  // The seal (Phase 5 WP3): when it's due (a grace after `end`, restarted by each write that
  // follows, capped), and the seq of `session.sealed` once written, after which nothing is.
  | "seal_due_ms"
  | "sealed_seq"
  // The recap (Phase 5 WP10): set with `session.ended`, since every ended session owes one
  // `recap.created`; cleared when it's written, with its seq. Never the key: that stays in memory.
  | "recap_due"
  | "recap_seq"
  // The flush: the last seq handed to the Queue, the last seq Postgres confirmed, and when the
  // oldest event not yet handed over was written.
  | "enqueued_seq"
  | "flushed_seq"
  | "unflushed_since_ms"
  // Cleanup after the end: re-sends of unconfirmed events, and the final deletion.
  | "resend_count"
  | "resend_due_ms"
  | "cleanup_due_ms"
  // The cost meter's totals (JSON), and recent turn starts for the turn limit (JSON).
  | "meter"
  | "turn_starts"
  // Set by `purge()`: the object refuses everything until the tombstone itself is deleted.
  | "purged_ms";

/** An event as `append` takes it: SessionDO numbers it, mints its id, and stamps its time. */
export interface NewEvent {
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: Record<string, unknown>;
}

/** A completed turn, as `turns` holds it. */
export interface CompletedTurn {
  /** The seq of its `turn.completed`. */
  readonly completedSeq: number;
  /** What its proposals' linker read, as JSON: `@earshot/agent`'s `ProposalLink[]`. */
  readonly links: string;
  /** The `witness` message that settled the turn, once one has. */
  readonly witnessMsg: string | null;
}

/** A review or a snooze already in the log, by its client-made id. */
export interface RecordedWrite {
  readonly kind: "review" | "snooze";
  readonly seq: number;
  readonly proposalId: string;
}

/** A handled client message: the seq of the last event it appended, and the error it got. */
export interface DoneMessage {
  readonly seq: number | null;
  readonly error: { readonly code: string; readonly retryable: boolean } | null;
}

type EventRow = {
  seq: number;
  id: string;
  type: string;
  schema_version: number;
  ts: string;
  payload: string;
};

export class SessionStore {
  readonly #storage: DurableObjectStorage;
  readonly #meta = new Map<MetaKey, string>();
  #lastSeq = -1;
  #lastEventMs: number | null = null;
  #hasTables = false;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  get #sql(): SqlStorage {
    return this.#storage.sql;
  }

  /**
   * Loads `meta` and the log's end into memory. Creates nothing: the tables appear with the first
   * write, so an object that was never used, or whose storage was deleted, holds no data at all.
   */
  open(): void {
    this.#meta.clear();
    this.#lastSeq = -1;
    this.#lastEventMs = null;
    this.#hasTables =
      this.#sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'")
        .toArray().length > 0;
    if (!this.#hasTables) return;
    for (const statement of SCHEMA) this.#sql.exec(statement); // tables added since, if any
    for (const row of this.#sql.exec<{ k: string; v: string }>("SELECT k, v FROM meta")) {
      this.#meta.set(row.k as MetaKey, String(row.v));
    }
    const last = this.#sql
      .exec<{ seq: number; ts: string }>("SELECT seq, ts FROM events ORDER BY seq DESC LIMIT 1")
      .toArray()[0];
    this.#lastSeq = last?.seq ?? -1;
    this.#lastEventMs = last ? Date.parse(last.ts) : null;
  }

  /**
   * Runs `fn` in one SQLite transaction; if it throws, nothing it wrote is kept. Every write goes
   * through here, so this is where the tables are created.
   */
  transaction<T>(fn: () => T): T {
    const meta = new Map(this.#meta);
    const lastSeq = this.#lastSeq;
    const lastEventMs = this.#lastEventMs;
    const hadTables = this.#hasTables;
    try {
      return this.#storage.transactionSync(() => {
        if (!this.#hasTables) {
          for (const statement of SCHEMA) this.#sql.exec(statement);
          this.#hasTables = true;
        }
        return fn();
      });
    } catch (error) {
      // The rollback undid the rows; undo the in-memory copies too.
      this.#meta.clear();
      for (const [key, value] of meta) this.#meta.set(key, value);
      this.#lastSeq = lastSeq;
      this.#lastEventMs = lastEventMs;
      this.#hasTables = hadTables;
      throw error;
    }
  }

  /** The seq of the last event, or -1 before the first. */
  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** When the last event was written, by the DO's clock, or null before the first. */
  get lastEventMs(): number | null {
    return this.#lastEventMs;
  }

  get(key: MetaKey): string | undefined {
    return this.#meta.get(key);
  }

  /** A numeric setting, or `fallback` when it's unset. */
  getNumber(key: MetaKey, fallback: number): number;
  getNumber(key: MetaKey): number | undefined;
  getNumber(key: MetaKey, fallback?: number): number | undefined {
    const value = this.#meta.get(key);
    return value === undefined ? fallback : Number(value);
  }

  set(key: MetaKey, value: string | number): void {
    const text = String(value);
    if (this.#meta.get(key) === text) return;
    this.#sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
      key,
      text,
    );
    this.#meta.set(key, text);
  }

  delete(key: MetaKey): void {
    if (!this.#meta.has(key)) return;
    this.#sql.exec("DELETE FROM meta WHERE k = ?", key);
    this.#meta.delete(key);
  }

  /**
   * Appends events after the last seq, with UUIDv7 ids and the DO clock's time, and returns their
   * envelopes. Each is checked against `@earshot/events`' registry first, as Postgres will check
   * it, so the log can't hold an event the flush would refuse. Call inside `transaction`.
   */
  append(
    sessionId: string,
    events: readonly NewEvent[],
    clock: { readonly now: number; readonly newId: () => string },
  ): EventEnvelope[] {
    const ts = new Date(clock.now).toISOString();
    const appended: EventEnvelope[] = [];
    for (const event of events) {
      const envelope = parseEnvelope({
        id: clock.newId(),
        sessionId,
        seq: this.#lastSeq + 1,
        type: event.type,
        schemaVersion: event.schemaVersion,
        ts,
        payload: event.payload,
      });
      defaultRegistry.validate(envelope);
      this.#sql.exec(
        "INSERT INTO events (seq, id, type, schema_version, ts, payload) VALUES (?, ?, ?, ?, ?, ?)",
        envelope.seq,
        envelope.id,
        envelope.type,
        envelope.schemaVersion,
        envelope.ts,
        JSON.stringify(envelope.payload),
      );
      this.#lastSeq = envelope.seq;
      this.#lastEventMs = clock.now;
      appended.push(envelope);
    }
    return appended;
  }

  /** Events with `from <= seq <= to`, in seq order, as envelopes. */
  *events(sessionId: string, from: number, to = this.#lastSeq): Generator<EventEnvelope> {
    if (!this.#hasTables) return;
    for (const row of this.#sql.exec<EventRow>(
      "SELECT seq, id, type, schema_version, ts, payload FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq",
      from,
      to,
    )) {
      yield {
        id: row.id,
        sessionId,
        seq: row.seq,
        type: row.type,
        schemaVersion: row.schema_version,
        ts: row.ts,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      };
    }
  }

  /** Events with `from <= seq <= to` as the flush sends them: drafts numbered by SessionDO. */
  flushEvents(from: number, to = this.#lastSeq, limit = Number.POSITIVE_INFINITY): FlushEvent[] {
    const events: FlushEvent[] = [];
    if (!this.#hasTables) return events;
    for (const row of this.#sql.exec<EventRow>(
      "SELECT seq, id, type, schema_version, ts, payload FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq",
      from,
      to,
    )) {
      if (events.length >= limit) break;
      events.push({
        id: row.id,
        seq: row.seq,
        type: row.type,
        schemaVersion: row.schema_version,
        ts: row.ts,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      });
    }
    return events;
  }

  /** How a client message was answered, if it was handled before. */
  done(msgId: string): DoneMessage | undefined {
    if (!this.#hasTables) return undefined;
    const row = this.#sql
      .exec<{ seq: number | null; error: string | null }>(
        "SELECT seq, error FROM client_msgs WHERE msg_id = ?",
        msgId,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      seq: row.seq,
      error: row.error ? (JSON.parse(row.error) as DoneMessage["error"]) : null,
    };
  }

  /** Records a client message as handled. Call in the transaction that wrote its events. */
  markDone(msgId: string, answer: DoneMessage, now: number): void {
    this.#sql.exec(
      "INSERT INTO client_msgs (msg_id, seq, done_at, error) VALUES (?, ?, ?, ?)",
      msgId,
      answer.seq,
      new Date(now).toISOString(),
      answer.error ? JSON.stringify(answer.error) : null,
    );
  }

  /** Records a ticket's `jti` as used. False if it was used before. */
  useTicket(jti: string, now: number): boolean {
    const used = this.#sql.exec("SELECT 1 FROM tickets WHERE jti = ?", jti).toArray().length > 0;
    if (used) return false;
    this.#sql.exec(
      "INSERT INTO tickets (jti, used_at) VALUES (?, ?)",
      jti,
      new Date(now).toISOString(),
    );
    return true;
  }

  /** The seq of the `utterance.final` that carried this utterance, if one did. */
  utteranceSeq(utteranceId: string): number | undefined {
    if (!this.#hasTables) return undefined;
    return this.#sql
      .exec<{ seq: number }>("SELECT seq FROM utterances WHERE utterance_id = ?", utteranceId)
      .toArray()[0]?.seq;
  }

  /** Files an utterance under its turn. Call in the transaction that appended it. */
  addUtterance(utteranceId: string, turnId: string, seq: number): void {
    this.#sql.exec(
      "INSERT INTO utterances (utterance_id, turn_id, seq) VALUES (?, ?, ?)",
      utteranceId,
      turnId,
      seq,
    );
  }

  /** The payloads of a turn's utterances, in seq order. */
  turnUtterances(turnId: string): Record<string, unknown>[] {
    if (!this.#hasTables) return [];
    return this.#sql
      .exec<{ payload: string }>(
        `SELECT events.payload AS payload FROM utterances JOIN events ON events.seq = utterances.seq
         WHERE utterances.turn_id = ? ORDER BY utterances.seq`,
        turnId,
      )
      .toArray()
      .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
  }

  /**
   * Records a completed turn and what its linking read. Call in the transaction that appended its
   * `turn.completed`. A turn id seen before keeps its first record.
   */
  addTurn(turnId: string, completedSeq: number, links: string): void {
    this.#sql.exec(
      "INSERT INTO turns (turn_id, completed_seq, links) VALUES (?, ?, ?) ON CONFLICT (turn_id) DO NOTHING",
      turnId,
      completedSeq,
      links,
    );
  }

  /** A completed turn, if one by that id was recorded. */
  turn(turnId: string): CompletedTurn | undefined {
    if (!this.#hasTables) return undefined;
    const row = this.#sql
      .exec<{ completed_seq: number; links: string; witness_msg: string | null }>(
        "SELECT completed_seq, links, witness_msg FROM turns WHERE turn_id = ?",
        turnId,
      )
      .toArray()[0];
    if (!row) return undefined;
    return { completedSeq: row.completed_seq, links: row.links, witnessMsg: row.witness_msg };
  }

  /** Records the witness that settled a turn. Call in the transaction that appended its events. */
  markWitnessed(turnId: string, msgId: string): void {
    this.#sql.exec("UPDATE turns SET witness_msg = ? WHERE turn_id = ?", msgId, turnId);
  }

  /** A review or snooze by its `reviewId` or `snoozeId`, if the log holds one. */
  recordedWrite(id: string): RecordedWrite | undefined {
    if (!this.#hasTables) return undefined;
    const row = this.#sql
      .exec<{ kind: string; seq: number; proposal_id: string }>(
        "SELECT kind, seq, proposal_id FROM writes WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      kind: row.kind === "snooze" ? "snooze" : "review",
      seq: row.seq,
      proposalId: row.proposal_id,
    };
  }

  /** Records a review or snooze's id. Call in the transaction that appended its event. */
  addWrite(id: string, write: RecordedWrite): void {
    this.#sql.exec(
      "INSERT INTO writes (id, kind, seq, proposal_id) VALUES (?, ?, ?, ?)",
      id,
      write.kind,
      write.seq,
      write.proposalId,
    );
  }

  /** Forgets the in-memory copies, after `deleteAll()` removed the tables under them. */
  forget(): void {
    this.#meta.clear();
    this.#lastSeq = -1;
    this.#lastEventMs = null;
    this.#hasTables = false;
  }
}
