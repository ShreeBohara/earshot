import type { ApprovalPolicyRules } from "@earshot/core";
import { tierOf } from "@earshot/understanding/tiers";
import { describe, expect, it } from "vitest";
import { type ProposalView, policyRuleFor, proposalsProjection, replay } from "../src";
import { anyFlagTier, type EventBody, proposalV2, sessionLog, started, utterance } from "./helpers";

// `policyRuleFor` (Phase 5 spec §4.6, WP11): which rule approves a proposal at its creation. The
// rules' own logic runs with a stand-in tier (any flag marks a card); the evaluation table at the
// end runs with `tierOf` itself, the one SessionDO passes, where quiet notes and the name note
// mark a card too.

const unflagged = { riskFlags: [] };

function folded(...bodies: EventBody[]): readonly ProposalView[] {
  return replay(sessionLog([started(), utterance(1), ...bodies]), {
    proposals: proposalsProjection,
  }).proposals;
}

function only(...bodies: EventBody[]): ProposalView {
  const proposals = folded(...bodies);
  const last = proposals.at(-1);
  if (!last) throw new Error("no proposal");
  return last;
}

const NOTES: ApprovalPolicyRules = {
  v: 1,
  autoApprove: [{ id: "notes", type: "note", alwaysReview: [] }],
};

const DEALS: ApprovalPolicyRules = {
  v: 1,
  autoApprove: [{ id: "deal-updates", type: "deal_update", alwaysReview: ["amount", "stage"] }],
};

const ctx = { tierOf: anyFlagTier };

function note(overrides: Record<string, unknown> = {}, target: Record<string, unknown> = {}) {
  return proposalV2(1, target, { type: "note", ...unflagged, ...overrides });
}

function deal(fields: Record<string, unknown>) {
  const evidence = {
    utteranceId: "00000000-0000-7000-8000-0000000007d1",
    span: [0, 4],
    audioMs: [1000, 1200],
    confidence: 0.9,
  };
  return proposalV2(
    1,
    { kind: "deal" },
    {
      type: "deal_update",
      ...unflagged,
      fields: Object.fromEntries(
        Object.entries(fields).map(([name, value]) => [name, { value, evidence }]),
      ),
    },
  );
}

describe("policyRuleFor", () => {
  it("approves an unmarked, linked proposal of a type a rule names, by that rule", () => {
    expect(policyRuleFor(only(note()), NOTES, ctx)).toEqual({
      ok: true,
      rule: { id: "notes", type: "note", alwaysReview: [] },
    });
  });

  it("never approves a marked proposal", () => {
    const flagged = note({ riskFlags: [{ kind: "negation", field: "title" }] });
    expect(policyRuleFor(only(flagged), NOTES, ctx)).toEqual({ ok: false, reason: "marked" });
  });

  it("never approves a proposal whose record isn't linked: a question, a new record, or none", () => {
    const asks = note(
      {},
      {
        decision: "ask",
        entityId: null,
        candidates: [
          { entityId: "00000000-0000-7000-8000-000000001771", p: 0.5 },
          { entityId: null, p: 0.5 },
        ],
      },
    );
    const fresh = note({}, { decision: "new", entityId: null, basis: null, candidates: [] });
    const none = note(
      {},
      {
        decision: "none",
        entityId: null,
        basis: null,
        p: null,
        mention: null,
        candidates: [],
      },
    );
    for (const body of [asks, fresh, none]) {
      // Unmarked here, so only the target keeps it back (the real tiers mark the question too).
      expect(policyRuleFor(only(body), NOTES, ctx)).toEqual({ ok: false, reason: "not_linked" });
    }
  });

  it("never approves a superseding proposal", () => {
    const corrected = proposalV2(
      2,
      {},
      {
        type: "note",
        ...unflagged,
        supersedes: "00000000-0000-7000-8000-000000000bb9",
      },
    );
    const proposals = folded(note(), corrected);
    expect(policyRuleFor(proposals[1] as ProposalView, NOTES, ctx)).toEqual({
      ok: false,
      reason: "supersedes",
    });
  });

  it("approves nothing of a type no rule names", () => {
    expect(policyRuleFor(only(proposalV2(1, {}, unflagged)), NOTES, ctx)).toEqual({
      ok: false,
      reason: "no_rule",
    });
    expect(policyRuleFor(only(note()), { v: 1, autoApprove: [] }, ctx)).toEqual({
      ok: false,
      reason: "no_rule",
    });
  });

  it("holds back a proposal carrying any alwaysReview field, and only one carrying it", () => {
    expect(policyRuleFor(only(deal({ amount: 48_000 })), DEALS, ctx)).toEqual({
      ok: false,
      reason: "always_review",
    });
    expect(
      policyRuleFor(only(deal({ stage: "negotiation", closeDate: "2027-03-31" })), DEALS, ctx),
    ).toEqual({ ok: false, reason: "always_review" });
    // A field the model left out isn't on the proposal, so it holds nothing back.
    expect(policyRuleFor(only(deal({ closeDate: "2027-03-31" })), DEALS, ctx)).toMatchObject({
      ok: true,
      rule: { id: "deal-updates" },
    });
  });

  it("takes the first rule that matches", () => {
    const two: ApprovalPolicyRules = {
      v: 1,
      autoApprove: [
        { id: "deals-without-amounts", type: "deal_update", alwaysReview: ["amount"] },
        { id: "deals-without-stages", type: "deal_update", alwaysReview: ["stage"] },
      ],
    };
    // Both match a deal with neither field: the first wins.
    expect(policyRuleFor(only(deal({ closeDate: "2027-03-31" })), two, ctx)).toMatchObject({
      ok: true,
      rule: { id: "deals-without-amounts" },
    });
    // The first holds back an amount, so the second approves it, and names itself.
    expect(policyRuleFor(only(deal({ amount: 48_000 })), two, ctx)).toMatchObject({
      ok: true,
      rule: { id: "deals-without-stages" },
    });
    expect(policyRuleFor(only(deal({ amount: 48_000, stage: "proposal" })), two, ctx)).toEqual({
      ok: false,
      reason: "always_review",
    });
  });

  it("reads only the proposal's own fields, never a name on Object's prototype", () => {
    const tricky: ApprovalPolicyRules = {
      v: 1,
      autoApprove: [{ id: "notes", type: "note", alwaysReview: ["constructor", "toString"] }],
    };
    expect(policyRuleFor(only(note()), tricky, ctx)).toMatchObject({ ok: true });
  });
});

