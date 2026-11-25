// The follow-up rules (Phase 5 spec WP13 step 3): a task or commitment with no due date, a meeting
// with no date, a deal update with a stage and no amount; at most two a turn, none on a loud card.
import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_TEXT,
  type FollowupProposal,
  followupRuleFor,
  followupsFor,
  MAX_FOLLOWUPS_PER_TURN,
} from "../src/followups";

const LINKED = { decision: "linked", basis: "exact", candidates: [] } as const;

function proposal(
  id: string,
  type: string,
  fields: Record<string, unknown>,
  extra: Partial<FollowupProposal> = {},
): FollowupProposal {
  return {
    proposalId: id,
    type,
    riskFlags: [],
    target: LINKED,
    fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, { value }])),
    ...extra,
  };
}

describe("followupRuleFor", () => {
  it.each([
    ["task", { title: "Send the deck" }, { field: "dueDate", rule: "due_date" }],
    ["task", { title: "Send the deck", dueDate: "2026-11-20" }, null],
    ["commitment", { text: "Run a workshop" }, { field: "dueDate", rule: "due_date" }],
    [
      "meeting",
      { title: "Pricing review", time: "15:00" },
      { field: "date", rule: "meeting_date" },
    ],
    ["meeting", { title: "Pricing review", date: "2026-11-24" }, null],
    ["deal_update", { stage: "Negotiation" }, { field: "amount", rule: "deal_amount" }],
    ["deal_update", { stage: "Negotiation", amount: 50_000 }, null],
    // No stage: nothing moved, so nothing to price.
    ["deal_update", { closeDate: "2026-12-31" }, null],
    ["note", { body: "Pilot is going well." }, null],
    ["contact", { name: "Dana Lee" }, null],
  ])("a %s with %o asks %o", (type, fields, expected) => {
    expect(followupRuleFor(proposal("p", type, fields))).toEqual(expected);
  });

  it("counts a null or blank value as missing", () => {
    expect(followupRuleFor(proposal("p", "task", { title: "x", dueDate: null }))).toMatchObject({
      rule: "due_date",
    });
    expect(followupRuleFor(proposal("p", "task", { title: "x", dueDate: "  " }))).toMatchObject({
      rule: "due_date",
    });
    expect(followupRuleFor(proposal("p", "deal_update", { stage: "" }))).toBeNull();
  });
});

describe("followupsFor", () => {
  it("asks each rule's question, in the turn's order", () => {
    expect(
      followupsFor([
        proposal("note", "note", { body: "Going well." }),
        proposal("deal", "deal_update", { stage: "Proposal" }),
        proposal("task", "task", { title: "Send the deck" }),
      ]),
    ).toEqual([
      { proposalId: "deal", field: "amount", rule: "deal_amount", text: "What's the amount?" },
      { proposalId: "task", field: "dueDate", rule: "due_date", text: "When is it due?" },
    ]);
    expect(FOLLOWUP_TEXT.meeting_date).toBe("When is the meeting?");
  });

  it("asks at most two a turn", () => {
    expect(MAX_FOLLOWUPS_PER_TURN).toBe(2);
    const tasks = ["a", "b", "c"].map((id) => proposal(id, "task", { title: "Call" }));
    expect(followupsFor(tasks).map((question) => question.proposalId)).toEqual(["a", "b"]);
  });

  it("asks nothing about a loud card, and still asks about a quiet one", () => {
    const loud = proposal(
      "ask",
      "task",
      { title: "Call" },
      {
        riskFlags: [{ kind: "ambiguous_target", field: "target" }],
        target: { decision: "ask", basis: null, candidates: [] },
      },
    );
    const quiet = proposal(
      "quiet",
      "task",
      { title: "Call" },
      { riskFlags: [{ kind: "link_uncertain", field: "target" }], target: LINKED },
    );
    expect(followupsFor([loud, quiet]).map((question) => question.proposalId)).toEqual(["quiet"]);
  });

  it("asks nothing about a proposal a policy approved in its turn", () => {
    const approved = proposal("p", "task", { title: "Call" }, { status: "approved" });
    expect(followupsFor([approved])).toEqual([]);
    const open = proposal("p", "task", { title: "Call" }, { status: "proposed" });
    expect(followupsFor([open])).toHaveLength(1);
  });
});
