import type { EventEnvelope } from "@earshot/core";
import { EventValidationError, JsonlError, UnknownEventError } from "./errors";
import { defaultRegistry, type EventRegistry, parseEnvelope } from "./registry";

export interface FromJsonlOptions {
  registry?: EventRegistry;
  /**
   * Accept events whose type the registry doesn't know, checking only their envelope, so a file
   * from a newer writer still imports. Off by default.
   */
  allowUnknownTypes?: boolean;
}

/**
 * Writes events as JSONL: one JSON object per line, each line ending in `\n`. Lines are canonical:
 * envelope fields in a fixed order and payload keys sorted, so the same events give the same bytes
 * wherever they were read from (Postgres `jsonb`, for one, doesn't keep key order). Events are
 * written at their stored schema version; nothing is upcast.
 */
export function toJsonl(events: readonly EventEnvelope[]): string {
  return events
    .map((event) => {
      const { id, sessionId, seq, type, schemaVersion, ts, payload } = parseEnvelope(event);
      const line = { id, sessionId, seq, type, schemaVersion, ts, payload: sortKeys(payload) };
      return `${JSON.stringify(line)}\n`;
    })
    .join("");
}

/**
 * Reads JSONL written by `toJsonl` (or by hand). Each line is checked against `EventEnvelope` and
 * against the payload schema for its type and version; the first bad line throws a `JsonlError`
 * that cites its 1-based line number. Blank lines are skipped. Events come back exactly as stored,
 * at their own schema version, so `toJsonl(fromJsonl(text))` reproduces a canonical file byte for byte.
 */
export function fromJsonl(text: string, options: FromJsonlOptions = {}): EventEnvelope[] {
  const registry = options.registry ?? defaultRegistry;
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  const events: EventEnvelope[] = [];
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new JsonlError(line, `not valid JSON (${(error as Error).message})`, { cause: error });
    }
    try {
      const event = parseEnvelope(value);
      const known = registry.latestVersion(event.type) !== undefined;
      if (known || !options.allowUnknownTypes) registry.validate(event);
      events.push(event);
    } catch (error) {
      if (error instanceof EventValidationError || error instanceof UnknownEventError) {
        throw new JsonlError(line, error.message, { cause: error });
      }
      throw error;
    }
  });
  return events;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}
