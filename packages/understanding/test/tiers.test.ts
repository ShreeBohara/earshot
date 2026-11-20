// The likely-edit tiers (Phase 5 spec §4.4, WP4): every flag kind's tier, a value the normalizers
// fixed or didn't, a new record with and without a sound-alike, a downgraded target, the name
// note, and a lone self-correction, which marks nothing. The evals measure the tiers on the 200
// debriefs (@earshot/evals, test/understanding.test.ts).
import { describe, expect, it } from "vitest";
import {
  LOUD_ORDER,
  QUIET_ORDER,
  type RiskKind,
  SOUND_ALIKE_MIN_P,
  type TierFlag,
  type TierProposal,
  tierOf,
  tierWith,
} from "../src/tiers";

/** A linked target by an exact name, with nothing on it: unmarked until a flag says otherwise. */
const LINKED: TierProposal["target"] = {
  decision: "linked",
  basis: "exact",
  candidates: [{ entityId: "co_1", p: 0.99 }],
};

function proposal(
  flags: readonly TierFlag[],
  target: Partial<TierProposal["target"]> = {},
  fields: TierProposal["fields"] = { dueDate: {} },
): TierProposal {
  return { riskFlags: flags, target: { ...LINKED, ...target }, fields };
}

const flag = (kind: RiskKind, field?: string): TierFlag =>
  field === undefined ? { kind } : { kind, field };

describe("tierOf, one flag at a time", () => {
  it.each<[RiskKind, string | undefined, "loud" | "quiet" | "none", string | null]>([
    ["witness_conflict", "target", "loud", "witness_conflict"],
    ["witness_conflict", "name", "loud", "witness_conflict"],
    ["ambiguous_target", "target", "loud", "ask"],
    ["unsupported", "target", "loud", "unsupported"],
    ["unsupported", "dueDate", "loud", "unsupported"],
    ["ambiguous_value", "dueDate", "loud", "ambiguous_value"],
    // No `norm.llmValue`: nothing replaced the model's value, so it stands, loud.
    ["value_mismatch", "dueDate", "loud", "value_mismatch"],
    ["implied_target", "target", "quiet", "implied_target"],
    ["negation", "dueDate", "quiet", "negation"],
    ["low_confidence", "dueDate", "quiet", "low_confidence"],
    ["weak_support", "body", "quiet", "weak_support"],
    // No candidate record at all: nothing in the CRM sounds like it.
    ["new_entity", "target", "quiet", "new_entity"],
    ["date", "dueDate", "quiet", "date"],
    ["number", "amount", "quiet", "number"],
    ["number", undefined, "quiet", "number"],
    ["self_correction", "dueDate", "none", null],
  ])("%s on %s is %s (%s)", (kind, field, tier, reason) => {
    const target = kind === "new_entity" ? { decision: "new" as const, candidates: [] } : {};
    const result = tierOf(proposal([flag(kind, field)], target));
    expect(result.tier).toBe(tier);
    expect(result.reasons.map((r) => r.kind)).toEqual(reason === null ? [] : [reason]);
    expect(result.nameNote).toBeNull();
  });

  it("gives every kind the contract has a tier, and throws on none", () => {
    const kinds: RiskKind[] = [
      "date",
      "number",
      "negation",
      "low_confidence",
      "unsupported",
      "new_entity",
      "witness_conflict",
      "link_uncertain",
      "ambiguous_target",
      "implied_target",
      "value_mismatch",
      "ambiguous_value",
      "self_correction",
      "weak_support",
    ];
    for (const kind of kinds) expect(() => tierOf(proposal([flag(kind, "target")]))).not.toThrow();
  });

  it("marks nothing without a flag", () => {
    expect(tierOf(proposal([]))).toEqual({ tier: "none", reasons: [], nameNote: null });
  });
});

