// The Queue message SessionDO sends and the consumer reads (spec WP7 step 2): a contiguous range of
// one session's events, as SessionDO numbered them, and who the session belongs to.
//
//   { v: 1, sessionId, userId, workspaceId, fromSeq, toSeq, events }
//
// `events` holds exactly the events `fromSeq..toSeq`. It's left out only when one event is too
// big for a Queue message; the consumer then reads the range from SessionDO (`readRange`). No
// message ever carries a key or a ticket: events hold transcripts and proposals, and the ids say
// whose they are, so the consumer can run as that user under row-level security.
import { z } from "zod";

export const FLUSH_MESSAGE_VERSION = 1;

/**
 * Pack events into messages of at most this many bytes of JSON (spec WP6 step 8): Queues bills
 * one operation per 64 KB written, read, and deleted, and a KB is 1,000 bytes there. About 100
 * bytes of the 64 KB go to the Queue's own metadata.
 */
export const FLUSH_MESSAGE_TARGET_BYTES = 63_900;
/** An event bigger than the target travels alone, up to this size (Queues' limit is 128 KB). */
export const FLUSH_MESSAGE_MAX_BYTES = 127_900;
/** `sendBatch` takes at most 100 messages and 256 KB per call. */
export const SEND_BATCH_MAX_MESSAGES = 100;
export const SEND_BATCH_MAX_BYTES = 255_000;

/** One stored event: an `EventDraft` for `appendEvents`, numbered by SessionDO. */
export const FlushEvent = z.strictObject({
  id: z.string(),
  seq: z.int().nonnegative(),
  type: z.string(),
  schemaVersion: z.int().positive(),
  ts: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type FlushEvent = z.infer<typeof FlushEvent>;

/**
 * Reads the JSON `readRange` returns: SessionDO sends a range as one JSON string, because RPC
 * results must have serializable types, and a payload's `unknown` isn't one. Throws on anything
 * that isn't an array of events.
 */
export function parseRange(json: string): FlushEvent[] {
  return z.array(FlushEvent).parse(JSON.parse(json));
}

/** Whose session a message belongs to: the ids SessionDO pinned from the first verified ticket. */
export interface SessionIdentity {
  readonly sessionId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export const FlushMessage = z
  .strictObject({
    v: z.literal(FLUSH_MESSAGE_VERSION),
    sessionId: z.uuid(),
    userId: z.string().min(1).max(128),
    workspaceId: z.uuid(),
    fromSeq: z.int().nonnegative(),
    toSeq: z.int().nonnegative(),
    events: z.array(FlushEvent).min(1).optional(),
  })
  .refine((message) => message.toSeq >= message.fromSeq, {
    path: ["toSeq"],
    message: "toSeq comes before fromSeq",
  })
  .refine(
    (message) =>
      message.events === undefined ||
      (message.events.length === message.toSeq - message.fromSeq + 1 &&
        message.events.every((event, index) => event.seq === message.fromSeq + index)),
    { path: ["events"], message: "events must be exactly fromSeq..toSeq, in order" },
  );
export type FlushMessage = z.infer<typeof FlushMessage>;

const utf8 = new TextEncoder();

/** How many bytes `value` takes as JSON. */
export function jsonBytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).byteLength;
}

/**
 * Packs contiguous events into as few messages as fit `FLUSH_MESSAGE_TARGET_BYTES`, in seq order.
 * An event that doesn't fit the target alone gets a message of its own, and one too big for any
 * message gets a message with no `events`, which the consumer fills from SessionDO.
 */
export function packFlushMessages(
  identity: SessionIdentity,
  events: readonly FlushEvent[],
): FlushMessage[] {
  const messages: FlushMessage[] = [];
  // The envelope without events, with room for two 10-digit seqs.
  const overhead =
    jsonBytes({ v: FLUSH_MESSAGE_VERSION, ...identity, fromSeq: 0, toSeq: 0, events: [] }) + 20;
  let batch: FlushEvent[] = [];
  let bytes = overhead;

  const close = () => {
    const first = batch[0];
    const last = batch.at(-1);
    if (first && last) {
      messages.push({
        v: FLUSH_MESSAGE_VERSION,
        ...identity,
        fromSeq: first.seq,
        toSeq: last.seq,
        events: batch,
      });
    }
    batch = [];
    bytes = overhead;
  };

  for (const event of events) {
    const size = jsonBytes(event) + 1; // and its comma
    if (overhead + size > FLUSH_MESSAGE_TARGET_BYTES) {
      close();
      if (overhead + size <= FLUSH_MESSAGE_MAX_BYTES) {
        batch = [event];
        close();
      } else {
        messages.push({
          v: FLUSH_MESSAGE_VERSION,
          ...identity,
          fromSeq: event.seq,
          toSeq: event.seq,
        });
      }
      continue;
    }
    if (bytes + size > FLUSH_MESSAGE_TARGET_BYTES) close();
    batch.push(event);
    bytes += size;
  }
  close();
  return messages;
}

/** Where SessionDO sends its flush messages: the Queue in production, a recorder in tests. */
export interface FlushSink {
  send(messages: readonly FlushMessage[]): Promise<void>;
}

/**
 * Splits messages into `sendBatch` calls within its limits (100 messages, 256 KB), in order.
 * Sizes are JSON sizes: messages go to the Queue as JSON.
 */
export function sendBatches<M>(messages: readonly M[]): M[][] {
  const batches: M[][] = [];
  let chunk: M[] = [];
  let bytes = 0;
  for (const message of messages) {
    const size = jsonBytes(message);
    if (
      chunk.length > 0 &&
      (chunk.length >= SEND_BATCH_MAX_MESSAGES || bytes + size > SEND_BATCH_MAX_BYTES)
    ) {
      batches.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(message);
    bytes += size;
  }
  if (chunk.length > 0) batches.push(chunk);
  return batches;
}
