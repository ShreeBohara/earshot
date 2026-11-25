// What Settings → Review's approval policy says (Phase 5 spec WP11 step 4), and how its switches
// become rules: one rule per proposal type, named for the type, holding back the fields the rep
// ticked. Pure, so the page, the inbox's "Approved by your policy: notes", and tests share it.
import {
  type ApprovalPolicyRule,
  type ApprovalPolicyRules,
  PROPOSAL_TYPE_FIELDS,
  type ProposalTypeV2,
} from "@earshot/core";

/** The order the page lists proposal types in. */
export const POLICY_TYPES: readonly ProposalTypeV2[] = [
  "note",
  "task",
  "commitment",
  "meeting",
  "contact",
  "deal_update",
];

/** A rule's id for each type, as the page writes it: the type's plural, in the id's alphabet. */
export const RULE_IDS: Readonly<Record<ProposalTypeV2, string>> = {
  note: "notes",
  task: "tasks",
  contact: "contacts",
  deal_update: "deal-updates",
  commitment: "commitments",
  meeting: "meetings",
};

/** Each type in plain words, with an example of one, as a rep would say it. */
export const POLICY_TYPE_COPY: Readonly<
  Record<ProposalTypeV2, { readonly label: string; readonly example: string }>
> = {
  note: {
    label: "Notes",
    example: "“Their main concern is how long SSO setup takes.”",
  },
  task: { label: "Tasks", example: "“Send Dana the pricing breakdown by Thursday.”" },
  commitment: {
    label: "Commitments",
    example: "“We’ll run a security workshop with their IT team.”",
  },
  meeting: { label: "Meetings", example: "“Demo with their IT team next Tuesday at 2.”" },
  contact: { label: "Contacts", example: "“Dana Lee, their new VP of Operations.”" },
  deal_update: { label: "Deal updates", example: "“Move the Acme deal to Negotiation.”" },
};

/**
 * The fields a rep can hold back, per type, each with an example: every field a proposal of the
 * type can come without. A type's main field (a note's text, a task's title) is on every proposal
 * of it, so holding it back would be the same as leaving auto-approve off; the page doesn't offer
 * it.
 */
export const ALWAYS_REVIEW_COPY: Readonly<
  Record<
    ProposalTypeV2,
    readonly { readonly field: string; readonly label: string; readonly example: string }[]
  >
> = {
  note: [],
  task: [{ field: "dueDate", label: "Due date", example: "“by Thursday”" }],
  commitment: [
    { field: "counterpart", label: "Who it’s with", example: "“their IT team”" },
    { field: "dueDate", label: "Due date", example: "“next month”" },
  ],
  meeting: [
    { field: "date", label: "Date", example: "“next Tuesday”" },
    { field: "time", label: "Time", example: "“at 2”" },
    { field: "attendees", label: "Who’s coming", example: "“their IT team”" },
  ],
  contact: [
    { field: "title", label: "Title", example: "“VP of Operations”" },
    { field: "company", label: "Company", example: "“Acme Corp”" },
    { field: "email", label: "Email", example: "“dana@acme.example”" },
    { field: "phone", label: "Phone", example: "“415 555 0134”" },
  ],
  deal_update: [
    { field: "stage", label: "Stage", example: "“to Negotiation”" },
    { field: "amount", label: "Amount", example: "“$48,000”" },
    { field: "closeDate", label: "Close date", example: "“by March 31”" },
  ],
};

/** The page's state for one type: auto-approve on or off, and the fields held back. */
export interface TypeChoice {
  readonly on: boolean;
  readonly alwaysReview: readonly string[];
  /** The rule's id, kept from the policy when it had one for the type. */
  readonly id: string;
}

export type PolicyChoices = Readonly<Record<ProposalTypeV2, TypeChoice>>;

/** The page's switches for a policy's rules: on where a rule names the type. */
export function choicesFrom(rules: ApprovalPolicyRules | null): PolicyChoices {
  const byType = new Map<ProposalTypeV2, ApprovalPolicyRule>();
  // The first rule for a type is the one that approves (`policyRuleFor`).
  for (const rule of rules?.autoApprove ?? []) {
    if (!byType.has(rule.type)) byType.set(rule.type, rule);
  }
  const choice = (type: ProposalTypeV2): TypeChoice => {
    const rule = byType.get(type);
    return {
      on: rule !== undefined,
      alwaysReview: rule?.alwaysReview ?? [],
      id: rule?.id ?? RULE_IDS[type],
    };
  };
  return {
    note: choice("note"),
    task: choice("task"),
    contact: choice("contact"),
    deal_update: choice("deal_update"),
    commitment: choice("commitment"),
    meeting: choice("meeting"),
  };
}

/**
 * The rules the page's switches say: one per type that's on, in the page's order, each field in
 * the type's own order (`PROPOSAL_TYPE_FIELDS`), so the same switches always make the same rules.
 */
export function rulesFrom(choices: PolicyChoices): ApprovalPolicyRules {
  return {
    v: 1,
    autoApprove: POLICY_TYPES.filter((type) => choices[type].on).map((type) => ({
      id: choices[type].id,
      type,
      alwaysReview: PROPOSAL_TYPE_FIELDS[type].filter((field) =>
        choices[type].alwaysReview.includes(field),
      ),
    })),
  };
}

/** "notes", "deal updates": a rule's id in words, for "Approved by your policy: notes". */
export function ruleWords(rule: string): string {
  return rule.replaceAll("-", " ");
}

/** "Version 3, changed by you", or who changed it, for the page's line about the policy. */
export function changedBy(createdBy: string | null, viewerId: string, name: string | null): string {
  if (createdBy === null) return "a former member";
  if (createdBy === viewerId) return "you";
  return name ?? "another member";
}
