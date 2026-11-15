import { z } from "zod";

/**
 * The envelope around every session event. Phase 2's event store appends these;
 * replaying them in `seq` order rebuilds a session exactly.
 */
export const EventEnvelope = z
  .strictObject({
    /** UUIDv7, so ids sort by creation time. */
    id: z.uuid(),
    sessionId: z.uuid(),
    /** Per-session sequence number, starting at 0. */
    seq: z.int().nonnegative(),
    /** Dotted, lowercase event type, for example `utterance.final`. */
    type: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/),
    /** Version of the payload schema for this `type`, used by upcasters. */
    schemaVersion: z.int().positive(),
    /** ISO 8601 timestamp. Offsets are accepted; writers normalize to UTC. */
    ts: z.iso.datetime({ offset: true }),
    payload: z.record(z.string(), z.unknown()),
  })
  .meta({ title: "EventEnvelope", description: "Envelope for one session event." });

export type EventEnvelope = z.infer<typeof EventEnvelope>;
