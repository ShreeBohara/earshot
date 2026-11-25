// `correctProposal` (Phase 5 spec WP13 step 2): a record re-linked; a date read, an ambiguous
// reading kept, an unreadable value refused; text replaced; the corrected field's evidence pointing
// at the correction while every other field keeps its own, with its flags.
import { describe, expect, it } from "vitest";
import {
  type CorrectableProposal,
  type CorrectionContext,
  type CorrectionUtterance,
  correctProposal,
} from "../src/correct";
import { buildLinkIndex, type LinkEntity } from "../src/link";

const ACME_DYNAMICS = "co_acme_dynamics";
const ACME_ROBOTICS = "co_acme_robotics";
const PIER = "co_pier";
const DANA_LEE = "ct_dana_lee";
const DANA_LI = "ct_dana_li";
const KATHRYN = "ct_kathryn_moore";
const PIER_DEAL = "dl_pier_expansion";

const PEER = "co_peer";

const ENTITIES: LinkEntity[] = [
  { id: ACME_DYNAMICS, kind: "company", name: "Acme Dynamics", aliases: [] },
  { id: ACME_ROBOTICS, kind: "company", name: "Acme Robotics", aliases: [] },
  { id: PIER, kind: "company", name: "Pier Logistics", aliases: [] },
  { id: PEER, kind: "company", name: "Peer Logistics", aliases: [] },
  { id: DANA_LEE, kind: "contact", name: "Dana Lee", aliases: [], parentId: ACME_DYNAMICS },
  { id: DANA_LI, kind: "contact", name: "Dana Li", aliases: [], parentId: PIER },
  { id: KATHRYN, kind: "contact", name: "Kathryn Moore", aliases: [], parentId: PIER },
  {
    id: PIER_DEAL,
    kind: "deal",
    name: "Pier Logistics - Expansion",
    aliases: [],
    parentId: PIER,
  },
];

const CTX: CorrectionContext = {
  index: buildLinkIndex(ENTITIES),
  focusEntityId: null,
  recent: [],
  kinds: ["company", "contact", "deal"],
  // Wednesday 2026-11-18, 2 pm in Chicago.
  callTime: "2026-11-18T20:00:00Z",
  timeZone: "America/Chicago",
};

const ORIGINAL_UTTERANCE = "u0000000-0000-7000-8000-000000000001";
const CORRECTION_UTTERANCE = "u0000000-0000-7000-8000-000000000002";

const evidence = (span: [number, number]) => ({
  utteranceId: ORIGINAL_UTTERANCE,
  span,
  audioMs: [1000 + span[0] * 50, 1000 + span[1] * 50] as [number, number],
  confidence: 0.93,
});

/** A task for Acme Dynamics, linked exactly, its title weakly supported, with no due date. */
const TASK: CorrectableProposal = {
  proposalId: "p-task",
  type: "task",
  target: {
    decision: "linked",
    entityId: ACME_DYNAMICS,
    kind: "company",
    basis: "exact",
    p: 0.98,
    mention: { quote: "Acme Dynamics", evidence: evidence([0, 13]) },
    company: null,
    candidates: [
      { entityId: ACME_DYNAMICS, p: 0.98 },
      { entityId: ACME_ROBOTICS, p: 0.01 },
    ],
  },
  fields: {
    title: { value: "Send the deck", evidence: evidence([14, 27]) },
    dueDate: { value: "2026-11-20", evidence: evidence([31, 37]) },
  },
  riskFlags: [
    { kind: "weak_support", field: "title" },
    { kind: "value_mismatch", field: "dueDate" },
    { kind: "witness_conflict", field: "target" },
  ],
  linker: "linker.v1",
};

/** A typed correction: confidence 1, no words, an empty window at 42.5 s. */
function typed(text: string): CorrectionUtterance[] {
  return [
    {
      utteranceId: CORRECTION_UTTERANCE,
      input: "typed",
      text,
      confidence: 1,
      startMs: 42_500,
      endMs: 42_500,
    },
  ];
}

/** A spoken correction, one word timing per word, 300 ms each from 40 s. */
function spoken(text: string, confidence = 0.92): CorrectionUtterance[] {
  const words = text.split(" ").map((w, index) => ({
    w,
    startMs: 40_000 + index * 300,
    endMs: 40_000 + index * 300 + 250,
    confidence,
  }));
  return [
    {
      utteranceId: CORRECTION_UTTERANCE,
      text,
      confidence,
      words,
      startMs: 40_000,
      endMs: 40_000 + words.length * 300,
    },
  ];
}

