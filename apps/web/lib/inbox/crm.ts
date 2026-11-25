// What the CRM's mirror says about a card at review time (Phase 5 spec decision 10, WP12; ADR-0035),
// pure, from what the loader read (`InboxProposal.crm`, `InboxEntity.values`):
//
// - **Two values:** an update's field shows the CRM's value now beside the proposed one ("before →
//   after"), as WP5 built it.
// - **Three values,** when the CRM's value moved since the proposal was made: "Discovery when you
//   spoke · Proposal in the CRM now (changed 2 h ago) · you said Negotiation". Keep mine accepts,
//   Keep the CRM's is an edit to the value now, and Edit edits.
// - **A re-link offer,** when a new record's words link now to a record that reached the CRM after
//   the rep spoke.
//
// Either makes the card loud at review time, though neither is a flag: "accept all" leaves it, no
// policy could have taken it, and the evals don't count it.
import type { FieldEdit, FieldValue } from "@earshot/core";
import type { InboxEntity, InboxProposal } from "./types";

type Entities = Readonly<Record<string, InboxEntity>>;

/** The fields an update reads against the CRM's value, by proposal type. */
export const UPDATE_FIELDS: Readonly<Partial<Record<InboxProposal["type"], readonly string[]>>> = {
  deal_update: ["stage", "amount", "closeDate"],
  contact: ["title", "email", "phone"],
};

/**
 * The CRM's value now of a field an update changes, as the card shows it "before": only for an
 * update (a deal's stage, amount, or close date; a linked contact's title, email, or phone) whose
 * record the mirror holds. Undefined otherwise: notes, tasks, commitments, and meetings create
 * records.
 */
export function currentValue(
  proposal: Pick<InboxProposal, "type" | "target">,
  field: string,
  entities: Entities,
): FieldValue | undefined {
  const { target } = proposal;
  if (target.decision !== "linked" || target.entityId === null) return undefined;
  if (!UPDATE_FIELDS[proposal.type]?.includes(field)) return undefined;
  const values = entities[target.entityId]?.values;
  return values && field in values ? values[field] : undefined;
}

/** One field whose CRM value moved since the proposal: the card's three values. */
export interface ThreeWayField {
  readonly field: string;
  /** The CRM's value when the rep spoke. */
  readonly base: FieldValue;
  /** The CRM's value now. */
  readonly current: FieldValue;
  /** What the rep said. */
  readonly proposed: FieldValue;
  /** When the CRM's value last changed. */
  readonly changedAt: string;
}

/**
 * The CRM's value when the proposal was made, for an update's field: the history's (`crm.moved`),
 * else the value now, which it held then too. Undefined where `currentValue` is.
 */
export function baseValue(
  proposal: Pick<InboxProposal, "type" | "target" | "crm">,
  field: string,
  entities: Entities,
): FieldValue | undefined {
  const current = currentValue(proposal, field, entities);
  const moved = UPDATE_FIELDS[proposal.type]?.includes(field)
    ? proposal.crm?.moved[field]
    : undefined;
  if (moved && proposal.target.decision === "linked") return moved.base;
  return current;
}

/**
 * The fields shown three ways: an update's fields, linked to a record, whose CRM value now differs
 * from its value when the rep spoke. Empty for everything else.
 */
export function threeWayFields(
  proposal: Pick<InboxProposal, "type" | "target" | "fields" | "crm">,
  entities: Entities,
): ThreeWayField[] {
  const moved = proposal.crm?.moved;
  if (!moved || proposal.target.decision !== "linked" || proposal.target.entityId === null) {
    return [];
  }
  return (UPDATE_FIELDS[proposal.type] ?? []).flatMap((field): ThreeWayField[] => {
    const change = moved[field];
    const said = proposal.fields[field];
    if (!change || !said) return [];
    const current = currentValue(proposal, field, entities) ?? null;
    if (current === change.base) return [];
    return [
      { field, base: change.base, current, proposed: said.value, changedAt: change.changedAt },
    ];
  });
}

/** The record offered at review time on a new-record proposal still open, or null. */
export function relinkOffer(
  proposal: Pick<InboxProposal, "status" | "target" | "crm">,
): string | null {
  if (proposal.status !== "proposed" || proposal.target.decision !== "new") return null;
  return proposal.crm?.relink ?? null;
}

/** Why a card is loud at review time though no flag says so. */
export type ReviewTimeMark =
  | { readonly kind: "relink"; readonly entityId: string }
  | { readonly kind: "crm_changed"; readonly fields: readonly ThreeWayField[] };

/** The card's review-time mark: a record offered, or fields shown three ways; null otherwise. */
export function reviewTimeMark(
  proposal: Pick<InboxProposal, "status" | "type" | "target" | "fields" | "crm">,
  entities: Entities,
): ReviewTimeMark | null {
  const relinked = relinkOffer(proposal);
  if (relinked !== null) return { kind: "relink", entityId: relinked };
  const fields = threeWayFields(proposal, entities);
  return fields.length > 0 ? { kind: "crm_changed", fields } : null;
}

/**
 * "Keep the CRM's": the edit that sets each field shown three ways to the CRM's value now. A field
 * whose value now is the one proposed changes nothing, so it's left out; with nothing left, keeping
 * the CRM's is keeping the rep's, and the card is simply accepted.
 */
export function keepCrmDiff(fields: readonly ThreeWayField[]): Record<string, FieldEdit> {
  const diff: Record<string, FieldEdit> = {};
  for (const field of fields) {
    if (field.current !== field.proposed) {
      diff[field.field] = { before: field.proposed, after: field.current };
    }
  }
  return diff;
}
