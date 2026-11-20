// The likely-edit tiers' metrics and budgets (Phase 5 spec §4.4, WP4): `tierOf` restates the
// contract's kinds exactly, the ground truth's "needs a change" reads as the spec says, the shares,
// precision, surfacing, and hidden wrong accounts add up on hand-built proposals, and the gate's
// budgets fail where they should on synthetic reports. The run over all 200 debriefs is in
// understanding.test.ts; `tierOf`'s own tables are in @earshot/understanding.
import type {
  LikelyEditTier as CoreLikelyEditTier,
  ProposalCreatedV2,
  RiskFlagV2,
  RiskKindV2,
} from "@earshot/core";
import type {
  LikelyEditTier,
  RiskKind,
  TierFlag,
  TierProposal,
} from "@earshot/understanding/tiers";
import { describe, expect, it } from "vitest";
import type { ExpectedProposal } from "../src/schema";
import {
  LOUD_SHARE_INTERIM_CEILING,
  LOUD_SHARE_TARGET,
  MARKED_SHARE_BUDGET,
  needsChange,
  type Ratio,
  SURFACING_RECALL_BUDGET,
  type TierMetrics,
  tierMetrics,
  UNDERSTANDING_GATE,
  type UnderstandingMetrics,
  understandingGateFailures,
  understandingMetrics,
} from "../src/understanding";

// @earshot/understanding restates the contract shapes it reads instead of importing @earshot/core
// (whose session tickets need Web Crypto types a DOM-free program lacks). This fails to compile if
// they drift apart: a new risk kind can't arrive without a tier.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Within<A, B> = [A] extends [B] ? true : false;
const CONTRACTS_AGREE: [
  Same<RiskKind, RiskKindV2>,
  Same<LikelyEditTier, CoreLikelyEditTier>,
  Within<RiskFlagV2, TierFlag>,
  Within<ProposalCreatedV2, TierProposal>,
] = [true, true, true, true];

describe("the tiers' types", () => {
  it("restate the contracts' exactly", () => {
    expect(CONTRACTS_AGREE).toEqual([true, true, true, true]);
  });
});