describe("a value that disagrees with its words", () => {
  it("is quiet once a unique reading replaced it, and loud while it stands", () => {
    const fixed = tierOf(
      proposal([flag("value_mismatch", "dueDate")], {}, { dueDate: { norm: { llmValue: "x" } } }),
    );
    expect(fixed).toEqual({
      tier: "quiet",
      reasons: [{ tier: "quiet", kind: "value_corrected", field: "dueDate" }],
      nameNote: null,
    });
    // A null model value is still a value the reading replaced.
    expect(
      tierOf(
        proposal(
          [flag("value_mismatch", "dueDate")],
          {},
          { dueDate: { norm: { llmValue: null } } },
        ),
      ).tier,
    ).toBe("quiet");
    // Readings with no replacement (an ambiguous quote the model got wrong), or no norm at all.
    const standing: TierProposal["fields"][] = [
      { dueDate: { norm: { readings: ["a", "b"] } } },
      { dueDate: {} },
      {},
    ];
    for (const fields of standing) {
      expect(tierOf(proposal([flag("value_mismatch", "dueDate")], {}, fields)).tier).toBe("loud");
    }
  });

  it("is loud when the model kept the value the rep took back, and unmarked when it took the correction", () => {
    const kept = tierOf(
      proposal([flag("self_correction", "dueDate"), flag("value_mismatch", "dueDate")]),
    );
    expect(kept.tier).toBe("loud");
    expect(kept.reasons).toEqual([{ tier: "loud", kind: "value_mismatch", field: "dueDate" }]);
    expect(tierOf(proposal([flag("self_correction", "dueDate")])).tier).toBe("none");
  });

  it("reads the fix on the flag's own field", () => {
    const result = tierOf(
      proposal(
        [flag("value_mismatch", "closeDate")],
        {},
        { dueDate: { norm: { llmValue: "x" } }, closeDate: {} },
      ),
    );
    expect(result.reasons).toEqual([{ tier: "loud", kind: "value_mismatch", field: "closeDate" }]);
  });
});

describe("a new record", () => {
  const isNew = (candidates: TierProposal["target"]["candidates"]) =>
    tierOf(proposal([flag("new_entity", "target")], { decision: "new", basis: null, candidates }));

  it("is loud with a sound-alike record at p ≥ 0.05 (the tray's ASK_MIN_P), quiet without", () => {
    expect(SOUND_ALIKE_MIN_P).toBe(0.05);
    expect(
      isNew([
        { entityId: null, p: 0.9 },
        { entityId: "co_7", p: 0.05 },
      ]).reasons,
    ).toEqual([{ tier: "loud", kind: "new_sound_alike", field: "target" }]);
    expect(
      isNew([
        { entityId: null, p: 0.96 },
        { entityId: "co_7", p: 0.0499 },
      ]).reasons,
    ).toEqual([{ tier: "quiet", kind: "new_entity", field: "target" }]);
    // The new record's own candidate is no sound-alike, however likely.
    expect(isNew([{ entityId: null, p: 1 }]).tier).toBe("quiet");
  });

  it("can take a higher bar through tierWith, the evals' what-if", () => {
    const target = {
      decision: "new" as const,
      basis: null,
      candidates: [
        { entityId: null, p: 0.85 },
        { entityId: "co_7", p: 0.15 },
      ],
    };
    const at = (soundAlikeMinP: number) =>
      tierWith(proposal([flag("new_entity", "target")], target), { soundAlikeMinP }).tier;
    expect(at(0.05)).toBe("loud");
    expect(at(0.2)).toBe("quiet");
  });
});

