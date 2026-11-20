import type { EventEnvelope } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  type ActualTurn,
  DEMO_SESSION_ENTITIES,
  type DebriefTurn,
  datasetIdsFor,
  debrief,
  type ExpectedProposal,
  expectedDecision,
  turnProblems,
  turnsFromEvents,
  turnTranscript,
} from "../src";

const SESSION = "01900000-0000-7000-8000-000000000000";
let seq = 0;
const uuid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;

function event(type: string, payload: Record<string, unknown>, id = uuid(++seq)): EventEnvelope {
  return {
    id,
    sessionId: SESSION,
    seq,
    type,
    schemaVersion: 1,
    ts: "2026-11-17T22:20:00.000Z",
    payload,
  } as EventEnvelope;
}

describe("turnsFromEvents", () => {
  it("folds a session's events into one result per completed turn, in order", () => {
    seq = 0;
    const turn1 = uuid(901);
    const turn2 = uuid(902);
    const events = [
      event("session.started", {}),
      event("utterance.final", { utteranceId: uuid(101), text: "Bump the deal", turnId: turn1 }),
      event("utterance.final", { utteranceId: uuid(102), text: "to forty-two.", turnId: turn1 }),
      event("proposal.created", {
        proposalId: uuid(201),
        type: "deal_update",
        target: {
          decision: "linked",
          entityId: "deal_028",
          kind: "deal",
          basis: "exact",
          p: 0.99,
          mention: null,
          company: null,
          candidates: [{ entityId: "deal_028", p: 0.99 }],
        },
        fields: { amount: { value: 42000 } },
        riskFlags: [],
        supersedes: null,
        linker: "linker.v1",
      }),
      event("turn.completed", {
        turnId: turn1,
        utteranceIds: [uuid(101), uuid(102)],
        outcome: "proposals",
        proposalIds: [uuid(201)],
      }),
      event("turn.measured", {
        turnId: turn1,
        mode: "push_to_talk",
        speechEndToFinalMs: 120,
        finalToProposalMs: 300,
        proposalToPaintMs: 16,
        totalMs: 436,
      }),
      event("utterance.final", { utteranceId: uuid(103), text: "That's all.", turnId: turn2 }),
      event("turn.completed", {
        turnId: turn2,
        utteranceIds: [uuid(103)],
        outcome: "nothing_to_propose",
        proposalIds: [],
      }),
    ];
    // A replay after a reconnect repeats events: each counts once.
    const turns = turnsFromEvents([...events, ...events.slice(1, 4)]);
    expect(turns).toEqual([
      {
        turnId: turn1,
        transcript: "Bump the deal to forty-two.",
        outcome: "proposals",
        proposals: [
          {
            type: "deal_update",
            targetEntityId: "deal_028",
            decision: "linked",
            candidates: ["deal_028"],
            fields: { amount: { value: 42000 } },
          },
        ],
        latency: {
          totalMs: 436,
          speechEndToFinalMs: 120,
          finalToProposalMs: 300,
          proposalToPaintMs: 16,
        },
      },
      {
        turnId: turn2,
        transcript: "That's all.",
        outcome: "nothing_to_propose",
        proposals: [],
        latency: null,
      },
    ]);
  });

  it("reads a v1 proposal as its upcast: a target is linked, none is new or none", () => {
    seq = 0;
    const turn = uuid(903);
    const v1 = (id: number, targetEntityId: string | null, flags: { kind: string }[]) =>
      event("proposal.created", {
        proposalId: uuid(id),
        type: "contact",
        targetEntityId,
        fields: {},
        riskFlags: flags,
      });
    const [proposals] = turnsFromEvents([
      v1(301, "ct_045", []),
      v1(302, null, [{ kind: "new_entity" }]),
      v1(303, null, []),
      event("turn.completed", {
        turnId: turn,
        utteranceIds: [],
        outcome: "proposals",
        proposalIds: [uuid(301), uuid(302), uuid(303)],
      }),
    ]).map((result) => result.proposals);
    expect(proposals?.map((proposal) => [proposal.decision, proposal.targetEntityId])).toEqual([
      ["linked", "ct_045"],
      ["new", null],
      ["none", null],
    ]);
  });

  it("leaves out turns that haven't completed", () => {
    seq = 0;
    expect(
      turnsFromEvents([event("utterance.final", { utteranceId: uuid(1), text: "x" })]),
    ).toEqual([]);
  });
});

