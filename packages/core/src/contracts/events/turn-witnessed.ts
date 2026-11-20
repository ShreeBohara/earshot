import { z } from "zod";
import { payloadMeta } from "./shared";

/** How a turn's second witness ended: compared with the biased transcript, failed, or skipped. */
export const WitnessOutcome = z.enum(["compared", "failed", "skipped"]);
export type WitnessOutcome = z.infer<typeof WitnessOutcome>;

/**
 * Why a turn has no unbiased transcript: the witness is off, there's no key for its provider, the
 * turn ran past the witness's cap, or the provider refused, failed, or timed out. The session
 * socket's `witness` message carries the same reasons.
 */
export const WitnessReason = z.enum([
  "off",
  "no_key",
  "too_long",
  "rate_limited",
  "provider_error",
  "timeout",
]);
export type WitnessReason = z.infer<typeof WitnessReason>;

export const TurnWitnessedV1 = z
  .strictObject({
    /** The turn, as the client named it in `turn_end`. */
    turnId: z.uuid(),
    outcome: WitnessOutcome,
    /** The unbiased witness's provider and model, such as `groq` and `whisper-large-v3-turbo`. */
    provider: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    /** The unbiased utterances compared. Empty unless `outcome` is `compared`. */
    utteranceIds: z.array(z.uuid()),
    /** The `proposal.flagged` events the comparison wrote for conflicts. */
    conflicts: z.int().nonnegative(),
    /** How long the witness took, by the client's clock, in ms. */
    latencyMs: z.int().nonnegative().nullable(),
    /** Why there was no comparison; null when `outcome` is `compared`. */
    reason: WitnessReason.nullable(),
  })
  .meta(
    payloadMeta(
      "turn.witnessed",
      1,
      "TurnWitnessedV1",
      "Payload of `turn.witnessed`, schema version 1: how one turn's second witness ended.",
    ),
  );
export type TurnWitnessedV1 = z.infer<typeof TurnWitnessedV1>;
