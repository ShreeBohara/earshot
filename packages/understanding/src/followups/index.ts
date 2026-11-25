// Follow-up questions (Phase 5 spec WP13 step 3, decision 11; Phase 4 WP14's base rules; ADR-0038):
// after a turn's proposals, SessionDO asks for a value a proposal needs and doesn't have, and the
// rep answers it the way they correct anything else, or skips it. Rules, not a model: no call, no
// key, no prompt change, and the same questions every time.
//
// - A task or a commitment with no due date: "When is it due?"
// - A meeting with no date: "When is the meeting?"
// - A deal update that moves the stage but names no amount: "What's the amount?"
//
// At most two questions a turn, in the order the turn made its proposals, and none on a loud card:
// a card that already needs a check asks enough. A question isn't a flag, so the tiers, the evals'
// shares, and "accept all" never see it.
//
// Pure, like the rest of the package: the edge Worker imports it.
import { type TierFlag, type TierProposal, tierOf } from "../tiers";

/** `@earshot/core`'s `FollowupRule`. */
export type FollowupRule = "due_date" | "meeting_date" | "deal_amount";

/** The most questions one turn asks (spec WP13 step 3). */
export const MAX_FOLLOWUPS_PER_TURN = 2;

/** Each rule's question, as the card shows it. */
export const FOLLOWUP_TEXT: Readonly<Record<FollowupRule, string>> = {
  due_date: "When is it due?",
  meeting_date: "When is the meeting?",
  deal_amount: "What's the amount?",
};

/** What the rules read of a proposal: its id, type, fields, and what `tierOf` reads. */
export interface FollowupProposal extends TierProposal {
  readonly proposalId: string;
  readonly type: string;
  readonly riskFlags: readonly TierFlag[];
  readonly fields: Readonly<
    Record<
      string,
      { readonly value?: unknown; readonly norm?: TierProposal["fields"][string]["norm"] }
    >
  >;
  /** Absent for a proposal as written; `proposed` unless a policy approved it in its turn. */
  readonly status?: string;
}

/** A question to ask: `followup.asked` without its ids, which SessionDO mints. */
export interface FollowupQuestion {
  readonly proposalId: string;
  readonly field: string;
  readonly rule: FollowupRule;
  readonly text: string;
}

/** Whether a field holds a value: present, and neither null nor blank text. */
function has(proposal: FollowupProposal, field: string): boolean {
  const value = Object.hasOwn(proposal.fields, field) ? proposal.fields[field]?.value : undefined;
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim() !== "";
}

/** The rule a proposal breaks and the field it asks for, or null when it has what it needs. */
export function followupRuleFor(
  proposal: Pick<FollowupProposal, "type" | "fields">,
): { readonly field: string; readonly rule: FollowupRule } | null {
  const candidate = proposal as FollowupProposal;
  switch (proposal.type) {
    case "task":
    case "commitment":
      return has(candidate, "dueDate") ? null : { field: "dueDate", rule: "due_date" };
    case "meeting":
      return has(candidate, "date") ? null : { field: "date", rule: "meeting_date" };
    case "deal_update":
      return has(candidate, "stage") && !has(candidate, "amount")
        ? { field: "amount", rule: "deal_amount" }
        : null;
    default:
      return null;
  }
}

/**
 * The questions to ask about one turn's proposals, in their order: at most two, none about a loud
 * card or one that's no longer waiting for a decision (a policy approved it in its turn).
 */
export function followupsFor(proposals: readonly FollowupProposal[]): FollowupQuestion[] {
  const questions: FollowupQuestion[] = [];
  for (const proposal of proposals) {
    if (questions.length >= MAX_FOLLOWUPS_PER_TURN) break;
    if (proposal.status !== undefined && proposal.status !== "proposed") continue;
    if (tierOf(proposal).tier === "loud") continue;
    const rule = followupRuleFor(proposal);
    if (rule === null) continue;
    questions.push({ proposalId: proposal.proposalId, ...rule, text: FOLLOWUP_TEXT[rule.rule] });
  }
  return questions;
}
