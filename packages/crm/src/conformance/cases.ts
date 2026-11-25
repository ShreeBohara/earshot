// The conformance suite's cases (Phase 6 spec §4.2's groups 2 to 5): each of the six proposal types,
// against a linked record and a new one, with the values a rep might say. The same twelve plan once
// against committed golden inputs (fixed ids, markers, and a schema the adapter gives), and again
// against the CRM itself, with fixtures the harness makes and ids fresh for each check.
import type {
  CrmMappedStage,
  CrmMapping,
  FieldValue,
  ProposalTypeV2,
  SeenField,
} from "@earshot/core";
import type { CrmSchema, MirrorRef, PlanInput } from "../adapter";
import { proposalView, reviewView } from "../testing/proposals";

/** Whether a case's record is linked, or new. */
export type CaseTarget = "linked" | "new";

/** One case: a proposal type against a linked record or a new one. */
export interface Case {
  readonly type: ProposalTypeV2;
  readonly target: CaseTarget;
  /** `note.linked`, `deal_update.new`: the golden file's name, and the check's. */
  readonly id: string;
}

const TYPES: readonly ProposalTypeV2[] = [
  "note",
  "task",
  "contact",
  "deal_update",
  "commitment",
  "meeting",
];

/** The twelve cases, in the spec's order. */
export const CASES: readonly Case[] = TYPES.flatMap((type) =>
  (["linked", "new"] as const).map((target) => ({ type, target, id: `${type}.${target}` })),
);

/** The records a case may point at, and their values as the mirror holds them. */
export interface CaseWorld {
  readonly schema: CrmSchema;
  readonly mapping: CrmMapping;
  readonly rep: PlanInput["rep"];
  readonly company: MirrorRef;
  readonly contact: MirrorRef;
  readonly deal: MirrorRef;
  /** The linked contact's and deal's values as the mirror holds them: what the reviewer saw. */
  readonly seen: {
    readonly contact: Readonly<Record<string, FieldValue>>;
    readonly deal: Readonly<Record<string, FieldValue>>;
  };
  /** The stage a deal update moves to: one the mapping reads exactly, unlike the deal's own. */
  readonly stage: CrmMappedStage;
  /** An email nothing else in the CRM holds, for the contact a case makes or updates. */
  readonly email: string;
  readonly proposalId: string;
  readonly reviewId: string;
  readonly key: string;
  readonly markers: readonly string[];
}

/** What a case's proposal says, by type and target. */
function fieldsOf(caseItem: Case, world: CaseWorld): Readonly<Record<string, FieldValue>> {
  switch (caseItem.type) {
    case "note":
      return { body: "Dana wants the security review before legal signs." };
    case "task":
      return { title: "Send the revised pricing", dueDate: "2026-12-04" };
    case "contact":
      return caseItem.target === "linked"
        ? {
            name: world.contact.name,
            title: "Chief Operating Officer",
            email: world.email,
            phone: "555-0177",
          }
        : {
            name: "Priya Raman",
            title: "VP of Operations",
            email: world.email,
            phone: "555-0142",
            company: world.company.name,
          };
    case "deal_update":
      return caseItem.target === "linked"
        ? { stage: world.stage.label, amount: 48_000, closeDate: "2026-12-15" }
        : { stage: world.stage.label, amount: 25_000, closeDate: "2027-01-15" };
    case "commitment":
      return { text: "Share the SOC 2 report", counterpart: "Dana", dueDate: "2026-12-01" };
    case "meeting":
      return {
        title: "Security review",
        date: "2026-12-03",
        time: "14:30",
        attendees: "Dana and their CISO",
      };
  }
}

/** The record a linked case points at, by type. */
function linkedOf(caseItem: Case, world: CaseWorld): MirrorRef {
  switch (caseItem.type) {
    case "note":
    case "deal_update":
      return world.deal;
    case "task":
    case "contact":
      return world.contact;
    case "commitment":
    case "meeting":
      return world.company;
  }
}

/** The new record a new case makes for an activity, by type: its kind and the words that named it. */
function newTargetOf(caseItem: Case): { kind: "company" | "contact" | "deal"; words: string } {
  switch (caseItem.type) {
    case "note":
      return { kind: "company", words: "Northwind Foods" };
    case "task":
      return { kind: "contact", words: "Sam Ortiz" };
    case "commitment":
      return { kind: "company", words: "Atlas Freight" };
    case "meeting":
      return { kind: "deal", words: "the Acme expansion" };
    case "deal_update":
      return { kind: "deal", words: "the Acme pilot" };
    case "contact":
      return { kind: "contact", words: "Priya Raman" };
  }
}

/** What the card showed for a linked update: each field's proposed value beside the mirror's. */
function seenOf(
  caseItem: Case,
  fields: Readonly<Record<string, FieldValue>>,
  world: CaseWorld,
): Record<string, SeenField> {
  if (caseItem.target !== "linked") return {};
  const mirror =
    caseItem.type === "deal_update"
      ? world.seen.deal
      : caseItem.type === "contact"
        ? world.seen.contact
        : null;
  if (mirror === null) return {};
  const seen: Record<string, SeenField> = {};
  for (const [field, proposed] of Object.entries(fields)) {
    const base = mirror[field];
    if (base !== undefined) seen[field] = { proposed, base };
  }
  return seen;
}

/**
 * A case's plan input in a world: its proposal and approval, the record it points at (or none, for
 * a new one), the company a new person or deal is linked to, and the world's mapping and markers.
 */
export function caseInput(
  caseItem: Case,
  world: CaseWorld,
  override: Readonly<Record<string, FieldValue>> = {},
): PlanInput {
  const fields = { ...fieldsOf(caseItem, world), ...override };
  const linked = caseItem.target === "linked" ? linkedOf(caseItem, world) : null;
  const usesCompany =
    caseItem.target === "new" &&
    (caseItem.type === "contact" ||
      caseItem.type === "deal_update" ||
      newTargetOf(caseItem).kind !== "company");
  const company = usesCompany ? world.company : null;
  const proposal = proposalView(
    caseItem.type,
    fields,
    linked !== null ? { linked } : { new: newTargetOf(caseItem) },
    { id: world.proposalId, company },
  );
  return {
    proposal,
    review: reviewView({
      id: world.reviewId,
      seen: seenOf(caseItem, fields, world),
      entityId: linked?.entityId ?? null,
    }),
    target: linked,
    company,
    mapping: world.mapping,
    schema: world.schema,
    rep: world.rep,
    key: world.key,
    markers: world.markers,
  };
}

/** Whether a case needs a deal the CRM may not have: a deal update, or a meeting on a new deal. */
export function needsDeals(caseItem: Case): boolean {
  return (
    caseItem.type === "deal_update" ||
    (caseItem.target === "new" && newTargetOf(caseItem).kind === "deal")
  );
}
