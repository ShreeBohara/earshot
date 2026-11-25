// Approval policies (Phase 5 spec §4.6, WP11; ADR-0034): a workspace's rules for which proposals
// SessionDO approves on its own as they're created. A rule names a proposal type and the fields
// that always need a person; a proposal carrying any of them is never auto-approved. Nothing else
// a rule could say widens what a policy takes: a proposal must also be unmarked (`tierOf` is
// `none`), linked to a record, and not replace another (`policyRuleFor` in `@earshot/events`).
//
// `ApprovalPolicyRules` is a contract: exported to JSON Schema and Pydantic, structural with no
// refinements, so both languages accept the same documents. The rules a schema can't express (one
// rule per type, unique ids, each field one of its type's) are `checkPolicyRules`, which the web
// Worker's writer runs before it stores a version.
import { z } from "zod";
import { containsKeyShape } from "../key-shapes";
import { ProposalTypeV2 } from "./events/proposal-created";
import { FieldName } from "./events/shared";

/** The most rules a policy holds: two per proposal type (target). */
export const MAX_POLICY_RULES = 12;
/** The most fields one rule may hold back for review. */
export const MAX_ALWAYS_REVIEW_FIELDS = 10;
/**
 * The longest field name a rule may list, in characters. Field names are camelCase words, such
 * as `closeDate`; the cap keeps a policy, and the session's `start` that carries it, small.
 */
export const MAX_POLICY_FIELD_CHARS = 64;

/**
 * One rule: auto-approve proposals of `type`, except any carrying a field in `alwaysReview`. Its
 * `id` names it in every auto-approval it makes (`proposal.reviewed` v2's `policy.rule`), so the
 * audit chain says which rule approved what.
 */
export const ApprovalPolicyRule = z
  .strictObject({
    /** Lowercase letters, digits, and hyphens, 1–40 characters, such as `notes`. */
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    type: ProposalTypeV2,
    /** A proposal carrying any of these fields is never auto-approved. */
    alwaysReview: z.array(FieldName.max(MAX_POLICY_FIELD_CHARS)).max(MAX_ALWAYS_REVIEW_FIELDS),
  })
  .meta({ title: "ApprovalPolicyRule" });
export type ApprovalPolicyRule = z.infer<typeof ApprovalPolicyRule>;

/**
 * A version of a workspace's approval policy. "Auto-approve notes; always review amounts and
 * stages" is `{ v: 1, autoApprove: [{ id: "notes", type: "note", alwaysReview: [] },
 * { id: "deal-updates", type: "deal_update", alwaysReview: ["amount", "stage"] }] }`. An empty
 * `autoApprove` approves nothing, as having no policy does.
 */
export const ApprovalPolicyRules = z
  .strictObject({
    v: z.literal(1),
    autoApprove: z.array(ApprovalPolicyRule).max(MAX_POLICY_RULES),
  })
  .meta({
    title: "ApprovalPolicyRules",
    description:
      "A version of a workspace's approval policy, version 1 of its form: the proposal types SessionDO approves on its own as they're created, each with the fields that always need review.",
  });
export type ApprovalPolicyRules = z.infer<typeof ApprovalPolicyRules>;

/**
 * The fields each proposal type carries, as the extractor's tool schema v2 names them
 * (`@earshot/agent`, whose tests hold the two to the same fields): what a rule's `alwaysReview`
 * may list. A field the model left out isn't on the proposal, so it holds nothing back.
 */
export const PROPOSAL_TYPE_FIELDS: Readonly<Record<ProposalTypeV2, readonly string[]>> = {
  note: ["body"],
  task: ["title", "dueDate"],
  contact: ["name", "title", "company", "email", "phone"],
  deal_update: ["stage", "amount", "closeDate"],
  commitment: ["text", "counterpart", "dueDate"],
  meeting: ["title", "date", "time", "attendees"],
};

export type PolicyRulesCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: string };

/**
 * The rules a policy keeps that its schema can't express, checked on `ApprovalPolicyRules` that
 * already parsed:
 *
 * - each rule's id is unique, since auto-approvals name their rule by it;
 * - each proposal type has at most one rule, so which rule approved a proposal is never a choice;
 * - each `alwaysReview` field is one of its type's (`PROPOSAL_TYPE_FIELDS`), listed once;
 * - no id is shaped like a provider key: the policy rides in the session's `start`, which the
 *   socket refuses if anything in it looks like one, so such a policy would stop every session.
 *
 * The problem names the rule by position, never by anything it holds.
 */
export function checkPolicyRules(rules: ApprovalPolicyRules): PolicyRulesCheck {
  const ids = new Set<string>();
  const types = new Set<string>();
  for (const [index, rule] of rules.autoApprove.entries()) {
    const where = `rule ${index + 1}`;
    if (ids.has(rule.id)) return { ok: false, problem: `${where} repeats another rule's id` };
    if (types.has(rule.type)) {
      return { ok: false, problem: `${where} is a second rule for its proposal type` };
    }
    if (containsKeyShape(rule.id)) {
      return { ok: false, problem: `${where} has an id shaped like a key` };
    }
    ids.add(rule.id);
    types.add(rule.type);
    const allowed = PROPOSAL_TYPE_FIELDS[rule.type];
    const fields = new Set<string>();
    for (const field of rule.alwaysReview) {
      if (!allowed.includes(field)) {
        return { ok: false, problem: `${where} lists a field its proposal type doesn't have` };
      }
      if (fields.has(field)) return { ok: false, problem: `${where} lists a field twice` };
      fields.add(field);
    }
  }
  return { ok: true };
}