describe("correctProposal: the record", () => {
  it("re-links the record from the words as said, its evidence at the correction", () => {
    const result = correctProposal(TASK, "target", spoken("No, it's Acme Robotics."), CTX);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    const { proposal } = result;
    expect(result.value).toBe(ACME_ROBOTICS);
    expect(result.words).toBe("Acme Robotics");
    expect(proposal.target).toMatchObject({
      decision: "linked",
      entityId: ACME_ROBOTICS,
      kind: "company",
      basis: "exact",
      company: null,
      mention: {
        quote: "Acme Robotics",
        // "Acme Robotics" is words 3 and 4 of the utterance, at 40.6 s to 41.15 s.
        evidence: {
          utteranceId: CORRECTION_UTTERANCE,
          span: [9, 22],
          audioMs: [40_600, 41_150],
          confidence: 0.92,
        },
      },
    });
    expect(proposal.supersedes).toBe("p-task");
    expect(proposal.linker).toBe("linker.v1");
    // The target's old flags go; the fields keep theirs, and their values and evidence.
    expect(proposal.riskFlags).toEqual([
      { kind: "weak_support", field: "title" },
      { kind: "value_mismatch", field: "dueDate" },
    ]);
    expect(proposal.fields).toEqual(TASK.fields);
  });

  it("asks when the words fit several records, and proposes a new one for an unknown name", () => {
    const ask = correctProposal(TASK, "target", typed("Acme"), CTX);
    if (!ask.ok) throw new Error("refused");
    expect(ask.proposal.target.decision).toBe("ask");
    expect(ask.proposal.riskFlags).toContainEqual({ kind: "ambiguous_target", field: "target" });
    expect(ask.value).toBeNull();

    const fresh = correctProposal(TASK, "target", typed("Zephyr Biologics"), CTX);
    if (!fresh.ok) throw new Error("refused");
    expect(fresh.proposal.target).toMatchObject({ decision: "new", entityId: null });
    expect(fresh.proposal.riskFlags).toContainEqual({ kind: "new_entity", field: "target" });
  });

  it("lets typed words' spelling settle a question between homophones, and leaves said words asking", () => {
    const typedResult = correctProposal(TASK, "target", typed("Pier Logistics"), CTX);
    if (!typedResult.ok) throw new Error("refused");
    expect(typedResult.proposal.target).toMatchObject({
      decision: "linked",
      entityId: PIER,
      basis: "exact",
    });
    expect(typedResult.proposal.riskFlags.filter((flag) => flag.field === "target")).toEqual([]);
    const said = correctProposal(
      TASK,
      "target",
      spoken("Pier Logistics").map((utterance) => ({ ...utterance, input: "speech" as const })),
      CTX,
    );
    if (!said.ok) throw new Error("refused");
    expect(said.proposal.target.decision).toBe("ask");
  });

  it("refuses words that can name no record of the kinds the type allows", () => {
    const update: CorrectableProposal = {
      ...TASK,
      proposalId: "p-deal",
      type: "deal_update",
      target: { ...TASK.target, entityId: PIER_DEAL, kind: "deal" },
      fields: { stage: { value: "Negotiation", evidence: evidence([0, 11]) } },
      riskFlags: [],
    };
    const result = correctProposal(update, "target", typed("Quantum Widgets"), {
      ...CTX,
      kinds: ["deal"],
    });
    expect(result).toEqual({
      ok: false,
      reason: "unreadable",
      kind: "record",
      words: "Quantum Widgets",
    });
  });

  it("corrects a contact's record and its name together: the record is linked on the name", () => {
    const contact: CorrectableProposal = {
      proposalId: "p-contact",
      type: "contact",
      target: { ...TASK.target, entityId: DANA_LI, kind: "contact" },
      fields: {
        name: { value: "Dana Li", evidence: evidence([0, 7]) },
        title: { value: "VP of Operations", evidence: evidence([11, 27]) },
      },
      riskFlags: [
        { kind: "link_uncertain", field: "target" },
        { kind: "value_mismatch", field: "name" },
      ],
      linker: "linker.v1",
    };
    for (const field of ["target", "name"]) {
      const result = correctProposal(contact, field, typed("Kathryn Moore"), {
        ...CTX,
        kinds: ["contact"],
      });
      if (!result.ok) throw new Error("refused");
      expect(result.proposal.target).toMatchObject({ decision: "linked", entityId: KATHRYN });
      expect(result.proposal.fields.name).toMatchObject({
        value: "Kathryn Moore",
        evidence: { utteranceId: CORRECTION_UTTERANCE },
      });
      expect(result.proposal.fields.title).toEqual(contact.fields.title);
      expect(result.proposal.riskFlags).toEqual([]);
    }
    // Said, a name that sounds like another record's is a question still, as it was first; typed,
    // its spelling settles it.
    const alike = correctProposal(contact, "name", spoken("Dana Lee"), {
      ...CTX,
      kinds: ["contact"],
    });
    if (!alike.ok) throw new Error("refused");
    expect(alike.proposal.target.decision).toBe("ask");
    expect(alike.proposal.target.candidates.map((candidate) => candidate.entityId)).toContain(
      DANA_LEE,
    );
    const spelled = correctProposal(contact, "name", typed("Dana Lee"), {
      ...CTX,
      kinds: ["contact"],
    });
    if (!spelled.ok) throw new Error("refused");
    expect(spelled.proposal.target).toMatchObject({ decision: "linked", entityId: DANA_LEE });
  });
});

