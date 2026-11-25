// Approval policies at a proposal's creation (Phase 5 spec §4.6, WP11; ADR-0034): which rule, if
// any, approves a proposal on its own. SessionDO runs it right after `understand()`, on each new
// proposal as the session's projection folds it, against the snapshot its `start` carried, and
// appends the approval in the turn's own transaction as a `proposal.reviewed` v3 with
// `mode: "policy"`, which `checkReview` checks again. Pure, and as narrow as the spec: a rule
// can only add a proposal type and hold fields back, never loosen what follows.
import type { ApprovalPolicyRule, ApprovalPolicyRules } from "@earshot/core";
import type { ProposalView } from "./projections";
import type { TierOf } from "./review-rules";

/**
 * Why no rule approves a proposal, in the order they're checked:
 *
 * - `marked`: `tierOf` isn't `none`, so the card shows something, the name note included;
 * - `not_linked`: its record is a question, new, or none (for a contact, its name didn't link);
 * - `supersedes`: it replaces another proposal (a correction, WP13);
 * - `no_rule`: no rule names its type;
 * - `always_review`: it carries a field every rule for its type holds back.
 */
export type PolicyExclusion = "marked" | "not_linked" | "supersedes" | "no_rule" | "always_review";

export type PolicyMatch =
  | { readonly ok: true; readonly rule: ApprovalPolicyRule }
  | { readonly ok: false; readonly reason: PolicyExclusion };

/**
 * The rule that approves `proposal` on its own, or why none does (spec §4.6). A proposal
 * auto-approves when all of these hold:
 *
 * - `tierOf` is `none`: no loud reason, no quiet note, and no name note;
 * - its target is `linked` to a record (a contact's is its name, linked);
 * - it doesn't supersede another proposal;
 * - a rule exists for its type, and it carries none of that rule's `alwaysReview` fields. A field
 *   the proposal doesn't carry (the model left it out) holds nothing back.
 *
 * The first matching rule wins. A policy's writer keeps one rule per type (`checkPolicyRules`),
 * so at most one can match, but the order is fixed regardless.
 */
export function policyRuleFor(
  proposal: ProposalView,
  rules: ApprovalPolicyRules,
  ctx: { readonly tierOf: TierOf },
): PolicyMatch {
  if (ctx.tierOf(proposal).tier !== "none") return { ok: false, reason: "marked" };
  const { target } = proposal;
  if (target.decision !== "linked" || target.entityId === null) {
    return { ok: false, reason: "not_linked" };
  }
  if (proposal.supersedes !== null) return { ok: false, reason: "supersedes" };
  const forType = rules.autoApprove.filter((rule) => rule.type === proposal.type);
  if (forType.length === 0) return { ok: false, reason: "no_rule" };
  // Own fields only: `fields` is a record keyed by field name, and a name such as `constructor`
  // mustn't be found on Object's prototype.
  const rule = forType.find(
    (candidate) => !candidate.alwaysReview.some((field) => Object.hasOwn(proposal.fields, field)),
  );
  return rule ? { ok: true, rule } : { ok: false, reason: "always_review" };
}
