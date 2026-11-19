// SessionDO's limits and timings (spec WP6 steps 6, 8, and 9). All are targets; the spec marks
// them so, and tests pin these values.

export const SESSION_LIMITS = Object.freeze({
  /** Messages a second on one socket, sustained. */
  messagesPerSecond: 20,
  /** Messages one socket may send at once (a reconnect's resends), before the rate applies. */
  messageBurst: 20,
  /** Refused messages, net of what the rate drains, before the socket closes with `rate_limited`. */
  refusalsBeforeClose: 100,
  /** Turns per window. */
  turnsPerWindow: 30,
  /** The turn limit's window. */
  turnWindowMs: 10 * 60_000,
  /** How long after `start` the session accepts speech (`utterance`, `turn_end`). */
  captureMs: 30 * 60_000,
});

export const FLUSH_TIMING = Object.freeze({
  /** Flush once this many events are waiting... */
  maxPendingEvents: 20,
  /** ...or once the oldest has waited this long. */
  maxPendingMs: 30_000,
  /** After the end, re-send whatever Postgres hasn't confirmed: at +1 h and +6 h, then daily. */
  resendAfterEndMs: [60 * 60_000, 6 * 60 * 60_000] as readonly number[],
  resendEveryMs: 24 * 60 * 60_000,
  /** A re-send that failed to reach the Queue is tried again after this long. */
  resendRetryMs: 5 * 60_000,
  /** Delete the object's storage this long after Postgres confirms the whole log, end included. */
  cleanupAfterConfirmMs: 24 * 60 * 60_000,
  /**
   * End a session nobody ended: this long after both the capture limit and its last event. A
   * client that vanishes without `end` (a closed tab) would otherwise keep its transcript in
   * Durable Object storage forever.
   */
  idleEndMs: 30 * 60_000,
  /** How long a purged object refuses connections before its tombstone is deleted too. */
  tombstoneMs: 5 * 60_000,
});

/** A token bucket for one socket's messages. In memory: hibernation resets it, harmlessly. */
export interface RateBucket {
  tokens: number;
  at: number;
  refusals: number;
}

export function newBucket(now: number): RateBucket {
  return { tokens: SESSION_LIMITS.messageBurst, at: now, refusals: 0 };
}

/**
 * Takes one message from the bucket: `ok`, `refuse` (answer `rate_limited` and drop it), or
 * `close` once a client keeps going regardless. Refusals drain at the same rate tokens refill, so
 * one burst (a reconnect's resends) only costs refusals, while a client that stays well over the
 * rate piles them up until it's closed.
 */
export function takeMessage(bucket: RateBucket, now: number): "ok" | "refuse" | "close" {
  const drained = (Math.max(0, now - bucket.at) / 1000) * SESSION_LIMITS.messagesPerSecond;
  bucket.tokens = Math.min(SESSION_LIMITS.messageBurst, bucket.tokens + drained);
  bucket.refusals = Math.max(0, bucket.refusals - drained);
  bucket.at = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return "ok";
  }
  bucket.refusals += 1;
  return bucket.refusals > SESSION_LIMITS.refusalsBeforeClose ? "close" : "refuse";
}

/** The turn starts still inside the window, oldest first, from `meta.turn_starts`. */
export function recentTurnStarts(stored: string | undefined, now: number): number[] {
  if (!stored) return [];
  let starts: unknown;
  try {
    starts = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(starts)) return [];
  return starts.filter(
    (start): start is number =>
      typeof start === "number" && now - start < SESSION_LIMITS.turnWindowMs,
  );
}

/** When the n-th re-send after the end is due, counting from 0. */
export function resendDueMs(endedMs: number, count: number): number {
  const fixed = FLUSH_TIMING.resendAfterEndMs;
  const last = fixed.at(-1) ?? 0;
  if (count < fixed.length) return endedMs + (fixed[count] ?? last);
  return endedMs + last + (count - fixed.length + 1) * FLUSH_TIMING.resendEveryMs;
}