describe("correctProposal: dates, times, and amounts", () => {
  it("reads a date, which replaces the old value and its flags", () => {
    const result = correctProposal(TASK, "dueDate", typed("Make it the 24th."), CTX);
    if (!result.ok) throw new Error("refused");
    expect(result.value).toBe("2026-11-24");
    expect(result.words).toBe("the 24th");
    expect(result.proposal.fields.dueDate).toEqual({
      value: "2026-11-24",
      evidence: {
        utteranceId: CORRECTION_UTTERANCE,
        span: [8, 16],
        audioMs: [42_500, 42_500],
        confidence: 1,
      },
    });
    expect(result.proposal.riskFlags).toEqual([
      { kind: "weak_support", field: "title" },
      { kind: "witness_conflict", field: "target" },
    ]);
    // The record isn't touched: no new link, the same linker.
    expect(result.proposal.target).toBe(TASK.target);
  });

  it("keeps an ambiguous reading's readings, flagged ambiguous_value", () => {
    const result = correctProposal(TASK, "dueDate", typed("next Friday"), CTX);
    if (!result.ok) throw new Error("refused");
    expect(result.proposal.fields.dueDate).toMatchObject({
      value: "2026-11-20",
      norm: { readings: ["2026-11-20", "2026-11-27"] },
    });
    expect(result.proposal.riskFlags).toContainEqual({
      kind: "ambiguous_value",
      field: "dueDate",
    });
  });

  it("takes the date that isn't negated: what the rep means is what they said last", () => {
    const result = correctProposal(TASK, "dueDate", typed("not Friday, Monday"), CTX);
    if (!result.ok) throw new Error("refused");
    expect(result.value).toBe("2026-11-23");
  });

  it("refuses words with no date, and appends nothing: the caller says it couldn't read one", () => {
    expect(correctProposal(TASK, "dueDate", typed("whenever works for them"), CTX)).toEqual({
      ok: false,
      reason: "unreadable",
      kind: "date",
      words: "whenever works for them",
    });
    expect(correctProposal(TASK, "dueDate", typed("not Friday"), CTX)).toMatchObject({
      ok: false,
      kind: "date",
    });
  });

  it("adds a field the proposal didn't have: a follow-up's answer", () => {
    const { dueDate: _, ...fields } = TASK.fields;
    const result = correctProposal(
      { ...TASK, fields, riskFlags: [] },
      "dueDate",
      typed("Friday"),
      CTX,
    );
    if (!result.ok) throw new Error("refused");
    expect(Object.keys(result.proposal.fields)).toEqual(["title", "dueDate"]);
    expect(result.value).toBe("2026-11-20");
  });

  it("reads an amount, keeps a range's readings, and flags one in another currency", () => {
    const update: CorrectableProposal = {
      ...TASK,
      proposalId: "p-deal",
      type: "deal_update",
      target: { ...TASK.target, entityId: PIER_DEAL, kind: "deal" },
      fields: { stage: { value: "Negotiation", evidence: evidence([0, 11]) } },
      riskFlags: [],
    };
    const amount = (said: string) => correctProposal(update, "amount", typed(said), CTX);
    expect(amount("make it fifty thousand")).toMatchObject({ ok: true, value: 50_000 });
    const range = amount("50 to 60k");
    if (!range.ok) throw new Error("refused");
    expect(range.proposal.fields.amount).toMatchObject({
      value: 50_000,
      norm: { readings: [50_000, 60_000] },
    });
    expect(range.proposal.riskFlags).toEqual([{ kind: "ambiguous_value", field: "amount" }]);
    const euros = amount("forty thousand euros");
    if (!euros.ok) throw new Error("refused");
    expect(euros.proposal.fields.amount).toMatchObject({
      value: 40_000,
      norm: { currency: "EUR" },
    });
    expect(euros.proposal.riskFlags).toEqual([{ kind: "value_mismatch", field: "amount" }]);
    expect(amount("about the same as last year")).toMatchObject({
      ok: false,
      reason: "unreadable",
      kind: "amount",
    });
  });

  it("reads a meeting's time, with both readings of an hour said without a meridiem", () => {
    const meeting: CorrectableProposal = {
      ...TASK,
      proposalId: "p-meeting",
      type: "meeting",
      fields: { title: { value: "Pricing review", evidence: evidence([0, 14]) } },
      riskFlags: [],
    };
    expect(correctProposal(meeting, "time", typed("3pm"), CTX)).toMatchObject({
      ok: true,
      value: "15:00",
    });
    const either = correctProposal(meeting, "time", typed("at 3"), CTX);
    if (!either.ok) throw new Error("refused");
    expect(either.proposal.fields.time?.norm?.readings).toEqual(["15:00", "03:00"]);
    expect(either.proposal.riskFlags).toEqual([{ kind: "ambiguous_value", field: "time" }]);
    expect(correctProposal(meeting, "time", typed("later"), CTX)).toMatchObject({
      ok: false,
      kind: "time",
    });
  });
});

