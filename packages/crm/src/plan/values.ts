// A proposal's values as its approval left them, and what the reviewer saw the CRM hold (Phase 6
// spec §4.3, §4.5's check step). Pure: plans are rebuilt from these in every write step (decision 15).
import type { FieldValue } from "@earshot/core";
import type { ProposalView, ReviewView } from "@earshot/events";

/**
 * Each of the proposal's fields as the approval left it: the proposed value, or the reviewer's
 * edit (`editDiff`'s `after`) where they made one. A field the reviewer emptied is null, and a
 * plan writes nothing for it.
 */
export function approvedValues(
  proposal: Pick<ProposalView, "fields">,
  review: Pick<ReviewView, "editDiff">,
): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const [name, field] of Object.entries(proposal.fields)) values[name] = field.value;
  for (const [name, edit] of Object.entries(review.editDiff ?? {})) {
    if (name in values) values[name] = edit.after;
  }
  return values;
}

/**
 * The CRM's value the reviewer saw for a field (`seen.current`, else `seen.base`), which a live
 * check holds the CRM to; undefined when the card showed none, and then nothing is checked.
 */
export function seenValue(review: Pick<ReviewView, "seen">, field: string): FieldValue | undefined {
  const seen = review.seen?.fields[field];
  if (seen === undefined) return undefined;
  if (seen.current !== undefined) return seen.current;
  return seen.base;
}

/** A text value, trimmed, or null when there's none (an emptied or missing field, or blank text). */
export function textOf(value: FieldValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = (typeof value === "string" ? value : String(value)).replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}
