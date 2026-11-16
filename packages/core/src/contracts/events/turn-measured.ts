import { z } from "zod";
import { payloadMeta } from "./shared";

/** How the rep ended the turn's speech: by releasing push-to-talk, or hands-free. */
export const CaptureMode = z.enum(["push_to_talk", "hands_free"]);
export type CaptureMode = z.infer<typeof CaptureMode>;

const Ms = z.int().nonnegative();

/**
 * The latency gate's record of one turn (spec §4.5). `SessionDO` derives all four numbers from
 * the client's `metric` message, so they share one clock, the client's.
 */
export const TurnMeasuredV1 = z
  .strictObject({
    turnId: z.uuid(),
    mode: CaptureMode,
    /** End of speech (the release, in push-to-talk) to the turn's last final transcript. */
    speechEndToFinalMs: Ms,
    /** That final to the first proposal arriving at the client. */
    finalToProposalMs: Ms,
    /** The proposal arriving to its card being painted. */
    proposalToPaintMs: Ms,
    /** End of speech to the card being painted: the number the gate's p95 is taken over. */
    totalMs: Ms,
  })
  .meta(
    payloadMeta(
      "turn.measured",
      1,
      "TurnMeasuredV1",
      "Payload of `turn.measured`, schema version 1: one turn's latency, by stage, on the client's clock.",
    ),
  );
export type TurnMeasuredV1 = z.infer<typeof TurnMeasuredV1>;
