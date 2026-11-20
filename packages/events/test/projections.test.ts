import { describe, expect, it } from "vitest";
import {
  defaultProjections,
  defaultRegistry,
  ProjectionError,
  proposalsProjection,
  replay,
  sessionProjection,
  utterancesProjection,
} from "../src";
import {
  deepFreeze,
  ended,
  proposal,
  proposalFlagged,
  proposalV2,
  review,
  SESSION_ID,
  sessionLog,
  started,
  tsFor,
  turnCompleted,
  turnMeasured,
  turnWitnessed,
  usageRecorded,
  utterance,
  uuid,
} from "./helpers";

describe("sessionProjection", () => {
  it("is null before the session starts", () => {
    expect(replay([], { session: sessionProjection }).session).toBeNull();
  });

  it("tracks status, setup, timings, and cost", () => {
    const active = replay(sessionLog([started(), utterance(1)]), { session: sessionProjection });
    expect(active.session).toEqual({
      sessionId: SESSION_ID,
      status: "active",
      mode: "debrief",
      engine: "cascaded",
      providers: { speechToText: { provider: "deepgram", model: "nova-3" } },
      startedAt: "2026-11-10T19:15:00.000Z",
      endedAt: null,
      durationMs: null,
      costUsd: null,
      lastSeq: 1,
      lastEventAt: tsFor(1),
    });

    const done = replay(sessionLog([started(), utterance(1), ended()]), {
      session: sessionProjection,
    });
    expect(done.session).toMatchObject({
      status: "ended",
      endedAt: "2026-11-10T19:15:40.000Z",
      durationMs: 40_000,
      costUsd: 0.004,
      lastSeq: 2,
    });
  });

  it("computes the duration across UTC offsets", () => {
    const log = sessionLog([started(), ended({ endedAt: "2026-11-10T14:15:42.500-05:00" })]);
    expect(replay(log, { session: sessionProjection }).session?.durationMs).toBe(42_500);
  });

  it("records a missing cost as null", () => {
    const log = sessionLog([started(), ended({ costUsd: undefined })]);
    expect(replay(log, { session: sessionProjection }).session?.costUsd).toBeNull();
  });

  it("keeps following the log after the session ends", () => {
    const log = sessionLog([started(), proposal(1), ended(), review(1, "approved")]);
    expect(replay(log, { session: sessionProjection }).session).toMatchObject({
      status: "ended",
      lastSeq: 3,
      lastEventAt: tsFor(3),
    });
  });

  it("requires the log to open with session.started", () => {
    expect(() => replay(sessionLog([utterance(1)]), { session: sessionProjection })).toThrow(
      ProjectionError,
    );
  });

  it("rejects a second start or a second end", () => {
    expect(() =>
      replay(sessionLog([started(), started()]), { session: sessionProjection }),
    ).toThrow(/already started/);
    expect(() =>
      replay(sessionLog([started(), ended(), ended()]), { session: sessionProjection }),
    ).toThrow(/already ended/);
  });
});

describe("utterancesProjection", () => {
  it("lists utterances in seq order with their witness, timings, and words", () => {
    const withWords = utterance(2, "Thursday works.", "unbiased");
    withWords.payload.words = [
      { w: "Thursday", startMs: 2000, endMs: 2400, confidence: 0.96 },
      { w: "works", startMs: 2450, endMs: 2800, confidence: 0.93 },
    ];
    const log = sessionLog([started(), utterance(1, "Send the deck."), proposal(1), withWords]);
    const { utterances } = replay(log, { utterances: utterancesProjection });
    expect(utterances).toEqual([
      {
        utteranceId: uuid(2001),
        seq: 1,
        ts: tsFor(1),
        witness: "biased",
        text: "Send the deck.",
        confidence: 0.9,
        startMs: 1000,
        endMs: 1800,
        words: null,
      },
      {
        utteranceId: uuid(2002),
        seq: 3,
        ts: tsFor(3),
        witness: "unbiased",
        text: "Thursday works.",
        confidence: 0.9,
        startMs: 2000,
        endMs: 2800,
        words: withWords.payload.words,
      },
    ]);
  });

  it("rejects an utterance id that's already final", () => {
    const log = sessionLog([started(), utterance(1), utterance(1)]);
    expect(() => replay(log, { utterances: utterancesProjection })).toThrow(/already final/);
  });
});

