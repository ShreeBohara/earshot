// First-person copy and quiet notes (Phase 5 spec decision 9, §4.4, WP4): every loud reason has a
// template, the lines read as the spec's examples, no quiet or unmarked card ever gets one, and
// the quiet notes and the name note say what they show.
import type { Evidence, ProposalFieldV2, TargetV2, WitnessConflict } from "@earshot/core";
import {
  LOUD_ORDER,
  QUIET_ORDER,
  type QuietReasonKind,
  tierOf,
} from "@earshot/understanding/tiers";
import { describe, expect, it } from "vitest";
import { NAME_NOTES, QUIET_NOTES, quietNote, spokenValue } from "@/lib/capture/copy";
import {
  firstPersonLine,
  LOUD_TEMPLATE_KINDS,
  loudDescription,
  relinkLine,
  type VoiceContext,
  type VoiceProposal,
} from "@/lib/inbox/voice";

const UTTERANCE = "01a1c6e2-0000-7000-8000-000000000001";
const SAID = "Ask Dana Lee about the deck by next Friday, sorry, March 4th, not March 6th.";

function evidence(words: string): Evidence {
  const start = SAID.indexOf(words);
  if (start < 0) throw new Error(`"${words}" isn't said`);
  return {
    utteranceId: UTTERANCE,
    span: [start, start + words.length],
    audioMs: [0, 100],
    confidence: 0.9,
  };
}

const NAMES: Record<string, string> = {
  co_1: "Acme Dynamics",
  co_2: "Akme Dynamics",
  co_3: "Atmos Industrial",
  ct_1: "Dana Lee",
};

const ctx: VoiceContext = {
  nameOf: (id) => NAMES[id] ?? "A CRM record",
  heard: (e) => (e.utteranceId === UTTERANCE ? SAID.slice(e.span[0], e.span[1]) : undefined),
};

const LINKED: TargetV2 = {
  decision: "linked",
  entityId: "co_1",
  kind: "company",
  basis: "exact",
  p: 0.99,
  mention: { quote: "Acme", evidence: evidence("Ask") },
  company: null,
  candidates: [{ entityId: "co_1", p: 0.99 }],
};

function proposal(
  riskFlags: VoiceProposal["riskFlags"],
  target: Partial<TargetV2> = {},
  fields: Record<string, ProposalFieldV2> = {},
  conflicts: WitnessConflict[] = [],
): VoiceProposal {
  return { type: "task", target: { ...LINKED, ...target }, fields, riskFlags, conflicts };
}

const lineOf = (p: VoiceProposal) => firstPersonLine(p, tierOf(p), ctx);

const ASK = {
  decision: "ask" as const,
  entityId: null,
  basis: null,
  candidates: [
    { entityId: "co_1", p: 0.55 },
    { entityId: "co_2", p: 0.4 },
    { entityId: null, p: 0.03 },
  ],
};

const conflict = (field: string, biased: string, unbiased: string): WitnessConflict => ({
  field,
  biased: { text: biased, evidence: evidence("Ask") },
  unbiased: { text: unbiased, utteranceId: UTTERANCE, audioMs: [0, 100] },
});