describe("turnProblems", () => {
  const script = debrief("d001");
  const [first, second, , quiet] = script.turns;
  if (!first || !second || !quiet) throw new Error("d001 changed shape");

  /** A turn exactly as the script expects it, as the session's events would tell it. */
  function asScripted(turn: DebriefTurn): ActualTurn {
    return {
      turnId: uuid(1),
      transcript: turnTranscript(turn),
      outcome: turn.expect.length > 0 ? "proposals" : "nothing_to_propose",
      proposals: turn.expect.map((expected) => ({
        type: expected.type,
        targetEntityId: expectedDecision(expected) === "linked" ? expected.target.id : null,
        decision: expectedDecision(expected),
        candidates: expected.target.id === null ? [] : [expected.target.id],
        fields: Object.fromEntries(
          Object.entries(expected.fields).map(([name, field]) => [name, { value: field?.value }]),
        ),
      })),
      latency:
        turn.expect.length > 0
          ? { totalMs: 1, speechEndToFinalMs: 1, finalToProposalMs: 0, proposalToPaintMs: 0 }
          : null,
    };
  }
  const exact = { exactTranscript: true };

  it("maps a live session's database ids to the scripts' dataset ids before comparing targets", () => {
    const targeted = script.turns.find((turn) => turn.expect.some((e) => e.target.id !== null));
    if (!targeted) throw new Error("d001 has no targeted proposal");
    // A live session's entities: the same records, with crm_entities' random UUIDs as ids.
    const live = DEMO_SESSION_ENTITIES.map((entity, n) => ({ ...entity, id: uuid(5_000 + n) }));
    const toLive = new Map(DEMO_SESSION_ENTITIES.map((entity, n) => [entity.id, uuid(5_000 + n)]));
    const actual = asScripted(targeted);
    const liveActual: ActualTurn = {
      ...actual,
      proposals: actual.proposals.map((proposal) => ({
        ...proposal,
        targetEntityId:
          proposal.targetEntityId === null ? null : (toLive.get(proposal.targetEntityId) ?? null),
        candidates: proposal.candidates.map((id) =>
          id === null ? null : (toLive.get(id) ?? null),
        ),
      })),
    };
    const live_ = { exactTranscript: false };
    expect(turnProblems(targeted, liveActual, live_).some((p) => p.includes("targets"))).toBe(true);
    expect(
      turnProblems(targeted, liveActual, { ...live_, targetIds: datasetIdsFor(live) }),
    ).toEqual([]);
  });

  it("finds nothing wrong with a turn that went as scripted, quiet turns included", () => {
    for (const turn of script.turns)
      expect(turnProblems(turn, asScripted(turn), exact)).toEqual([]);
  });

  it("wants a scripted question to offer the scripted record", () => {
    // d008's second turn names "Blue Harbor site rollout", a deal linker v1 asks about.
    const scripted = debrief("d008").turns[1];
    if (!scripted) throw new Error("d008 changed shape");
    expect(expectedDecision(scripted.expect[0] as ExpectedProposal)).toBe("ask");
    const actual = asScripted(scripted);
    expect(turnProblems(scripted, actual, exact)).toEqual([]);
    const proposal = actual.proposals[0];
    if (!proposal) throw new Error("d008 turn 2 expects a deal update");
    expect(
      turnProblems(
        scripted,
        { ...actual, proposals: [{ ...proposal, candidates: ["deal_027"] }] },
        exact,
      ),
    ).toEqual(["proposal 1 asks without offering deal_010"]);
  });

  it("compares key fields exactly, and free text not at all", () => {
    const actual = asScripted(second);
    const deal = actual.proposals[0];
    if (!deal) throw new Error("d001 turn 2 expects a deal update");
    const changed: ActualTurn = {
      ...actual,
      proposals: [
        { ...deal, fields: { ...deal.fields, amount: { value: 4200 }, closeDate: { value: "x" } } },
      ],
    };
    expect(turnProblems(second, changed, exact)).toEqual([
      "proposal 1 amount is 4200, not 42000",
      'proposal 1 closeDate is "x", not missing',
    ]);
    const note = asScripted(first);
    const reworded: ActualTurn = {
      ...note,
      proposals: note.proposals.map((p) => ({ ...p, fields: { body: { value: "Other words." } } })),
    };
    expect(turnProblems(first, reworded, exact)).toEqual([]);
  });

  it("names the wrong type, target, count, outcome, transcript, and a missing measurement", () => {
    const actual = asScripted(first);
    const note = actual.proposals[0];
    if (!note) throw new Error("d001 turn 1 expects a note");
    expect(
      turnProblems(first, { ...actual, proposals: [{ ...note, type: "task" }] }, exact),
    ).toEqual(["proposal 1 is a task, not a note"]);
    expect(
      turnProblems(first, { ...actual, proposals: [{ ...note, targetEntityId: "co_012" }] }, exact),
    ).toEqual(["proposal 1 targets co_012, not co_011"]);
    // The linker's decision counts: a question or a new record isn't the scripted link.
    const asked = { ...note, decision: "ask" as const, targetEntityId: null };
    expect(turnProblems(first, { ...actual, proposals: [asked] }, exact)).toEqual([
      "proposal 1 targets a question, not co_011",
    ]);
    const created = { ...note, decision: "new" as const, targetEntityId: null };
    expect(turnProblems(first, { ...actual, proposals: [created] }, exact)).toEqual([
      "proposal 1 targets a new record, not co_011",
    ]);
    expect(turnProblems(quiet, { ...asScripted(quiet), outcome: "invalid_output" }, exact)).toEqual(
      ["ended as invalid_output, not nothing_to_propose"],
    );
    expect(
      turnProblems(first, { ...actual, transcript: "Just left", latency: null }, exact),
    ).toEqual([
      `heard "Just left", not ${JSON.stringify(turnTranscript(first))}`,
      "has no turn.measured, so its latency is unknown",
    ]);
    expect(
      turnProblems(first, { ...actual, transcript: "Just left" }, { exactTranscript: false }),
    ).toEqual([]);
    expect(turnProblems(first, { ...actual, proposals: [] }, exact)).toEqual([
      "made 0 proposals, not 1",
    ]);
    expect(turnProblems(first, undefined, exact)).toEqual(["never completed"]);
  });
});
