import type { EventEnvelope } from "@earshot/core";
import { type EventBody, SESSION_ID, tsFor, uuid } from "../src/testing";

// The event builders live in src/testing.ts, exported as @earshot/events/testing, so other
// packages' store tests can use them too.
export {
  draft,
  type EventBody,
  ended,
  proposal,
  readFixture,
  review,
  SESSION_ID,
  started,
  tsFor,
  utterance,
  utteranceV1,
  uuid,
} from "../src/testing";

/** Builds a valid log for one session: ids, seqs, and timestamps filled in. */
export function sessionLog(bodies: readonly EventBody[], sessionId = SESSION_ID): EventEnvelope[] {
  return bodies.map((body, seq) => ({
    id: uuid(1000 + seq),
    sessionId,
    seq,
    type: body.type,
    schemaVersion: body.schemaVersion,
    ts: tsFor(seq),
    payload: body.payload,
  }));
}

/** One envelope, at seq 0. */
export function envelope(body: EventBody): EventEnvelope {
  const [event] = sessionLog([body]);
  if (!event) throw new Error("unreachable");
  return event;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Runs `fn` and returns what it threw. */
export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
