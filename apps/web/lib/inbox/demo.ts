// The inbox's demo controls (Phase 5 spec WP12 step 4; ADR-0035), in a card's More menu, and only
// on cards whose record is a demo record: "Simulate a CRM change" moves one field of the card's
// record in the demo CRM, so the card shows three values on the next load; "Add a matching record"
// adds the record a new-record card heard, so the card offers it. Pure: which card gets which
// control. The server actions (app/actions/inbox-demo.ts) decide again from the database, and the
// data layer (`moveDemoField`, `addDemoRecord` in @earshot/db) acts only on demo records.
import { relinkOffer, UPDATE_FIELDS } from "./crm";
import type { InboxEntity, InboxProposal } from "./types";

type Entities = Readonly<Record<string, InboxEntity>>;

/**
 * The field "Simulate a CRM change" moves on a card, or null when the card gets no such control:
 * an open update (a deal's stage, amount, or close date; a contact's title, email, or phone)
 * linked to a demo record, the first of its fields, in that order, that the record holds a value
 * for. Moving it is what makes this card show three values.
 */
export function simulatedField(
  proposal: Pick<InboxProposal, "status" | "type" | "target" | "fields">,
  entities: Entities,
): string | null {
  const { target } = proposal;
  if (proposal.status !== "proposed" || target.decision !== "linked" || !target.entityId) {
    return null;
  }
  const record = entities[target.entityId];
  if (record?.demo !== true) return null;
  return (
    (UPDATE_FIELDS[proposal.type] ?? []).find(
      (field) => field in proposal.fields && field in record.values,
    ) ?? null
  );
}

/**
 * Whether a card gets "Add a matching record": an open new-record proposal for a company or a
 * contact, named by words, in a workspace whose mirror is the demo CRM, and offered nothing yet.
 */
export function canAddMatching(
  proposal: Pick<InboxProposal, "status" | "target" | "crm">,
  demoCrm: boolean,
): boolean {
  const { target } = proposal;
  return (
    demoCrm &&
    proposal.status === "proposed" &&
    target.decision === "new" &&
    target.mention !== null &&
    (target.kind === "company" || target.kind === "contact") &&
    relinkOffer(proposal) === null
  );
}
