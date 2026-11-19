import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  initialRetry,
  nextRetryDelay,
  RETRY_EVENTS,
  RETRY_STATES,
  type Retry,
  type RetryEvent,
  type RetryEventType,
  type RetryState,
  retryTransition,
} from "../src/machines/retry";

const eventOf = (type: RetryEventType): RetryEvent => {
  switch (type) {
    case "start":
      return { type, at: 0 };
    case "failure":
      return { type, at: 100, random: 0.5, retryable: true };
    default:
      return { type };
  }
};

const at = (state: RetryState): Retry => ({
  state,
  context: {
    attempts: state === "idle" ? 0 : 1,
    startedAt: state === "idle" ? null : 0,
    reason: state === "failed" ? "cancelled" : null,
  },
});

// Every (state, event) pair. The type makes a new state or event without a decision a compile
// error, and the loop makes a wrong decision a test failure.
const TABLE: Record<RetryState, Record<RetryEventType, RetryState>> = {
  idle: {
    start: "attempting",
    success: "idle",
    failure: "idle",
    retry_due: "idle",
    deadline: "idle",
    cancel: "failed",
  },
  attempting: {
    start: "attempting",
    success: "succeeded",
    failure: "waiting",
    retry_due: "attempting",
    deadline: "failed",
    cancel: "failed",
  },
  waiting: {
    start: "waiting",
    success: "waiting",
    failure: "waiting",
    retry_due: "attempting",
    deadline: "failed",
    cancel: "failed",
  },
  succeeded: {
    start: "succeeded",
    success: "succeeded",
    failure: "succeeded",
    retry_due: "succeeded",
    deadline: "succeeded",
    cancel: "succeeded",
  },
  failed: {
    start: "failed",
    success: "failed",
    failure: "failed",
    retry_due: "failed",
    deadline: "failed",
    cancel: "failed",
  },
};

/** Runs events in order, returning the final machine and every effect, flattened to strings. */
function run(events: RetryEvent[], from: Retry = initialRetry, policy = DEFAULT_RETRY_POLICY) {
  let retry = from;
  const effects: string[] = [];
  for (const event of events) {
    const step = retryTransition(retry, event, policy);
    retry = step.retry;
    for (const effect of step.effects) {
      if ("delayMs" in effect) effects.push(`${effect.type}:${effect.delayMs}`);
      else if ("attempt" in effect) effects.push(`${effect.type}:${effect.attempt}`);
      else if ("reason" in effect) effects.push(`${effect.type}:${effect.reason}`);
      else effects.push(effect.type);
    }
  }
  return { retry, effects };
}

const failure = (at: number, extra: Partial<Extract<RetryEvent, { type: "failure" }>> = {}) =>
  ({ type: "failure", at, random: 0, retryable: true, ...extra }) as const;

