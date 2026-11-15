import type { z } from "zod";

/** The parts of an event that error messages cite. */
type EventRef = { type: string; schemaVersion: number; seq: number };

/** `utterance.final v1 at seq 3`. */
export function describeEvent(event: EventRef): string {
  return `${event.type} v${event.schemaVersion} at seq ${event.seq}`;
}

/**
 * `append` was given an `expectedLastSeq` that doesn't match the session's log, so nothing was
 * written. `stale`: the log already has later events (another writer got there first). `gap`: the
 * writer is ahead of the log, so appending would leave a hole in the sequence.
 */
export class ConcurrencyError extends Error {
  override readonly name = "ConcurrencyError";
  readonly sessionId: string;
  readonly expectedLastSeq: number;
  readonly actualLastSeq: number;
  readonly reason: "stale" | "gap";

  constructor(
    sessionId: string,
    expectedLastSeq: number,
    actualLastSeq: number,
    reason: "stale" | "gap",
    detail?: string,
  ) {
    const actual =
      actualLastSeq < 0 ? "the session has no events" : `its log ends at seq ${actualLastSeq}`;
    super(
      detail ??
        `session ${sessionId}: expected the last seq to be ${expectedLastSeq}, but ${actual} (${reason})`,
    );
    this.sessionId = sessionId;
    this.expectedLastSeq = expectedLastSeq;
    this.actualLastSeq = actualLastSeq;
    this.reason = reason;
  }
}

/** An event's envelope or payload doesn't match its schema. `issues` are Zod's. */
export class EventValidationError extends Error {
  override readonly name = "EventValidationError";
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(subject: string, issues: readonly z.core.$ZodIssue[]) {
    super(`${subject}: ${formatIssues(issues)}`);
    this.issues = issues;
  }
}

/** The registry has no schema for this event's type, or for this version of it. */
export class UnknownEventError extends Error {
  override readonly name = "UnknownEventError";
  readonly type: string;
  readonly schemaVersion: number;

  constructor(event: EventRef, detail: string) {
    super(`${describeEvent(event)}: ${detail}`);
    this.type = event.type;
    this.schemaVersion = event.schemaVersion;
  }
}

/** An upcaster chain is broken: a version has no upcaster, or an upcaster returned the wrong event. */
export class UpcastError extends Error {
  override readonly name = "UpcastError";
}

/** The events aren't one session's log: they mix sessions, skip or repeat a seq, or repeat an id. */
export class StreamError extends Error {
  override readonly name = "StreamError";
}

/** An event makes no sense in a projection's current state, such as a review of an unknown proposal. */
export class ProjectionError extends Error {
  override readonly name = "ProjectionError";
  readonly projection: string;
  readonly seq: number;

  constructor(projection: string, event: EventRef, detail: string) {
    super(`${projection} projection, ${describeEvent(event)}: ${detail}`);
    this.projection = projection;
    this.seq = event.seq;
  }
}

/** A JSONL line isn't valid JSON or isn't a valid event. `line` is 1-based; `cause` has the details. */
export class JsonlError extends Error {
  override readonly name = "JsonlError";
  readonly line: number;

  constructor(line: number, detail: string, options?: ErrorOptions) {
    super(`line ${line}: ${detail}`, options);
    this.line = line;
  }
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}
