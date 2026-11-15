import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EventEnvelope } from "@earshot/core";
import type { EventDraft } from "../src";

/** The type, version, and payload of an event, before it gets an id, seq, and timestamp. */
export type EventBody = { type: string; schemaVersion: number; payload: Record<string, unknown> };

export function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
}

/** A valid UUIDv7-shaped id from a small number. */
export function uuid(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

export const SESSION_ID = uuid(0xa11ce);

/** One second per event, from 2026-11-10T19:15:00Z. */
export function tsFor(seq: number): string {
  return new Date(Date.UTC(2026, 10, 10, 19, 15, seq)).toISOString();
}

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

/** A draft for `append`, with id `uuid(n)`. */
export function draft(n: number, body: EventBody): EventDraft {
  return { id: uuid(n), ts: tsFor(n), ...body };
}

export function started(payload: Record<string, unknown> = {}): EventBody {
  return {
    type: "session.started",
    schemaVersion: 1,
    payload: {
      mode: "debrief",
      engine: "cascaded",
      providers: { speechToText: { provider: "deepgram", model: "nova-3" } },
      startedAt: "2026-11-10T19:15:00.000Z",
      ...payload,
    },
  };
}

export function utterance(n: number, text = `Utterance ${n}.`, witness = "biased"): EventBody {
  return {
    type: "utterance.final",
    schemaVersion: 2,
    payload: {
      utteranceId: uuid(2000 + n),
      text,
      confidence: 0.9,
      startMs: n * 1000,
      endMs: n * 1000 + 800,
      witness,
    },
  };
}

export function utteranceV1(n: number, text = `Utterance ${n}.`): EventBody {
  const { witness: _, ...payload } = utterance(n, text).payload;
  return { type: "utterance.final", schemaVersion: 1, payload };
}

export function proposal(n: number, type = "task", value: unknown = "Send the deck"): EventBody {
  return {
    type: "proposal.created",
    schemaVersion: 1,
    payload: {
      proposalId: uuid(3000 + n),
      type,
      targetEntityId: null,
      fields: {
        title: {
          value,
          evidence: {
            utteranceId: uuid(2001),
            span: [0, 4],
            audioMs: [1000, 1400],
            confidence: 0.9,
          },
        },
      },
      riskFlags: [],
    },
  };
}

export function review(
  n: number,
  decision: string,
  extra: Record<string, unknown> = {},
): EventBody {
  return {
    type: "proposal.reviewed",
    schemaVersion: 1,
    payload: { proposalId: uuid(3000 + n), decision, reviewerMs: 1500, ...extra },
  };
}

export function ended(payload: Record<string, unknown> = {}): EventBody {
  return {
    type: "session.ended",
    schemaVersion: 1,
    payload: { endedAt: "2026-11-10T19:15:40.000Z", costUsd: 0.004, ...payload },
  };
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