describe("the target", () => {
  const candidates = [
    { entityId: "co_1", p: 0.6 },
    { entityId: "co_2", p: 0.3 },
    { entityId: null, p: 0.1 },
  ];

  it("is loud as the linker's question", () => {
    const result = tierOf(
      proposal([flag("ambiguous_target", "target")], { decision: "ask", basis: null, candidates }),
    );
    expect(result).toEqual({
      tier: "loud",
      reasons: [{ tier: "loud", kind: "ask", field: "target" }],
      nameNote: null,
    });
  });

  it("is loud as a question even with no flag saying so", () => {
    const result = tierOf(proposal([], { decision: "ask", basis: null, candidates }));
    expect(result.reasons).toEqual([{ tier: "loud", kind: "ask", field: "target" }]);
  });

  it("is loud for its conflict once the witness downgraded it, and loses its name note", () => {
    // Linked by sound, then the second witness heard another name: the flags it had, the
    // conflict, and a question in place of the link.
    const result = tierOf(
      proposal([flag("link_uncertain", "target"), flag("witness_conflict", "target")], {
        decision: "ask",
        basis: "sound",
        candidates,
      }),
    );
    expect(result).toEqual({
      tier: "loud",
      reasons: [{ tier: "loud", kind: "witness_conflict", field: "target" }],
      nameNote: null,
    });
  });

  it("puts a linker question the witness also doubted after the conflict", () => {
    const result = tierOf(
      proposal([flag("ambiguous_target", "target"), flag("witness_conflict", "target")], {
        decision: "ask",
        basis: null,
        candidates,
      }),
    );
    expect(result.reasons.map((r) => r.kind)).toEqual(["witness_conflict", "ask"]);
  });
});

describe("the name note (ADR-0031's option 2)", () => {
  it("says how an uncertain link was made, beside the name, and makes the card quiet alone", () => {
    for (const [basis, note] of [
      ["sound", "sound"],
      ["context", "context"],
    ] as const) {
      expect(tierOf(proposal([flag("link_uncertain", "target")], { basis }))).toEqual({
        tier: "quiet",
        reasons: [],
        nameNote: note,
      });
    }
  });

  it("rides beside other markers without counting as a card note", () => {
    const quiet = tierOf(
      proposal([flag("link_uncertain", "target"), flag("negation", "dueDate")], {
        basis: "context",
      }),
    );
    expect(quiet).toEqual({
      tier: "quiet",
      reasons: [{ tier: "quiet", kind: "negation", field: "dueDate" }],
      nameNote: "context",
    });
    const loud = tierOf(
      proposal([flag("link_uncertain", "target"), flag("ambiguous_value", "dueDate")], {
        basis: "sound",
      }),
    );
    expect(loud.tier).toBe("loud");
    expect(loud.nameNote).toBe("sound");
  });
});

describe("the reasons", () => {
  it("come loud first, each tier in its order, and once each", () => {
    const result = tierOf(
      proposal(
        [
          flag("negation", "title"),
          flag("value_mismatch", "dueDate"),
          flag("implied_target", "target"),
          flag("unsupported", "title"),
          flag("ambiguous_value", "dueDate"),
          flag("witness_conflict", "target"),
          flag("negation", "title"),
          flag("unsupported", "target"),
        ],
        { decision: "ask", basis: null, candidates: [] },
      ),
    );
    expect(result.reasons).toEqual([
      { tier: "loud", kind: "witness_conflict", field: "target" },
      { tier: "loud", kind: "unsupported", field: "title" },
      { tier: "loud", kind: "unsupported", field: "target" },
      { tier: "loud", kind: "ambiguous_value", field: "dueDate" },
      { tier: "loud", kind: "value_mismatch", field: "dueDate" },
      { tier: "quiet", kind: "implied_target", field: "target" },
      { tier: "quiet", kind: "negation", field: "title" },
    ]);
    expect(new Set(LOUD_ORDER).size).toBe(LOUD_ORDER.length);
    expect(new Set(QUIET_ORDER).size).toBe(QUIET_ORDER.length);
  });

  it("are a pure function of the proposal", () => {
    const input = proposal([flag("negation", "title"), flag("witness_conflict", "target")]);
    const copy = structuredClone(input);
    expect(tierOf(input)).toEqual(tierOf(copy));
    expect(input).toEqual(copy);
  });
});
