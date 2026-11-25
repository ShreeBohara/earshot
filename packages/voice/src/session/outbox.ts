// The outbox: client messages waiting for SessionDO's ack, in the order they were made. Each
// carries a UUIDv7 msgId, so resending one is harmless; SessionClient resends everything still
// unacknowledged after every reconnect.
//
// In memory only, by design. A `turn_end` key, and from Phase 5 the recap's key on `end`
// (`end.recap.key`, WP10), must never be written anywhere, IndexedDB included, so the outbox keeps
// keys apart from the messages it shows (`items()`), splices a key back in only while serializing
// a frame for the socket, and forgets it the moment the message is acknowledged, refused, or the
// outbox is cleared.
import type { ClientMessage, ClientMessageOf, RecapRequest } from "@earshot/core";

/** Client messages that change the session, each with a msgId. `hello` and `ack` aren't kept. */
export type OutboxMessage = Exclude<ClientMessage, { t: "hello" } | { t: "ack" }>;

/** `end` as the outbox shows it: its recap, if any, without the key. */
export type OutboxEnd = Omit<ClientMessageOf<"end">, "recap"> & {
  readonly recap?: Omit<RecapRequest, "key">;
};

/** A message as the outbox shows it: a `turn_end` without its key, an `end` without its recap's. */
export type OutboxItem = OutboxMessage extends infer M
  ? M extends { t: "turn_end" }
    ? Omit<M, "key">
    : M extends { t: "end" }
      ? OutboxEnd
      : M
  : never;

interface Entry {
  readonly item: OutboxItem;
  /** Sent on the current socket and not yet answered. */
  sent: boolean;
}

export class Outbox {
  readonly #entries = new Map<string, Entry>(); // insertion order is send order
  readonly #keys = new Map<string, string>();

  get size(): number {
    return this.#entries.size;
  }

  has(msgId: string): boolean {
    return this.#entries.has(msgId);
  }

  /** Adds a message at the back. */
  add(message: OutboxMessage): void {
    if (this.#entries.has(message.msgId)) throw new Error("a msgId is used once");
    if (message.t === "turn_end") {
      const { key, ...item } = message;
      this.#keys.set(message.msgId, key);
      this.#entries.set(message.msgId, { item, sent: false });
    } else if (message.t === "end" && message.recap) {
      const { key, ...recap } = message.recap;
      this.#keys.set(message.msgId, key);
      this.#entries.set(message.msgId, { item: { ...message, recap }, sent: false });
    } else {
      this.#entries.set(message.msgId, { item: message as OutboxItem, sent: false });
    }
  }

  /** Removes a message, acknowledged or refused, with its key. */
  remove(msgId: string): OutboxItem | undefined {
    const entry = this.#entries.get(msgId);
    this.#entries.delete(msgId);
    this.#keys.delete(msgId);
    return entry?.item;
  }

  /** Messages not yet sent on the current socket, in order. */
  unsent(): string[] {
    return [...this.#entries].filter(([, entry]) => !entry.sent).map(([msgId]) => msgId);
  }

  markSent(msgId: string): void {
    const entry = this.#entries.get(msgId);
    if (entry) entry.sent = true;
  }

  /** Marks messages to send again: all of them (a new socket), or the given ones. */
  markUnsent(msgIds?: Iterable<string>): void {
    for (const msgId of msgIds ?? this.#entries.keys()) {
      const entry = this.#entries.get(msgId);
      if (entry) entry.sent = false;
    }
  }

  /** Messages sent on the current socket and still unanswered. */
  inFlight(): string[] {
    return [...this.#entries].filter(([, entry]) => entry.sent).map(([msgId]) => msgId);
  }

  /** The frame for one message, key included: for the socket, and nothing else. */
  frame(msgId: string): string {
    const entry = this.#entries.get(msgId);
    if (!entry) throw new Error("no such message in the outbox");
    const key = this.#keys.get(msgId);
    if (key === undefined) return JSON.stringify(entry.item);
    const { item } = entry;
    // The recap's key goes back inside its recap; a turn's, at the top of `turn_end`.
    if (item.t === "end" && item.recap) {
      return JSON.stringify({ ...item, recap: { ...item.recap, key } });
    }
    return JSON.stringify({ ...item, key });
  }

  /** The messages waiting, in order, never with a key. */
  items(): OutboxItem[] {
    return [...this.#entries.values()].map((entry) => entry.item);
  }

  /** Drops everything, keys included: the session is over, or this client is. */
  clear(): void {
    this.#entries.clear();
    this.#keys.clear();
  }

  /** Keys still held, for tests: zero once every turn and `end` is acknowledged. */
  get heldKeys(): number {
    return this.#keys.size;
  }
}
