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
