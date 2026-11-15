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
  review,
  SESSION_ID,
  sessionLog,
  started,
  tsFor,
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
      status: "edited",
      fields: proposal(1).payload.fields,
      riskFlags: [],
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

describe("purity", () => {
  const raw = sessionLog([started(), utterance(1), proposal(1), review(1, "approved"), ended()]);
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