describe("the retry machine", () => {
  it("decides every (state, event) pair", () => {
    let pairs = 0;
    for (const state of RETRY_STATES) {
      for (const type of RETRY_EVENTS) {
        const next = retryTransition(at(state), eventOf(type)).retry.state;
        expect(`${state} + ${type} → ${next}`).toBe(`${state} + ${type} → ${TABLE[state][type]}`);
        pairs += 1;
      }
    }
    expect(pairs).toBe(RETRY_STATES.length * RETRY_EVENTS.length);
  });

  it("makes one attempt under a deadline, and settles on success", () => {
    const { retry, effects } = run([{ type: "start", at: 0 }, { type: "success" }]);
    expect(effects).toEqual(["start_deadline:8000", "attempt:1", "cancel_deadline"]);
    expect(retry).toEqual({
      state: "succeeded",
      context: { attempts: 1, startedAt: 0, reason: null },
    });
  });

  it("waits as long as Retry-After says, then tries again", () => {
    const { retry, effects } = run([
      { type: "start", at: 0 },
      failure(40, { retryAfterMs: 1_000 }),
      { type: "retry_due" },
      { type: "success" },
    ]);
    expect(effects).toEqual([
      "start_deadline:8000",
      "attempt:1",
      "schedule_retry:1000",
      "attempt:2",
      "cancel_deadline",
    ]);
    expect(retry.state).toBe("succeeded");
  });

  it("backs off with equal jitter, and gives up after the third attempt", () => {
    const { retry, effects } = run([
      { type: "start", at: 0 },
      failure(10, { random: 0 }),
      { type: "retry_due" },
      failure(200, { random: 1 - Number.EPSILON }),
      { type: "retry_due" },
      failure(800),
    ]);
    expect(effects).toEqual([
      "start_deadline:8000",
      "attempt:1",
      "schedule_retry:125",
      "attempt:2",
      "schedule_retry:500",
      "attempt:3",
      "cancel_deadline",
      "give_up:attempts_exhausted",
    ]);
    expect(retry).toMatchObject({ state: "failed", context: { reason: "attempts_exhausted" } });
  });

  it("stops at once for a failure that can't be retried", () => {
    const { effects } = run([{ type: "start", at: 0 }, failure(5, { retryable: false })]);
    expect(effects.slice(-2)).toEqual(["cancel_deadline", "give_up:not_retryable"]);
  });

  it("doesn't wait past the deadline: a long Retry-After means stop now", () => {
    const { retry, effects } = run([
      { type: "start", at: 0 },
      failure(500, { retryAfterMs: 7_500 }),
    ]);
    expect(effects.slice(-1)).toEqual(["give_up:deadline"]);
    expect(retry.context.reason).toBe("deadline");
  });

  it("aborts the attempt in flight when the deadline passes", () => {
    const { effects } = run([{ type: "start", at: 0 }, { type: "deadline" }]);
    expect(effects.slice(-2)).toEqual(["abort_attempt", "give_up:deadline"]);
  });

  it("cancels cleanly from each live state", () => {
    expect(run([{ type: "start", at: 0 }, { type: "cancel" }]).effects.slice(-3)).toEqual([
      "cancel_deadline",
      "abort_attempt",
      "give_up:cancelled",
    ]);
    expect(
      run([{ type: "start", at: 0 }, failure(1), { type: "cancel" }]).effects.slice(-3),
    ).toEqual(["cancel_retry", "cancel_deadline", "give_up:cancelled"]);
  });

  it("ignores everything once settled", () => {
    const done = run([{ type: "start", at: 0 }, { type: "success" }]).retry;
    for (const type of RETRY_EVENTS) {
      expect(retryTransition(done, eventOf(type)).effects).toEqual([]);
    }
  });
});

// The same vectors as @earshot/agent's own copy (packages/agent/test/retry-and-errors.test.ts),
// so swapping that copy for this one changes no decision.
describe("nextRetryDelay, as @earshot/agent decides it", () => {
  const rateLimited = { retryable: true, retryAfterMs: 1000 };
  const unavailable = { retryable: true };
  const policy = DEFAULT_RETRY_POLICY;

  it("has the spec's targets", () => {
    expect(policy).toEqual({
      maxAttempts: 3,
      deadlineMs: 8_000,
      baseDelayMs: 250,
      maxDelayMs: 2_000,
    });
  });

  it("honors Retry-After as given", () => {
    expect(
      nextRetryDelay(policy, { attempt: 1, failure: rateLimited, elapsedMs: 0, random: 0.9 }),
    ).toBe(1000);
  });

  it("backs off exponentially with equal jitter when there's no Retry-After", () => {
    const delay = (attempt: number, random: number) =>
      nextRetryDelay(policy, { attempt, failure: unavailable, elapsedMs: 0, random });
    expect([delay(1, 0), delay(1, 1 - Number.EPSILON)]).toEqual([125, 250]);
    expect([delay(2, 0), delay(2, 0.5)]).toEqual([250, 375]);
    const patient = { ...policy, maxAttempts: 10 };
    expect(
      nextRetryDelay(patient, { attempt: 9, failure: unavailable, elapsedMs: 0, random: 0.999 }),
    ).toBe(1_999);
  });

  it("stops after the third attempt, for failures that can't be retried, and at the deadline", () => {
    expect(
      nextRetryDelay(policy, { attempt: 3, failure: rateLimited, elapsedMs: 0, random: 0 }),
    ).toBeNull();
    expect(
      nextRetryDelay(policy, {
        attempt: 1,
        failure: { retryable: false },
        elapsedMs: 0,
        random: 0,
      }),
    ).toBeNull();
    expect(
      nextRetryDelay(policy, { attempt: 1, failure: rateLimited, elapsedMs: 7_000, random: 0 }),
    ).toBeNull();
    expect(
      nextRetryDelay(policy, { attempt: 1, failure: rateLimited, elapsedMs: 6_999, random: 0 }),
    ).toBe(1000);
  });
});
