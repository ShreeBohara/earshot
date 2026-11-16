import { z } from "zod";
import { payloadMeta } from "./shared";

/**
 * How a turn's extraction ended: with proposals; with nothing worth proposing; with model output
 * that failed validation even after a retry; refused by the provider's rate limit; failed at the
 * provider (a rejected key, a 5xx, a timeout); or cancelled before it finished.
 */
export const TurnOutcome = z.enum([
  "proposals",
  "nothing_to_propose",
  "invalid_output",
  "rate_limited",
  "provider_error",
  "cancelled",
]);
export type TurnOutcome = z.infer<typeof TurnOutcome>;

export const TurnCompletedV1 = z
  .strictObject({
    /** The turn, as the client named it in `turn_end`. */
    turnId: z.uuid(),
    /** The utterances the extraction read, in order. Empty when the turn had no speech. */
    utteranceIds: z.array(z.uuid()),
    outcome: TurnOutcome,
    /** The `proposal.created` events the turn wrote, in order. Empty unless `outcome` is `proposals`. */
    proposalIds: z.array(z.uuid()),
    /** LLM calls made for the turn, retries included. 0 when nothing was sent. */
    attempts: z.int().nonnegative(),
    /** Time spent waiting on the LLM, in ms, summed over every attempt. */
    llmMs: z.int().nonnegative(),
  })
  .meta(
    payloadMeta(
      "turn.completed",
      1,
      "TurnCompletedV1",
      "Payload of `turn.completed`, schema version 1: how one turn's extraction ended.",
    ),
  );
export type TurnCompletedV1 = z.infer<typeof TurnCompletedV1>;