describe("correctProposal: text", () => {
  it("takes the words as said, less the lead-in, for text", () => {
    const result = correctProposal(TASK, "title", typed("Change it to send the revised deck"), CTX);
    if (!result.ok) throw new Error("refused");
    expect(result.value).toBe("send the revised deck");
    expect(result.proposal.fields.title).toEqual({
      value: "send the revised deck",
      evidence: {
        utteranceId: CORRECTION_UTTERANCE,
        span: [13, 34],
        audioMs: [42_500, 42_500],
        confidence: 1,
      },
    });
    // The title's weak support went with its old words.
    expect(result.proposal.riskFlags).toEqual([
      { kind: "value_mismatch", field: "dueDate" },
      { kind: "witness_conflict", field: "target" },
    ]);
  });

  it("writes out a spoken email, and flags words the speech-to-text was unsure of", () => {
    const contact: CorrectableProposal = {
      ...TASK,
      proposalId: "p-contact",
      type: "contact",
      fields: { name: { value: "Dana Lee", evidence: evidence([0, 8]) } },
      riskFlags: [],
    };
    const result = correctProposal(
      contact,
      "email",
      spoken("it's dana dot lee at acme dot com", 0.62),
      CTX,
    );
    if (!result.ok) throw new Error("refused");
    expect(result.value).toBe("dana.lee@acme.com");
    expect(result.proposal.fields.email?.evidence).toMatchObject({
      utteranceId: CORRECTION_UTTERANCE,
      audioMs: [40_300, 42_350],
      confidence: 0.62,
    });
    expect(result.proposal.riskFlags).toEqual([{ kind: "low_confidence", field: "email" }]);
  });

  it("keeps the punctuation a value carries, and drops only sentence punctuation and quotes (Codex on #67)", () => {
    const contact: CorrectableProposal = {
      ...TASK,
      proposalId: "p-contact",
      type: "contact",
      fields: { name: { value: "Dana Lee", evidence: evidence([0, 8]) } },
      riskFlags: [],
    };
    const phone = correctProposal(contact, "phone", typed("No, it's +44 20 7946 0958."), CTX);
    if (!phone.ok) throw new Error("refused");
    expect(phone.value).toBe("+44 20 7946 0958");
    expect(phone.words).toBe("+44 20 7946 0958");
    expect(phone.proposal.fields.phone?.evidence.span).toEqual([9, 25]);
    const local = correctProposal(contact, "phone", typed("make it (555) 010-4477"), CTX);
    expect(local.ok && local.value).toBe("(555) 010-4477");
    const email = correctProposal(contact, "email", typed("it's _dana@acme.com"), CTX);
    expect(email.ok && email.value).toBe("_dana@acme.com");

    const titled = (text: string) => {
      const result = correctProposal(TASK, "title", typed(text), CTX);
      return result.ok ? result.value : null;
    };
    expect(titled("Change it to send the deck (v2).")).toBe("send the deck (v2)");
    expect(titled("It should say “Send the deck”.")).toBe("Send the deck");
    expect(titled("no, (send the deck")).toBe("send the deck");
    expect(titled("send the deck)")).toBe("send the deck");
  });

  it("refuses a correction with nothing left once the lead-in is set aside, and a field the type lacks", () => {
    expect(correctProposal(TASK, "title", typed("No, it's"), CTX)).toEqual({
      ok: false,
      reason: "no_words",
      kind: null,
      words: "No, it's",
    });
    expect(correctProposal(TASK, "amount", typed("fifty thousand"), CTX)).toMatchObject({
      ok: false,
      reason: "unknown_field",
    });
  });

  it("reads the last utterance that has words, for a spoken correction in two parts", () => {
    const parts: CorrectionUtterance[] = [
      { ...typed("No, it's")[0], utteranceId: "u-a" } as CorrectionUtterance,
      { ...typed("send the pricing sheet.")[0], utteranceId: "u-b" } as CorrectionUtterance,
    ];
    const result = correctProposal(TASK, "title", parts, CTX);
    if (!result.ok) throw new Error("refused");
    expect(result.value).toBe("send the pricing sheet");
    expect(result.proposal.fields.title?.evidence.utteranceId).toBe("u-b");
  });
});
