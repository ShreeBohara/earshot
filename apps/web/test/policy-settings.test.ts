import {
  type ApprovalPolicyRules,
  checkPolicyRules,
  PROPOSAL_TYPE_FIELDS,
  ProposalTypeV2,
} from "@earshot/core";
import { describe, expect, it } from "vitest";
import { decisionWords } from "@/lib/inbox/copy";
import type { InboxProposal } from "@/lib/inbox/types";
import {
  ALWAYS_REVIEW_COPY,
  changedBy,
  choicesFrom,
  POLICY_TYPES,
  RULE_IDS,
  rulesFrom,
  ruleWords,
} from "@/lib/policies/copy";

// Settings → Review's approval policy (Phase 5 WP11 step 4): the switches become rules the writer
// accepts, and back; and Reviewed's line for an auto-approval names its rule (step 5).

describe("the policy's switches", () => {
  it("list every proposal type once, and offer only fields a proposal of the type can lack", () => {
    expect([...POLICY_TYPES].sort()).toEqual([...ProposalTypeV2.options].sort());
    for (const type of POLICY_TYPES) {
      const offered = ALWAYS_REVIEW_COPY[type].map((entry) => entry.field);
      for (const field of offered) expect(PROPOSAL_TYPE_FIELDS[type]).toContain(field);
    }
    // A type's main field is on every proposal of it: holding it back would approve nothing. A deal
    // update has none: each of its fields may be left out.
    for (const type of ["note", "task", "contact", "commitment", "meeting"] as const) {
      const offered = ALWAYS_REVIEW_COPY[type].map((entry) => entry.field);
      expect(offered).not.toContain(PROPOSAL_TYPE_FIELDS[type][0]);
    }
    expect(ALWAYS_REVIEW_COPY.deal_update.map((entry) => entry.field)).toEqual([
      ...PROPOSAL_TYPE_FIELDS.deal_update,
    ]);
  });

  it("make no rules when everything's off, and rules the writer accepts when things are on", () => {
    const none = choicesFrom(null);
    expect(rulesFrom(none)).toEqual({ v: 1, autoApprove: [] });
    const on = {
      ...none,
      note: { ...none.note, on: true },
      deal_update: { ...none.deal_update, on: true, alwaysReview: ["amount", "stage"] },
    };
    const rules = rulesFrom(on);
    expect(rules).toEqual({
      v: 1,
      autoApprove: [
        { id: "notes", type: "note", alwaysReview: [] },
        // The type's own field order, whatever order they were ticked in.
        { id: "deal-updates", type: "deal_update", alwaysReview: ["stage", "amount"] },
      ],
    });
    expect(checkPolicyRules(rules)).toEqual({ ok: true });
    // And back again.
    expect(rulesFrom(choicesFrom(rules))).toEqual(rules);
  });

  it("keep a rule's id from the policy, and every type on makes a valid policy", () => {
    const stored: ApprovalPolicyRules = {
      v: 1,
      autoApprove: [{ id: "deal-dates", type: "deal_update", alwaysReview: ["amount"] }],
    };
    expect(rulesFrom(choicesFrom(stored)).autoApprove[0]?.id).toBe("deal-dates");
    const all = choicesFrom(null);
    const everything = Object.fromEntries(
      POLICY_TYPES.map((type) => [
        type,
        { ...all[type], on: true, alwaysReview: ALWAYS_REVIEW_COPY[type].map((e) => e.field) },
      ]),
    ) as unknown as typeof all;
    const rules = rulesFrom(everything);
    expect(rules.autoApprove.map((rule) => rule.id)).toEqual(POLICY_TYPES.map((t) => RULE_IDS[t]));
    expect(checkPolicyRules(rules)).toEqual({ ok: true });
  });

  it("say who changed the policy", () => {
    expect(changedBy("u-1", "u-1", null)).toBe("you");
    expect(changedBy("u-2", "u-1", "Bo Baker")).toBe("Bo Baker");
    expect(changedBy("u-2", "u-1", null)).toBe("another member");
    expect(changedBy(null, "u-1", null)).toBe("a former member");
  });
});

describe("Reviewed's line for an auto-approval", () => {
  const proposal = (review: Partial<NonNullable<InboxProposal["review"]>> | null) =>
    ({ status: "approved", review }) as unknown as InboxProposal;

  it("names the rule that approved it", () => {
    expect(ruleWords("deal-updates")).toBe("deal updates");
    expect(
      decisionWords(proposal({ mode: "policy", policy: { id: "p", version: 2, rule: "notes" } })),
    ).toBe("Approved by your policy: notes");
    expect(
      decisionWords(
        proposal({ mode: "policy", policy: { id: "p", version: 2, rule: "deal-updates" } }),
      ),
    ).toBe("Approved by your policy: deal updates");
    // A row read before it carried the policy says so without the rule.
    expect(decisionWords(proposal({ mode: "policy" }))).toBe("Approved by your policy");
    expect(decisionWords(proposal({ mode: "single", policy: null }))).toBe("Accepted");
  });
});
