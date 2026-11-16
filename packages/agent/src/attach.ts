// Turns a proposal as the model drafted it into a `proposal.created` payload, less its id: each
// field's quote becomes evidence, the target name becomes an entity id, and risk flags are added.
import type {
  EntityRef,
  ProposalCreatedV1,
  ProposalField,
  RiskFlag,
  UtteranceFinalV2,
} from "@earshot/core";
import { matchEntity } from "./entities";
import { evidenceFor, locateQuote, spanText, wordsBefore } from "./evidence";
import { fieldRiskFlags, NEGATION_LOOKBEHIND_WORDS } from "./risk";
import { TARGET_KINDS, type ToolField, type ToolProposal } from "./schema";

/** A `proposal.created` v1 payload without its `proposalId`, which `SessionDO` mints. */
export type ProposalDraft = Omit<ProposalCreatedV1, "proposalId">;

export interface AttachContext {
  /** The turn's utterances: the only place a quote may come from. */
  readonly utterances: readonly UtteranceFinalV2[];
  /** The session's entities, for the target. */
  readonly entities: readonly EntityRef[];
}

/**
 * Attaches evidence to one drafted proposal.
 * - A field whose value is empty (with its quote) counts as not said, like `null`.
 * - A field whose quote isn't found in the turn's utterances is dropped, because
 *   `proposal.created` requires evidence on every field, and the proposal gets an `unsupported`
 *   flag naming it.
 * - A proposal left with no fields is dropped: returns null.
 * - `targetEntityId` is an exact match of the target name (`matchEntity`), or null. A contact
 *   proposal whose target doesn't match falls back to its `name` field, so a listed contact the
 *   model forgot to target isn't proposed as new. Still no match means a new contact, flagged
 *   `new_entity`.
 */
export function attachEvidence(
  proposal: ToolProposal,
  context: AttachContext,
): ProposalDraft | null {
  const fields: Record<string, ProposalField> = {};
  const fieldFlags: RiskFlag[] = [];
  const unsupported: RiskFlag[] = [];
  for (const [name, field] of Object.entries(proposal.fields) as [string, ToolField | null][]) {
    if (field === null) continue;
    const value = typeof field.value === "string" ? field.value.trim() : field.value;
    if (value === "") {
      if (field.quote.trim() !== "") unsupported.push({ kind: "unsupported", field: name });
      continue;
    }
    const location = locateQuote(field.quote, context.utterances);
    if (location === null) {
      unsupported.push({ kind: "unsupported", field: name });
      continue;
    }
    const evidence = evidenceFor(location);
    fields[name] = { value, evidence };
    fieldFlags.push(
      ...fieldRiskFlags({
        field: name,
        value,
        spanText: spanText(location),
        before: wordsBefore(location, NEGATION_LOOKBEHIND_WORDS),
        confidence: evidence.confidence,
      }),
    );
  }
  if (Object.keys(fields).length === 0) return null;
  const kinds = TARGET_KINDS[proposal.type];
  let target = matchEntity(proposal.target, context.entities, kinds);
  const name = fields.name?.value;
  if (target === null && proposal.type === "contact" && typeof name === "string") {
    target = matchEntity(name, context.entities, kinds);
  }
  const riskFlags = [...fieldFlags, ...unsupported];
  if (proposal.type === "contact" && target === null) riskFlags.push({ kind: "new_entity" });
  return {
    type: proposal.type,
    targetEntityId: target?.id ?? null,
    fields,
    riskFlags,
  };
}