const ID = (n: number) => `01a1c6e9-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const EVIDENCE = {
  utteranceId: ID(900),
  span: [0, 4] as [number, number],
  audioMs: [0, 100] as [number, number],
  confidence: 0.95,
};

function final(
  target: Partial<ProposalCreatedV2["target"]>,
  flags: ProposalCreatedV2["riskFlags"] = [],
  fields: Record<string, string | number> = { title: "Send the quote", dueDate: "2026-11-20" },
): ProposalCreatedV2 {
  return {
    proposalId: ID(1),
    type: "task",
    target: {
      decision: "linked",
      entityId: "ct_045",
      kind: "contact",
      basis: "exact",
      p: 0.99,
      mention: null,
      company: null,
      candidates: [{ entityId: "ct_045", p: 0.99 }],
      ...target,
    },
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [name, { value, evidence: EVIDENCE }]),
    ),
    riskFlags: flags,
    supersedes: null,
    linker: "linker.v1",
  };
}

function expected(
  target: ExpectedProposal["target"],
  dueDate: string | undefined = "2026-11-20",
): ExpectedProposal {
  return {
    type: "task",
    target,
    fields: {
      title: { value: "Send the quote", quote: "the quote" },
      ...(dueDate === undefined ? {} : { dueDate: { value: dueDate, quote: "by Friday" } }),
    },
  } as ExpectedProposal;
}

describe("needsChange: what the ground truth says a reviewer must do", () => {
  const linkedTruth = expected({ id: "ct_045", decision: "linked" });
  const question = {
    decision: "ask" as const,
    entityId: null,
    candidates: [
      { entityId: "ct_045", p: 0.55 },
      { entityId: null, p: 0.45 },
    ],
  };

  it.each<[string, ExpectedProposal | undefined, ProposalCreatedV2, boolean]>([
    ["a right link, as proposed", linkedTruth, final({}), false],
    ["an extra proposal (a rejection)", undefined, final({}), true],
    ["a wrong account", linkedTruth, final({ entityId: "ct_046" }), true],
    [
      "no record where one was meant",
      linkedTruth,
      final({ decision: "none", entityId: null }),
      true,
    ],
    [
      "a new record where one exists",
      linkedTruth,
      final({ decision: "new", entityId: null }),
      true,
    ],
    // A false alarm: the question offers the record the ground truth names outright.
    ["a question offering the record meant", linkedTruth, final(question), false],
    [
      "a question that doesn't offer the record meant",
      linkedTruth,
      final({ ...question, candidates: [{ entityId: "ct_046", p: 1 }] }),
      true,
    ],
    [
      "a question the ground truth asks too (a snapped new name)",
      expected({ id: null, decision: "ask" }),
      final(question),
      true,
    ],
    [
      "a link where the ground truth asks",
      expected({ id: "ct_045", decision: "ask" }),
      final({}),
      true,
    ],
    [
      "a new record, as the ground truth says",
      expected({ id: null, decision: "new" }),
      final({ decision: "new", entityId: null }),
      false,
    ],
    [
      "a link where the ground truth says new",
      expected({ id: null, decision: "new" }),
      final({}),
      true,
    ],
    [
      "no record, as the ground truth says",
      expected({ id: null, decision: "none" }),
      final({ decision: "none", entityId: null }),
      false,
    ],
    [
      "a wrong due date (an edit)",
      linkedTruth,
      final({}, [], { title: "Send the quote", dueDate: "2026-11-27" }),
      true,
    ],
    ["a missing field (an edit)", linkedTruth, final({}, [], { title: "Send the quote" }), true],
    [
      "a field the truth doesn't state",
      expected({ id: "ct_045", decision: "linked" }, undefined),
      final({}),
      false,
    ],
  ])("%s: %s", (_, truth, proposal, needs) => {
    expect(needsChange(truth, proposal)).toBe(needs);
  });
});

const r = (n: number, of: number): Ratio => ({ n, of, rate: of === 0 ? null : n / of });

describe("tierMetrics", () => {
  const truth = expected({ id: "ct_045", decision: "linked" });
  const items = [
    // Loud, needing a change: a wrong account the witness doubted.
    {
      proposal: final({ entityId: "ct_046" }, [{ kind: "witness_conflict", field: "name" }]),
      expected: truth,
    },
    // Loud, a false alarm: a question offering the record meant.
    {
      proposal: final(
        {
          decision: "ask",
          entityId: null,
          candidates: [
            { entityId: "ct_045", p: 0.6 },
            { entityId: "ct_046", p: 0.4 },
          ],
        },
        [{ kind: "ambiguous_target", field: "target" }],
      ),
      expected: truth,
    },
    // Quiet on the card, right as proposed.
    { proposal: final({}, [{ kind: "negation", field: "title" }]), expected: truth },
    // The name note alone, on a wrong account: surfaced, quietly.
    {
      proposal: final({ entityId: "ct_046", basis: "context", p: 0.93 }, [
        { kind: "link_uncertain", field: "target" },
      ]),
      expected: truth,
    },
    // Unmarked and wrong: the hidden wrong account.
    { proposal: final({ entityId: "ct_046" }), expected: truth },
    // Unmarked and right.
    { proposal: final({}), expected: truth },
  ];

  it("counts each tier's share, precision, the floor, and the wrong accounts no marker shows", () => {
    const metrics = tierMetrics(items, []);
    expect(metrics).toMatchObject({
      proposals: 6,
      loud: r(2, 6),
      marked: r(3, 6),
      nameNoteOnly: r(1, 6),
      loudFloor: r(2, 6),
      precision: { loud: r(1, 2), quiet: r(0, 1), nameNote: r(1, 1) },
      hiddenWrongAccounts: 1,
      surfacing: r(0, 0),
    } satisfies Partial<TierMetrics>);
    expect(metrics.loudKinds).toEqual({ witness_conflict: r(1, 1), ask: r(0, 1) });
    expect(metrics.quietKinds).toEqual({ negation: 1 });
  });

  it("counts a seeded error as surfaced when its proposal carries any marker, the name note included", () => {
    const [loud, , quiet, nameNote, unmarked] = items.map((item) => item.proposal);
    expect(tierMetrics([], [loud, quiet, nameNote, unmarked, undefined]).surfacing).toEqual(
      r(3, 5),
    );
  });
});

describe("the tiers' budgets in the gate", () => {
  // A report with nothing wrong but what each case sets.
  const clean = understandingMetrics([], {
    version: 1,
    seed: 1,
    rates: { wrong_date: 0, wrong_amount: 0, paraphrased_target: 0 },
    eligible: { wrong_date: 0, wrong_amount: 0, paraphrased_target: 0 },
    errors: [],
  });
  const covered: UnderstandingMetrics = {
    ...clean,
    evidence: { n: 10, of: 10, rate: 1, unquotedLinked: 0 },
  };
  const withTiers = (tiers: Partial<TierMetrics>): UnderstandingMetrics => ({
    ...covered,
    tiers: { ...covered.tiers, ...tiers },
  });

  it("holds the loud share to the interim ceiling, not the spec's 15%, while the floor is over it", () => {
    expect(UNDERSTANDING_GATE.maxLoudShare).toBe(LOUD_SHARE_INTERIM_CEILING);
    expect(LOUD_SHARE_TARGET).toBe(0.15);
    expect(LOUD_SHARE_INTERIM_CEILING).toBe(0.18);
    // 119 of 751, today's loud share, passes; so does exactly 18%.
    expect(understandingGateFailures("anthropic", withTiers({ loud: r(119, 751) }), null)).toEqual(
      [],
    );
    expect(understandingGateFailures("anthropic", withTiers({ loud: r(18, 100) }), null)).toEqual(
      [],
    );
    expect(
      understandingGateFailures(
        "anthropic",
        withTiers({ loud: r(136, 751), loudFloor: r(118, 751) }),
        null,
      ),
    ).toEqual([
      "anthropic: the loud share 18.1% (136/751) is over its interim ceiling of 18.0% (the spec's budget is 15.0%; asks, conflicts, and unsupported values alone are 15.7%)",
    ]);
  });

  it("fails a card marker on more than 35% of proposals", () => {
    expect(MARKED_SHARE_BUDGET).toBe(0.35);
    expect(understandingGateFailures("groq", withTiers({ marked: r(35, 100) }), null)).toEqual([]);
    expect(understandingGateFailures("groq", withTiers({ marked: r(36, 100) }), null)).toEqual([
      expect.stringContaining("the marked share 36.0% (36/100) is over 35.0%"),
    ]);
  });

  it("fails surfacing under 95% of the seeded errors", () => {
    expect(SURFACING_RECALL_BUDGET).toBe(0.95);
    expect(understandingGateFailures("groq", withTiers({ surfacing: r(38, 40) }), null)).toEqual(
      [],
    );
    expect(understandingGateFailures("groq", withTiers({ surfacing: r(37, 40) }), null)).toEqual([
      expect.stringContaining("surfacing recall 92.5% (37/40 seeded errors marked) is under 95.0%"),
    ]);
  });

  it("doesn't gate a share with nothing to divide", () => {
    expect(covered.tiers.loud.rate).toBeNull();
    expect(covered.tiers.surfacing.rate).toBeNull();
    expect(understandingGateFailures("anthropic", covered, null)).toEqual([]);
  });

  it("reports every budget it breaks at once", () => {
    const failures = understandingGateFailures(
      "anthropic",
      withTiers({ loud: r(30, 100), marked: r(50, 100), surfacing: r(30, 40) }),
      null,
    );
    expect(failures).toHaveLength(3);
  });
});