// ─── The evaluation table, with the tiers every writer uses ─────────────────────────────────────

describe("the evaluation table, with tierOf (spec §4.6)", () => {
  const real = { tierOf };
  const flag = (kind: string, field = "target") => ({ kind, field });
  const sound = { basis: "sound", p: 0.91 };
  const exact = { basis: "exact", p: 0.99 };

  it.each([
    ["unmarked, linked by its exact name", note({}, exact), { ok: true }],
    [
      "a lone self-correction the model took (unmarked)",
      note({ riskFlags: [flag("self_correction", "body")] }, exact),
      { ok: true },
    ],
    [
      "the name note: linked by sound, below certainty",
      note({ riskFlags: [flag("link_uncertain")] }, sound),
      { ok: false, reason: "marked" },
    ],
    [
      "the name note: linked in context",
      note({ riskFlags: [flag("link_uncertain")] }, { basis: "context" }),
      { ok: false, reason: "marked" },
    ],
    [
      "a quiet note: the open account assumed",
      note({ riskFlags: [flag("implied_target")] }, { basis: "focus", mention: null, p: null }),
      { ok: false, reason: "marked" },
    ],
    [
      "a quiet note: said in a negation",
      note({ riskFlags: [flag("negation", "body")] }, exact),
      { ok: false, reason: "marked" },
    ],
    [
      "loud: the witnesses disagree",
      note({ riskFlags: [flag("witness_conflict")] }, exact),
      { ok: false, reason: "marked" },
    ],
    [
      "loud: words not in the transcript",
      note({ riskFlags: [flag("unsupported", "body")] }, exact),
      { ok: false, reason: "marked" },
    ],
    [
      "loud: the linker asked",
      note(
        { riskFlags: [flag("ambiguous_target")] },
        {
          decision: "ask",
          entityId: null,
          basis: null,
          candidates: [
            { entityId: "00000000-0000-7000-8000-000000001771", p: 0.5 },
            { entityId: "00000000-0000-7000-8000-000000001772", p: 0.4 },
          ],
        },
      ),
      { ok: false, reason: "marked" },
    ],
    [
      "a new-record target, nothing like it in the CRM (quiet)",
      note(
        { riskFlags: [flag("new_entity")] },
        { decision: "new", entityId: null, basis: null, candidates: [{ entityId: null, p: 0.9 }] },
      ),
      { ok: false, reason: "marked" },
    ],
    [
      "a new-record target, with a sound-alike (loud)",
      note(
        { riskFlags: [flag("new_entity")] },
        {
          decision: "new",
          entityId: null,
          basis: null,
          candidates: [
            { entityId: null, p: 0.7 },
            { entityId: "00000000-0000-7000-8000-000000001773", p: 0.2 },
          ],
        },
      ),
      { ok: false, reason: "marked" },
    ],
    [
      "a new-record target, even unflagged",
      note({}, { decision: "new", entityId: null, basis: null, candidates: [] }),
      { ok: false, reason: "not_linked" },
    ],
  ] as const)("%s", (_label, body, expected) => {
    expect(policyRuleFor(only(body), NOTES, real)).toMatchObject(expected);
  });

  it("holds back an alwaysReview field, and approves the same deal update without it", () => {
    expect(policyRuleFor(only(deal({ stage: "negotiation" })), DEALS, real)).toEqual({
      ok: false,
      reason: "always_review",
    });
    expect(policyRuleFor(only(deal({ closeDate: "2027-03-31" })), DEALS, real)).toMatchObject({
      ok: true,
      rule: { id: "deal-updates" },
    });
  });

  it("never approves a superseding proposal, unmarked and linked as it is", () => {
    const corrected = proposalV2(2, exact, {
      type: "note",
      ...unflagged,
      supersedes: "00000000-0000-7000-8000-000000000bb9",
    });
    const proposals = folded(note({}, exact), corrected);
    expect(policyRuleFor(proposals[1] as ProposalView, NOTES, real)).toEqual({
      ok: false,
      reason: "supersedes",
    });
  });
});