describe("proposalsProjection", () => {
  const editDiff = { title: { before: "Send the deck", after: "Send the revised deck" } };
  const log = sessionLog([
    started(),
    utterance(1),
    proposal(1, "task"),
    proposal(2, "note", "Pilot is going well."),
    proposal(3, "commitment", "Run a workshop."),
    review(1, "edited", { editDiff }),
    review(3, "rejected"),
  ]);

  it("starts proposals as proposed and applies each review", () => {
    const { proposals } = replay(log, { proposals: proposalsProjection });
    expect(proposals.map((p) => [p.type, p.status])).toEqual([
      ["task", "edited"],
      ["note", "proposed"],
      ["commitment", "rejected"],
    ]);
    expect(proposals[0]).toEqual({
      proposalId: uuid(3001),
      type: "task",
      targetEntityId: null,
      // Stored at v1 with no target and no new_entity flag: upcast to none.
      target: {
        decision: "none",
        entityId: null,
        kind: null,
        basis: null,
        p: null,
        mention: null,
        company: null,
        candidates: [],
      },
      status: "edited",
      fields: proposal(1).payload.fields,
      riskFlags: [],
      conflicts: [],
      seq: 2,
      ts: tsFor(2),
      review: { decision: "edited", editDiff, reviewerMs: 1500, seq: 5, ts: tsFor(5) },
    });
    expect(proposals[1]?.review).toBeNull();
    expect(proposals[2]?.review).toMatchObject({ decision: "rejected", editDiff: null });
  });

  it("keeps the latest review when a proposal is reviewed again", () => {
    const again = sessionLog([
      started(),
      proposal(1),
      review(1, "rejected"),
      review(1, "approved"),
    ]);
    const [only] = replay(again, { proposals: proposalsProjection }).proposals;
    expect(only).toMatchObject({ status: "approved", review: { decision: "approved", seq: 3 } });
  });

  it("rejects a review of a proposal it hasn't seen", () => {
    const orphan = sessionLog([started(), review(9, "approved")]);
    expect(() => replay(orphan, { proposals: proposalsProjection })).toThrow(/no proposal/);
  });

  it("rejects a proposal id that already exists", () => {
    const twice = sessionLog([started(), proposal(1), proposal(1)]);
    expect(() => replay(twice, { proposals: proposalsProjection })).toThrow(/already exists/);
  });
});

describe("proposalsProjection: Phase 4 targets, flags, and downgrades", () => {
  const fold = (bodies: Parameters<typeof sessionLog>[0]) =>
    replay(sessionLog(bodies), { proposals: proposalsProjection }).proposals;
  const askBetween = (...candidates: [string | null, number][]) => ({
    decision: "ask",
    candidates: candidates.map(([entityId, p]) => ({ entityId, p })),
  });

  it("folds a v2 target, and keeps targetEntityId equal to its entityId", () => {
    const asked = { decision: "ask", entityId: null, basis: null, p: 0.48 };
    const [linked, ask] = fold([started(), utterance(1), proposalV2(1), proposalV2(2, asked)]);
    expect(linked).toMatchObject({
      targetEntityId: uuid(6001),
      target: proposalV2(1).payload.target,
      riskFlags: [{ kind: "link_uncertain", field: "target" }],
      conflicts: [],
      status: "proposed",
    });
    expect(ask).toMatchObject({ targetEntityId: null, target: { decision: "ask", p: 0.48 } });
  });

  it("upcasts a stored v1 proposal's target: linked, new, or none", () => {
    const linked = proposal(1, "task");
    linked.payload.targetEntityId = uuid(6001);
    const newContact = proposal(2, "contact");
    newContact.payload.riskFlags = [{ kind: "new_entity" }];
    const decisions = fold([started(), linked, newContact, proposal(3, "note")]).map((p) => [
      p.target.decision,
      p.target.basis,
      p.targetEntityId,
    ]);
    expect(decisions).toEqual([
      ["linked", "exact", uuid(6001)],
      ["new", null, null],
      ["none", null, null],
    ]);
  });

  it("adds a flag's flags, each once, and its conflict, in order", () => {
    const again = proposalFlagged(1, {
      flags: [
        { kind: "link_uncertain", field: "target" },
        { kind: "low_confidence", field: "title" },
      ],
      conflict: null,
    });
    const [flagged] = fold([started(), utterance(1), proposalV2(1), proposalFlagged(1), again]);
    expect(flagged?.riskFlags).toEqual([
      { kind: "link_uncertain", field: "target" },
      { kind: "witness_conflict", field: "target" },
      { kind: "low_confidence", field: "title" },
    ]);
    expect(flagged?.conflicts).toEqual([proposalFlagged(1).payload.conflict]);
    expect(flagged?.target).toEqual(proposalV2(1).payload.target); // no downgrade: it stands
  });

  it("downgrades a linked target to a question, with the old target first", () => {
    const downgrade = proposalFlagged(1, {
      target: askBetween([uuid(6003), 0.55], [uuid(6001), 0.35], [null, 0.1]),
    });
    const [asked] = fold([started(), utterance(1), proposalV2(1), downgrade]);
    expect(asked?.targetEntityId).toBeNull();
    expect(asked?.target).toEqual({
      ...(proposalV2(1).payload.target as object),
      decision: "ask",
      entityId: null,
      candidates: [
        { entityId: uuid(6001), p: 0.35 },
        { entityId: uuid(6003), p: 0.55 },
        { entityId: null, p: 0.1 },
      ],
    });
    expect(asked?.conflicts).toHaveLength(1);
  });

  it("downgrades a new target, keeping new first", () => {
    const isNew = { decision: "new", entityId: null, basis: null, candidates: [] };
    const downgrade = proposalFlagged(1, { target: askBetween([uuid(6002), 0.6], [null, 0.4]) });
    const [asked] = fold([started(), utterance(1), proposalV2(1, isNew), downgrade]);
    expect(asked?.target).toMatchObject({
      decision: "ask",
      entityId: null,
      candidates: [
        { entityId: null, p: 0.4 },
        { entityId: uuid(6002), p: 0.6 },
      ],
    });
  });

  it("refuses a downgrade that doesn't list the target it replaces", () => {
    const downgrade = proposalFlagged(1, { target: askBetween([uuid(6003), 0.6], [null, 0.4]) });
    const log = [started(), utterance(1), proposalV2(1), downgrade];
    expect(() => fold(log)).toThrow(ProjectionError);
    expect(() => fold(log)).toThrow(`doesn't list record ${uuid(6001)}, its target`);
  });

  it("gives a target that was already a question the downgrade's candidates", () => {
    const asked = {
      decision: "ask",
      entityId: null,
      candidates: [{ entityId: uuid(6001), p: 0.5 }],
    };
    const downgrade = proposalFlagged(1, { target: askBetween([uuid(6004), 0.7]) });
    const [again] = fold([started(), utterance(1), proposalV2(1, asked), downgrade]);
    expect(again?.target).toMatchObject({
      decision: "ask",
      entityId: null,
      candidates: [{ entityId: uuid(6004), p: 0.7 }],
    });
  });

  it("keeps the review status across a flag, and the flags across a review", () => {
    const downgrade = proposalFlagged(1, { target: askBetween([uuid(6001), 0.5]) });
    const [reviewed] = fold([
      started(),
      utterance(1),
      proposalV2(1),
      review(1, "approved"),
      downgrade,
      review(1, "edited", { editDiff: { title: { before: "a", after: "b" } } }),
    ]);
    expect(reviewed).toMatchObject({
      status: "edited",
      target: { decision: "ask" },
      riskFlags: [
        { kind: "link_uncertain", field: "target" },
        { kind: "witness_conflict", field: "target" },
      ],
    });
  });

  it("refuses a flag for a proposal it hasn't seen", () => {
    expect(() => fold([started(), proposalFlagged(9)])).toThrow(
      `no proposal ${uuid(3009)} to flag`,
    );
  });
});

