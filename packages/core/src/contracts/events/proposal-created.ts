import { z } from "zod";
import { AudioMs, Confidence, FieldName, FieldValue, payloadMeta } from "./shared";

/** The CRM change a proposal suggests. The agent's write tools only ever create proposals. */
export const ProposalType = z.enum(["note", "task", "contact", "deal_update", "commitment"]);
export type ProposalType = z.infer<typeof ProposalType>;

/**
 * Where a proposed value came from (plan §4, "The understanding pipeline"): the utterance, the
 * `[start, end)` character span in its text, the `[start, end]` audio offsets in ms from the start
 * of the session, and the transcription confidence of those words.
 */
export const Evidence = z
  .strictObject({
    utteranceId: z.uuid(),
    span: z.tuple([z.int().nonnegative(), z.int().nonnegative()]),
    audioMs: z.tuple([AudioMs, AudioMs]),
    confidence: Confidence,
  })
  .meta({ title: "Evidence" });
export type Evidence = z.infer<typeof Evidence>;

/** A proposed value and the evidence for it. Every field carries evidence. */
export const ProposalField = z
  .strictObject({
    value: FieldValue,
    evidence: Evidence,
  })
  .meta({ title: "ProposalField" });
export type ProposalField = z.infer<typeof ProposalField>;

/**
 * Why a proposal needs a closer look: values that are costly when wrong (dates, numbers,
 * negations), low confidence, a value its evidence doesn't support, a new CRM record, or a
 * disagreement between the two witnesses.
 */
export const RiskKind = z.enum([
  "date",
  "number",
  "negation",
  "low_confidence",
  "unsupported",
  "new_entity",
  "witness_conflict",
]);
export type RiskKind = z.infer<typeof RiskKind>;

/** A risk flag on one field, or on the whole proposal when `field` is absent. */
export const RiskFlag = z
  .strictObject({
    kind: RiskKind,
    field: FieldName.optional(),
  })
  .meta({ title: "RiskFlag" });
export type RiskFlag = z.infer<typeof RiskFlag>;

export const ProposalCreatedV1 = z
  .strictObject({
    /** UUIDv7. Reviews point at proposals by this id. */
    proposalId: z.uuid(),
    type: ProposalType,
    /** The CRM record the proposal changes, or `null` when it would create a new record. */
    targetEntityId: z.string().min(1).nullable(),
    fields: z.record(FieldName, ProposalField),
    riskFlags: z.array(RiskFlag),
  })
  .meta(
    payloadMeta(
      "proposal.created",
      1,
      "ProposalCreatedV1",
      "Payload of `proposal.created`, schema version 1: a proposed CRM change with evidence for every field.",
    ),
  );
export type ProposalCreatedV1 = z.infer<typeof ProposalCreatedV1>;
