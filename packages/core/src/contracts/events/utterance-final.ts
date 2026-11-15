import { z } from "zod";
import { AudioMs, Confidence, payloadMeta } from "./shared";

/** One recognized word with its timing, as speech-to-text providers report it. */
export const Word = z
  .strictObject({
    w: z.string().min(1),
    startMs: AudioMs,
    endMs: AudioMs,
    confidence: Confidence,
  })
  .meta({ title: "Word" });
export type Word = z.infer<typeof Word>;

/**
 * Which transcript an utterance comes from (plan §7.1). The biased witness is the speech-to-text
 * stream boosted with CRM keyterms; the unbiased witness is an independent transcript used to catch
 * names the biasing pulled toward the wrong record.
 */
export const Witness = z.enum(["biased", "unbiased"]);
export type Witness = z.infer<typeof Witness>;

const utteranceFinalV1Shape = {
  /** UUIDv7. Proposal evidence points at utterances by this id. */
  utteranceId: z.uuid(),
  text: z.string().min(1),
  confidence: Confidence,
  /** Word timings, when the provider returns them. */
  words: z.array(Word).optional(),
  startMs: AudioMs,
  endMs: AudioMs,
};

export const UtteranceFinalV1 = z
  .strictObject(utteranceFinalV1Shape)
  .meta(
    payloadMeta(
      "utterance.final",
      1,
      "UtteranceFinalV1",
      "Payload of `utterance.final`, schema version 1: one final transcript segment.",
    ),
  );
export type UtteranceFinalV1 = z.infer<typeof UtteranceFinalV1>;

export const UtteranceFinalV2 = z
  .strictObject({ ...utteranceFinalV1Shape, witness: Witness })
  .meta(
    payloadMeta(
      "utterance.final",
      2,
      "UtteranceFinalV2",
      "Payload of `utterance.final`, schema version 2: adds which witness produced the segment.",
    ),
  );
export type UtteranceFinalV2 = z.infer<typeof UtteranceFinalV2>;