describe("the Phase 3 event types", () => {
  const phase3 = [usageRecorded(1), turnCompleted(1), turnMeasured(1)];

  it("leave every projection alone, except the session's last seq and time", () => {
    const before = [started(), utterance(1), proposal(1)];
    const without = replay(sessionLog(before), defaultProjections);
    const withThem = replay(sessionLog([...before, ...phase3]), defaultProjections);
    expect(withThem.utterances).toEqual(without.utterances);
    expect(withThem.proposals).toEqual(without.proposals);
    expect(withThem.session).toEqual({ ...without.session, lastSeq: 5, lastEventAt: tsFor(5) });
  });

  it("may follow session.ended, and a late usage record adds to the session's cost", () => {
    // session.ended's total (0.004) already holds earlier usage; the late record (0.0003) adds.
    const log = sessionLog([started(), usageRecorded(1), utterance(1), ended(), usageRecorded(2)]);
    expect(replay(log, defaultProjections).session).toMatchObject({
      status: "ended",
      costUsd: 0.0043,
      lastSeq: 4,
    });
  });
});

describe("turn.witnessed and unbiased utterances", () => {
  it("leave proposals alone; the session moves only its last seq and time", () => {
    const before = [started(), utterance(1), proposalV2(1)];
    const unbiased = utterance(2, "Met Dana Li at Atmo.", "unbiased");
    const without = replay(sessionLog(before), defaultProjections);
    const withThem = replay(
      sessionLog([...before, unbiased, turnWitnessed(1)]),
      defaultProjections,
    );
    expect(withThem.proposals).toEqual(without.proposals);
    expect(withThem.session).toEqual({ ...without.session, lastSeq: 4, lastEventAt: tsFor(4) });
    expect(withThem.utterances.map((u) => u.witness)).toEqual(["biased", "unbiased"]);
  });
});

describe("purity", () => {
  const raw = sessionLog([
    started(),
    utterance(1),
    proposal(1),
    usageRecorded(1),
    turnCompleted(1),
    turnMeasured(1),
    review(1, "approved"),
    proposalV2(2),
    utterance(2, "Atmo.", "unbiased"),
    proposalFlagged(2, {
      target: { decision: "ask", candidates: [{ entityId: uuid(6001), p: 0.5 }] },
    }),
    turnWitnessed(1),
    ended(),
  ]);
  const events = raw.map((event) => defaultRegistry.toLatest(event));

  it.each(Object.entries(defaultProjections))(
    "%s never mutates its state or the event",
    (name, projection) => {
      // Frozen inputs make any mutation throw, since modules run in strict mode.
      let state: unknown = structuredClone(projection.initial);
      for (const event of events) {
        state = projection.apply(deepFreeze(state) as never, deepFreeze(structuredClone(event)));
      }
      expect(state).toEqual(replay(raw, { [name]: projection })[name]);
    },
  );
});