describe("the first-person lines", () => {
  it("cover every loud reason, and nothing else", () => {
    expect([...LOUD_TEMPLATE_KINDS].sort()).toEqual([...LOUD_ORDER].sort());
  });

  it.each<[string, VoiceProposal, string]>([
    [
      "a witness conflict on the target",
      proposal([{ kind: "witness_conflict", field: "target" }], ASK, {}, [
        conflict("target", "Acme", "Akme"),
      ]),
      "I'm not sure I caught the company. Acme or Akme?",
    ],
    [
      "a witness conflict on a field",
      proposal([{ kind: "witness_conflict", field: "name" }], {}, {}, [
        conflict("name", "Dana Lee", "Dana Li"),
      ]),
      "I'm not sure I caught the name. “Dana Lee” or “Dana Li”?",
    ],
    [
      "the linker's question",
      proposal([{ kind: "ambiguous_target", field: "target" }], ASK),
      "I'm not sure which company you meant. Acme Dynamics or Akme Dynamics?",
    ],
    [
      "the linker's question about a person",
      proposal([{ kind: "ambiguous_target", field: "target" }], {
        ...ASK,
        kind: "contact",
        candidates: [
          { entityId: null, p: 0.5 },
          { entityId: "ct_1", p: 0.5 },
        ],
      }),
      "I'm not sure who you meant. A new record or Dana Lee?",
    ],
    [
      "a target whose words aren't in what was said",
      proposal([{ kind: "unsupported", field: "target" }], {
        decision: "none",
        entityId: null,
        basis: null,
        p: null,
        mention: null,
        candidates: [],
      }),
      "I couldn't find the company's name in what you said, so I haven't picked a record.",
    ],
    [
      "a field whose words aren't in what was said",
      proposal([{ kind: "unsupported", field: "dueDate" }]),
      "I couldn't find the words for the due date in what you said.",
    ],
    [
      "a value with two readings",
      proposal(
        [{ kind: "ambiguous_value", field: "dueDate" }],
        {},
        {
          dueDate: {
            value: "2026-11-27",
            evidence: evidence("next Friday"),
            norm: { readings: ["2026-11-27", "2026-12-04"] },
          },
        },
      ),
      "I heard “next Friday”. Did you mean the 27th or the 4th?",
    ],
    [
      "a value the rep took back, which the model kept",
      proposal(
        [
          { kind: "self_correction", field: "dueDate" },
          { kind: "value_mismatch", field: "dueDate" },
        ],
        {},
        { dueDate: { value: "2026-03-06", evidence: evidence("not March 6th") } },
      ),
      "You corrected yourself here, and I may have kept the first date: March 6.",
    ],
    [
      "a value that differs from its words, with no correction",
      proposal(
        [{ kind: "value_mismatch", field: "email" }],
        {},
        { email: { value: "dana@acme.io", evidence: evidence("Dana Lee") } },
      ),
      "I may not have written the email the way you said it: dana@acme.io.",
    ],
    [
      "a new record with a sound-alike",
      proposal([{ kind: "new_entity", field: "target" }], {
        decision: "new",
        entityId: null,
        basis: null,
        mention: { quote: "Atmo Systems", evidence: evidence("Ask") },
        candidates: [
          { entityId: null, p: 0.8 },
          { entityId: "co_3", p: 0.2 },
        ],
      }),
      "I didn't find “Atmo Systems” in your CRM. Did you mean Atmos Industrial, or is it new?",
    ],
  ])("reads %s", (_, card, text) => {
    expect(lineOf(card)?.text).toBe(text);
  });

  it("speaks for the first loud reason: a downgrade's conflict before its question", () => {
    const card = proposal(
      [
        { kind: "ambiguous_target", field: "target" },
        { kind: "witness_conflict", field: "target" },
        { kind: "negation", field: "title" },
      ],
      ASK,
      {},
      [conflict("target", "Acme", "Akme")],
    );
    expect(lineOf(card)).toMatchObject({
      reason: { tier: "loud", kind: "witness_conflict", field: "target" },
      lead: "I'm not sure I caught the company.",
      detail: "Acme or Akme?",
    });
  });

  it("never speaks on a quiet or unmarked card", () => {
    const quiet: VoiceProposal[] = [
      ...QUIET_ORDER.map((kind: QuietReasonKind) => {
        const flag = { kind: kind === "value_corrected" ? "value_mismatch" : kind } as const;
        const fields: Record<string, ProposalFieldV2> =
          kind === "value_corrected"
            ? {
                dueDate: {
                  value: "2026-03-04",
                  evidence: evidence("March 4th"),
                  norm: { llmValue: "2026-03-06" },
                },
              }
            : {};
        return proposal(
          [{ ...flag, field: "dueDate" }],
          kind === "new_entity" ? { decision: "new", entityId: null, candidates: [] } : {},
          fields,
        );
      }),
      // The name note alone, and a lone self-correction (unmarked).
      proposal([{ kind: "link_uncertain", field: "target" }], { basis: "sound", p: 0.9 }),
      proposal([{ kind: "self_correction", field: "dueDate" }]),
      proposal([]),
    ];
    for (const card of quiet) {
      expect(tierOf(card).tier).not.toBe("loud");
      expect(lineOf(card)).toBeNull();
    }
  });

  it("gives the card's description the line's first sentence", () => {
    const card = proposal([{ kind: "witness_conflict", field: "target" }], ASK, {}, [
      conflict("target", "Acme", "Akme"),
    ]);
    const line = lineOf(card);
    if (!line) throw new Error("no line");
    expect(loudDescription(card, line, ctx)).toBe(
      "Task, Acme Dynamics, needs a check: I'm not sure I caught the company.",
    );
  });

  it("offers a record added after the debrief as a question (WP12)", () => {
    expect(relinkLine("Acme Robotics").text).toBe(
      "Acme Robotics was added to your CRM after you spoke. Is it this one?",
    );
  });
});

describe("the quiet notes", () => {
  const fields = {
    dueDate: {
      value: "2026-03-04",
      evidence: evidence("March 4th"),
      norm: { llmValue: "2026-03-06" },
    },
    title: { value: "Ask Dana about the deck", evidence: evidence("not March 6th") },
  };

  it("show the value a reading replaced, and the words a negation holds", () => {
    expect(quietNote({ tier: "quiet", kind: "value_corrected", field: "dueDate" }, fields)).toBe(
      "Corrected from March 6",
    );
    expect(quietNote({ tier: "quiet", kind: "negation", field: "title" }, fields, ctx.heard)).toBe(
      "Said in a negation: “not March 6th”",
    );
    expect(quietNote({ tier: "quiet", kind: "negation", field: "title" }, fields)).toBe(
      QUIET_NOTES.negation,
    );
    expect(quietNote({ tier: "quiet", kind: "implied_target", field: "target" }, fields)).toBe(
      "Open account assumed",
    );
  });

  it("name every quiet reason, and both kinds of uncertain link", () => {
    for (const kind of QUIET_ORDER) expect(QUIET_NOTES[kind].length).toBeGreaterThan(0);
    expect(NAME_NOTES).toEqual({ sound: "matched by sound", context: "matched in context" });
  });
});

describe("spokenValue", () => {
  it.each<[string, Parameters<typeof spokenValue>[1], string | undefined, string]>([
    ["dueDate", "2026-03-06", undefined, "March 6"],
    ["time", "14:00", undefined, "2 pm"],
    ["time", "09:30", undefined, "9:30 am"],
    ["time", "00:15", undefined, "12:15 am"],
    ["amount", 40_000, undefined, "$40,000"],
    ["amount", 40_000, "EUR", "€40,000"],
    ["amount", 1_250.5, undefined, "$1,250.50"],
    ["stage", "Proposal", undefined, "Proposal"],
    ["flag", true, undefined, "yes"],
    ["dueDate", null, undefined, "none"],
  ])("says %s %j as %s", (field, value, currency, said) => {
    expect(spokenValue(field, value, currency)).toBe(said);
  });
});
