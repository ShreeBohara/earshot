import { z } from "zod";
import { EntityKind } from "../entity-ref";
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

// ─── Version 2 (Phase 4 spec §4.1) ─────────────────────────────────────────────────────────────
// The extractor names the record; a deterministic linker in SessionDO resolves the name. v1's
// exports above stay frozen: stored v1 events upcast to v2 on read (`@earshot/events`).

/** v1's proposal types, plus `meeting`. */
export const ProposalTypeV2 = z.enum([
  "note",
  "task",
  "contact",
  "deal_update",
  "commitment",
  "meeting",
]);
export type ProposalTypeV2 = z.infer<typeof ProposalTypeV2>;

/** v1's seven risk kinds, unchanged, plus seven from the linker, the normalizers, and the checks. */
export const RiskKindV2 = z.enum([
  "date",
  "number",
  "negation",
  "low_confidence",
  "unsupported",
  "new_entity",
  "witness_conflict",
  /** Linked by sound or spelling, not by an exact name or alias. */
  "link_uncertain",
  /** The linker asked: two or more records fit. */
  "ambiguous_target",
  /** No name was said; the open account was used. */
  "implied_target",
  /** The model's value disagrees with the deterministic reading of its quote. */
  "value_mismatch",
  /** The quote has two readings ("next Friday", "50 to 60k"). */
  "ambiguous_value",
  /** The quote comes just before a correction ("Thursday, sorry, Friday"). */
  "self_correction",
  /** Free text that shares little with the words it cites. */
  "weak_support",
]);
export type RiskKindV2 = z.infer<typeof RiskKindV2>;

/**
 * The field name reserved for the proposal's target, in risk flags (`link_uncertain:target`) and
 * in witness conflicts. No proposal type has a field called `target`.
 */
export const TARGET_FIELD = "target";

/** A risk flag on one field, on the target (`field: "target"`), or on the whole proposal. */
export const RiskFlagV2 = z
  .strictObject({
    kind: RiskKindV2,
    field: FieldName.optional(),
  })
  .meta({ title: "RiskFlagV2" });
export type RiskFlagV2 = z.infer<typeof RiskFlagV2>;

/**
 * What the linker decided about the record a proposal changes: link it, ask the rep, propose a
 * new record, or none (the proposal has no target, or its name isn't in the transcript).
 */
export const TargetDecision = z.enum(["linked", "ask", "new", "none"]);
export type TargetDecision = z.infer<typeof TargetDecision>;

/**
 * Why a target was linked: an exact name or alias, sound or spelling, context (the company said
 * in the same breath, the open account's family, an earlier link), or the open account itself
 * when no name was said.
 */
export const TargetBasis = z.enum(["exact", "sound", "context", "focus"]);
export type TargetBasis = z.infer<typeof TargetBasis>;

/** A record the target may be, with its calibrated probability. A `null` id is a new record. */
export const TargetCandidate = z
  .strictObject({
    entityId: z.string().min(1).nullable(),
    p: Confidence,
  })
  .meta({ title: "TargetCandidate" });
export type TargetCandidate = z.infer<typeof TargetCandidate>;

/** The most candidates a target lists: the top three records, plus "new". */
export const MAX_TARGET_CANDIDATES = 4;

/** Words of the transcript that name a record: the quote, and where it was said. */
const NamingQuote = { quote: z.string().min(1), evidence: Evidence };

/**
 * The record a proposal changes, as the linker resolved it. Rules the writer keeps, which the
 * schema can't express in JSON Schema and therefore doesn't check:
 * - `entityId` is set exactly when `decision` is `linked`;
 * - `mention` is null only for an implied target (`basis: "focus"`) or `decision: "none"`;
 * - `p` is null only for a target upcast from v1, or an implied one.
 */
export const TargetV2 = z
  .strictObject({
    decision: TargetDecision,
    /** The linked record's id in the workspace's CRM mirror. */
    entityId: z.string().min(1).nullable(),
    /** The kind of record the model said it was. */
    kind: EntityKind.nullable(),
    basis: TargetBasis.nullable(),
    /** Calibrated probability of the decision; null when upcast from v1 or implied. */
    p: Confidence.nullable(),
    /** The words that named the record. */
    mention: z.strictObject(NamingQuote).meta({ title: "TargetMention" }).nullable(),
    /** The company said with a contact or deal, and the record it links to, if any. */
    company: z
      .strictObject({ ...NamingQuote, entityId: z.string().min(1).nullable() })
      .meta({ title: "TargetCompany" })
      .nullable(),
    /** The best candidates, most likely first. Empty when upcast from v1. */
    candidates: z.array(TargetCandidate).max(MAX_TARGET_CANDIDATES),
  })
  .meta({ title: "TargetV2" });
export type TargetV2 = z.infer<typeof TargetV2>;

/** What the normalizers made of a field's quote, when they had something to say (WP7). */
export const FieldNorm = z
  .strictObject({
    /** The model's value, kept when a unique deterministic reading replaced it. */
    llmValue: FieldValue.optional(),
    /** Every reading of an ambiguous quote. */
    readings: z.array(FieldValue).max(3).optional(),
    /** ISO 4217, for an amount. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  })
  .meta({ title: "FieldNorm" });
export type FieldNorm = z.infer<typeof FieldNorm>;

/** A proposed value, its evidence, and what the normalizers made of it. */
export const ProposalFieldV2 = ProposalField.extend({
  norm: FieldNorm.optional(),
}).meta({ title: "ProposalFieldV2" });
export type ProposalFieldV2 = z.infer<typeof ProposalFieldV2>;

export const ProposalCreatedV2 = z
  .strictObject({
    /** UUIDv7. Reviews and flags point at proposals by this id. */
    proposalId: z.uuid(),
    type: ProposalTypeV2,
    /** The record the proposal changes, as the linker resolved it. Replaces `targetEntityId`. */
    target: TargetV2,
    fields: z.record(FieldName, ProposalFieldV2),
    riskFlags: z.array(RiskFlagV2),
    /** The proposal this one replaces (WP14's follow-ups); null otherwise. */
    supersedes: z.uuid().nullable(),
    /** The linker that resolved the target, such as `linker.v1`; null when upcast from v1. */
    linker: z.string().min(1).nullable(),
  })
  .meta(
    payloadMeta(
      "proposal.created",
      2,
      "ProposalCreatedV2",
      "Payload of `proposal.created`, schema version 2: a proposed CRM change whose target the entity linker resolved, with evidence for every field.",
    ),
  );
export type ProposalCreatedV2 = z.infer<typeof ProposalCreatedV2>;
