// SessionDO's limits and timings (spec WP6 steps 6, 8, and 9). All are targets; the spec marks
// them so, and tests pin these values.

export const SESSION_LIMITS = Object.freeze({
  /** Messages a second on one socket, sustained. */
  messagesPerSecond: 20,
  /** Messages one socket may send at once (a reconnect's resends), before the rate applies. */
  messageBurst: 20,
  /** Turns per window. */
  turnsPerWindow: 30,
  /** The turn limit's window. */
  turnWindowMs: 10 * 60_000,
  /** How long after `start` the session accepts speech (`utterance`, `turn_end`). */
  captureMs: 30 * 60_000,
  /**
   * How far a second witness's utterance may run outside its turn's own words, the span of the
   * turn's biased utterances (Phase 4 spec §4.2). Past it, the witness is refused.
   */
  witnessWindowMs: 1_000,
});

/**
 * The seal (Phase 5 spec §4.3, targets): `SessionDO` keeps taking reviews, snoozes, usage, and
 * metrics after `end` until it writes `session.sealed`, its last event. That's `graceMs` after
 * `end`, or after the last write that followed it, whichever is later, and never later than
 * `maxAfterEndMs` after `end`.
 */
export const SEAL_TIMING = Object.freeze({
  graceMs: 60_000,
  maxAfterEndMs: 30 * 60_000,
});

/**
 * The recap (Phase 5 spec §4.10, WP10; target): written after `end` within this deadline, one retry
 * included, or recorded as failed with `timeout`. It runs in the session's serial queue, so the
 * seal, whose grace is a minute, comes after it, and never waits longer than this.
 */
export const RECAP_TIMING = Object.freeze({
  deadlineMs: 15_000,
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
  /** Delete the object's storage this long after Postgres confirms the whole log, seal included. */
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
  /** The socket went over the rate and is closing: nothing more from it is handled. */
  closed: boolean;
}

export function newBucket(now: number): RateBucket {
  return { tokens: SESSION_LIMITS.messageBurst, at: now, closed: false };
}

/**
 * Takes one message from the bucket: `ok`, or `close` for the first message past the rate.
 * Dropping one message and handling the next would break the log's order (an `utterance` lost
 * before the `turn_end` that runs its turn), so the socket closes instead. The client reconnects
 * after a backoff and resends everything unacknowledged, in order; it paces itself well under the
 * rate, so only a misbehaving client gets here.
 */
export function takeMessage(bucket: RateBucket, now: number): "ok" | "close" {
  const refilled = (Math.max(0, now - bucket.at) / 1000) * SESSION_LIMITS.messagesPerSecond;
  bucket.tokens = Math.min(SESSION_LIMITS.messageBurst, bucket.tokens + refilled);
  bucket.at = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return "ok";
  }
  bucket.closed = true;
  return "close";
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
