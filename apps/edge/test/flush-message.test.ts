// Packing flush messages (spec WP6 step 8): at most 64 KB each, contiguous, and an event too big
// for any message sent as a range the consumer reads from the Durable Object.
import { uuidv7 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  FLUSH_MESSAGE_MAX_BYTES,
  FLUSH_MESSAGE_TARGET_BYTES,
  type FlushEvent,
  FlushMessage,
  jsonBytes,
  packFlushMessages,
  SEND_BATCH_MAX_BYTES,
  sendBatches,
} from "../src/flush-message";

const identity = { sessionId: uuidv7(), userId: "user-a", workspaceId: crypto.randomUUID() };

function event(seq: number, textBytes: number): FlushEvent {
  return {
    id: uuidv7(),
    seq,
    type: "utterance.final",
    schemaVersion: 2,
    ts: "2026-11-19T10:00:00.000Z",
    payload: { text: "x".repeat(textBytes) },
  };
}

describe("packFlushMessages", () => {
  it("fills messages up to the target, in order, with no seq left out", () => {
    const events = Array.from({ length: 50 }, (_, seq) => event(seq, 5_000));
    const messages = packFlushMessages(identity, events);
    expect(messages.length).toBeGreaterThan(3);
    let next = 0;
    for (const message of messages) {
      expect(FlushMessage.safeParse(message).success).toBe(true);
      expect(jsonBytes(message)).toBeLessThanOrEqual(FLUSH_MESSAGE_TARGET_BYTES);
      expect(message.fromSeq).toBe(next);
      next = message.toSeq + 1;
    }
    expect(next).toBe(50);
  });

  it("sends a big event alone, and one too big for any message as a range", () => {
    const messages = packFlushMessages(identity, [
      event(0, 100),
      event(1, 90_000),
      event(2, 200_000),
      event(3, 100),
    ]);
    expect(messages.map((m) => [m.fromSeq, m.toSeq, m.events?.length])).toEqual([
      [0, 0, 1],
      [1, 1, 1],
      [2, 2, undefined],
      [3, 3, 1],
    ]);
    expect(jsonBytes(messages[1])).toBeLessThanOrEqual(FLUSH_MESSAGE_MAX_BYTES);
  });

  it("refuses a message whose events don't match its range", () => {
    const [message] = packFlushMessages(identity, [event(0, 10), event(1, 10)]);
    expect(FlushMessage.safeParse({ ...message, toSeq: 2 }).success).toBe(false);
  });
});

describe("sendBatches", () => {
  it("keeps each sendBatch call within 100 messages and 256 KB", () => {
    const small = Array.from({ length: 250 }, (_, n) => ({ n }));
    expect(sendBatches(small).map((batch) => batch.length)).toEqual([100, 100, 50]);
    const big = Array.from({ length: 9 }, () => ({ text: "x".repeat(60_000) }));
    for (const batch of sendBatches(big)) {
      expect(batch.reduce((sum, item) => sum + jsonBytes(item), 0)).toBeLessThanOrEqual(
        SEND_BATCH_MAX_BYTES,
      );
    }
  });
});
