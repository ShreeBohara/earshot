import { z } from "zod";
import { Evidence, MAX_TARGET_CANDIDATES, RiskFlagV2, TargetCandidate } from "./proposal-created";
import { AudioMs, FieldName, payloadMeta } from "./shared";

/** Who flagged a proposal after it appeared. Phase 4 has one source: the second witness. */
export const FlagSource = z.enum(["witness"]);
export type FlagSource = z.infer<typeof FlagSource>;

/**
 * Where the two witnesses heard different things (Phase 4 spec §4.6): the biased reading, which
 * the proposal quotes, and the unbiased witness's words over the same stretch of audio.
 */
export const WitnessConflict = z
  .strictObject({
    /** `target` for the target's mention, or the field it's about, such as a contact's `name`. */
    field: FieldName,
    /** The quoted words of the biased transcript, and where they were said. */
    biased: z.strictObject({ text: z.string().min(1), evidence: Evidence }),
    /** The unbiased witness's words over the same audio, when it had any. */
    unbiased: z
      .strictObject({
        text: z.string().min(1),
        utteranceId: z.uuid(),
        audioMs: z.tuple([AudioMs, AudioMs]),
      })
      .nullable(),
  })
  .meta({ title: "WitnessConflict" });
export type WitnessConflict = z.infer<typeof WitnessConflict>;

/**
 * A witness downgrade: the target becomes a question. The candidates merge both readings' top
 * choices, at most three records plus "new", and list the record the target named before, which
 * `proposalsProjection` keeps first.
 */
export const TargetDowngrade = z
  .strictObject({
    decision: z.literal("ask"),
    candidates: z.array(TargetCandidate).min(1).max(MAX_TARGET_CANDIDATES),
  })
  .meta({ title: "TargetDowngrade" });
export type TargetDowngrade = z.infer<typeof TargetDowngrade>;

export const ProposalFlaggedV1 = z
  .strictObject({
    /** The proposal the flags are for. */
    proposalId: z.uuid(),
    source: FlagSource,
    /** Flags to add to the proposal's own; `witness_conflict` for a conflict. */
    flags: z.array(RiskFlagV2).min(1),
    /** A downgrade of the proposal's target to "ask", or null when the target stands. */
    target: TargetDowngrade.nullable(),
    /** What the witnesses disagreed on, or null. */
    conflict: WitnessConflict.nullable(),
  })
  .meta(
    payloadMeta(
      "proposal.flagged",
      1,
      "ProposalFlaggedV1",
      "Payload of `proposal.flagged`, schema version 1: flags added to a proposal after it appeared, such as a conflict between the two witnesses, and any downgrade of its target.",
    ),
  );
export type ProposalFlaggedV1 = z.infer<typeof ProposalFlaggedV1>;
