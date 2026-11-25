import { z } from "zod";

/** A score from 0 to 1, as reported by the speech-to-text provider or the model. */
export const Confidence = z.number().min(0).max(1);

/** Milliseconds from the start of the session's audio. */
export const AudioMs = z.int().nonnegative();

/** ISO 8601 timestamp. Offsets are accepted, as in `EventEnvelope.ts`; writers normalize to UTC. */
export const Timestamp = z.iso.datetime({ offset: true });

/** Field names in proposals and edit diffs are camelCase, for example `dueDate`. */
export const FieldName = z.string().regex(/^[a-z][A-Za-z0-9]*$/);

/** A field value: a JSON scalar. `null` means "no value". */
export const FieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type FieldValue = z.infer<typeof FieldValue>;

/** The longest IANA time zone name Earshot takes; real names are under 40 characters. */
export const MAX_TIME_ZONE_CHARS = 64;

/**
 * The shape of an IANA time zone name, such as `America/Chicago` or `UTC`: parts of letters,
 * digits, `_`, `+`, and `-`, split by slashes, starting with a letter.
 */
export const TIME_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/**
 * Whether `value` names a time zone this runtime knows: the shape first, then `Intl`, which
 * Workers, browsers, and Node all ship with full time zone data.
 */
export function isIanaTimeZone(value: string): boolean {
  if (!TIME_ZONE_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * A time zone's name as an event stores it: its shape and length, and nothing that depends on the
 * runtime. A writer checks a zone with `isIanaTimeZone` when it arrives (as the session protocol
 * checks `start.timeZone`); a stored event must load wherever it's read, whatever time zone data
 * that runtime ships, so the contract doesn't ask `Intl` again.
 */
export const TimeZoneName = z.string().max(MAX_TIME_ZONE_CHARS).regex(TIME_ZONE_SHAPE);

/** A SHA-256 digest in lowercase hex: 64 characters. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The most attempts one sync job makes (Phase 6 spec §4.1, target): its first, then each Retry,
 * which starts the next attempt under the same idempotency key.
 */
export const MAX_SYNC_ATTEMPTS = 20;

/**
 * JSON Schema metadata for an event payload. Besides the title and description, it records the
 * event type and schema version the payload belongs to, so the exported schema is self-describing.
 */
export function payloadMeta(
  type: string,
  schemaVersion: number,
  title: string,
  description: string,
) {
  return { title, description, "x-event-type": type, "x-schema-version": schemaVersion };
}
