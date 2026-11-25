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
  followupAsked,
  followupClosed,
  proposal,
  proposalFlagged,
  proposalV2,
  REVIEWER,
  recapCreated,
  reopen,
  review,
  reviewV2,
  SESSION_ID,
  sealed,
  sessionLog,
  snoozed,
  started,
  startedV2,
  tsFor,
  turnCompleted,
  turnMeasured,
  turnWitnessed,
  usageRecorded,
  utterance,
  utteranceV3,
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
      // A v1 start upcasts with no time zone.
      timeZone: null,
      endedAt: null,
      sealedAt: null,
      durationMs: null,
      recap: null,
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

  it("records the seal, and keeps following the log after it: the web Worker's reviews", () => {
    const log = sessionLog([started(), proposal(1), ended(), sealed(), reviewV2(1)]);
    expect(replay(log, { session: sessionProjection }).session).toMatchObject({
      status: "ended",
      endedAt: "2026-11-10T19:15:40.000Z",
      sealedAt: "2026-11-10T19:16:40.000Z",
      lastSeq: 4,
      lastEventAt: tsFor(4),
    });
  });

  it("refuses a seal before the end, and a second seal", () => {
    expect(() => replay(sessionLog([started(), sealed()]), { session: sessionProjection })).toThrow(
      /can't be sealed before it ends/,
    );
    expect(() =>
      replay(sessionLog([started(), ended(), sealed(), sealed({ by: "web" })]), {
        session: sessionProjection,
      }),
    ).toThrow(/already been sealed/);
  });
});

describe("sessionProjection: the rep's time zone (Phase 6 WP1)", () => {
  const session = (body: ReturnType<typeof started>) =>
    replay(sessionLog([body, utterance(1)]), { session: sessionProjection }).session;

  it("keeps the zone a v2 start recorded, and null when it recorded none", () => {
    expect(session(startedV2("America/Chicago"))?.timeZone).toBe("America/Chicago");
    expect(session(startedV2(null))?.timeZone).toBeNull();
  });

  it("reads a v1 start, from before the zone was recorded, as no zone", () => {
    expect(session(started())?.timeZone).toBeNull();
  });
});

describe("sessionProjection: the recap (Phase 5 WP10)", () => {
  const fold = (bodies: Parameters<typeof sessionLog>[0]) =>
    replay(sessionLog(bodies), { session: sessionProjection }).session;

  it("keeps the recap written between the end and the seal, with its seq and time", () => {
    const session = fold([started(), utterance(1), ended(), recapCreated(), sealed()]);
    expect(session?.recap).toMatchObject({
      outcome: "created",
      reason: null,
      dropped: 1,
      seq: 3,
      ts: tsFor(3),
    });
    expect(session?.recap?.sentences.map((sentence) => sentence.kind)).toEqual([
      "headline",
      "next_step",
    ]);
    expect(session?.sealedAt).not.toBeNull();
  });

  it("keeps a skipped or failed recap too: why there's none", () => {
    const skipped = recapCreated({
      outcome: "skipped",
      reason: "no_key",
      llm: null,
      sentences: [],
      dropped: 0,
    });
    expect(fold([started(), ended(), skipped])?.recap).toMatchObject({
      outcome: "skipped",
      reason: "no_key",
    });
    const failed = recapCreated({
      outcome: "failed",
      reason: "timeout",
      sentences: [],
      dropped: 0,
    });
    expect(fold([started(), ended(), failed])?.recap?.reason).toBe("timeout");
  });

  it("refuses a recap before the end, after the seal, or a second one", () => {
    expect(() => fold([started(), recapCreated()])).toThrow(/after the session ends/);
    expect(() => fold([started(), ended(), sealed(), recapCreated()])).toThrow(/before the seal/);
    expect(() => fold([started(), ended(), recapCreated(), recapCreated()])).toThrow(
      /already has its recap/,
    );
  });

  it("refuses a recap that breaks its writer's rules", () => {
    const broken: [Record<string, unknown>, RegExp][] = [
      [{ reason: "timeout" }, /created recap has no reason/],
      [{ outcome: "failed", reason: null, sentences: [], dropped: 0 }, /says why/],
      [{ outcome: "failed", reason: "timeout" }, /no sentences, drops, or lens/],
      [
        { outcome: "skipped", reason: "timeout", sentences: [], dropped: 0, llm: null },
        /had no key or speech/,
      ],
      [{ outcome: "failed", reason: "no_key", sentences: [], dropped: 0 }, /is skipped/],
    ];
    for (const [payload, message] of broken) {
      expect(() => fold([started(), ended(), recapCreated(payload)])).toThrow(message);
    }
    const [headline, step] = (recapCreated().payload as { sentences: unknown[] }).sentences;
    expect(() =>
      fold([started(), ended(), recapCreated({ sentences: [headline, step, headline] })]),
    ).toThrow(/one headline/);
    expect(() => fold([started(), ended(), recapCreated({ sentences: [step, headline] })])).toThrow(
      /headline comes first/,
    );
    const evidence = { utteranceId: uuid(2001), span: [0, 4], audioMs: [0, 400], confidence: 0.9 };
    const half = { id: "bant", fields: [{ field: "budget", quote: "the budget", evidence: null }] };
    expect(() => fold([started(), ended(), recapCreated({ lens: half })])).toThrow(
      /quote and its evidence, or neither/,
    );
    const twice = {
      id: "bant",
      fields: [
        { field: "need", quote: "Acme", evidence },
        { field: "need", quote: null, evidence: null },
      ],
    };
    expect(() => fold([started(), ended(), recapCreated({ lens: twice })])).toThrow(
      /each field once/,
    );
  });

  it("adds the recap's usage after the end to the session's cost, as any late usage", () => {
    const session = fold([
      started(),
      ended({ costUsd: 0.004 }),
      recapCreated(),
      usageRecorded(9, { kind: "llm", costUsd: 0.0004 }),
    ]);
    expect(session?.costUsd).toBe(0.0044);
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
        input: "speech",
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
        input: "speech",
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
      supersedes: null,
      supersededBy: null,
      snoozedUntil: null,
      followups: [],
      seq: 2,
      ts: tsFor(2),
      // Stored at v1: upcast to v2, with the event's own id as the review id (seq 5's id).
      review: {
        reviewId: uuid(1005),
        decision: "edited",
        target: null,
        editDiff,
        mode: "single",
        batchId: null,
        policy: null,
        undoes: null,
        reason: null,
        seen: null,
        timing: { decisionMs: 1500, handlingMs: 1500 },
        input: null,
        surface: null,
        syncEligibleAt: null,
        by: null,
        seq: 5,
        ts: tsFor(5),
      },
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

describe("proposalsProjection: Phase 5 reviews, undo, snoozes, and supersedes", () => {
  const fold = (bodies: Parameters<typeof sessionLog>[0]) =>
    replay(sessionLog(bodies), { proposals: proposalsProjection }).proposals;
  const only = (bodies: Parameters<typeof sessionLog>[0]) => {
    const [first] = fold(bodies);
    if (!first) throw new Error("no proposal");
    return first;
  };

  it("folds a v2 review, keeping every field in the review view", () => {
    const chosen = reviewV2(1, "approved", {
      target: { entityId: uuid(6002) },
      seen: {
        tier: "loud",
        fields: { title: { proposed: "Send the deck" } },
        target: { entityId: null, offered: [uuid(6001), uuid(6002), null] },
        relinked: null,
        clip: "played",
      },
      input: "pointer",
      surface: "tray",
    });
    const proposalView = only([started(), utterance(1), proposalV2(1), chosen]);
    expect(proposalView.status).toBe("approved");
    // The proposal's id is the view's own; a review with no edits has a null diff.
    const { proposalId: _, ...fields } = chosen.payload;
    expect(proposalView.review).toEqual({ ...fields, editDiff: null, seq: 3, ts: tsFor(3) });
  });

  it("keeps an edit's diff, and a rejection's null diff and sync time", () => {
    const [edited, rejected] = fold([
      started(),
      proposal(1),
      proposal(2),
      reviewV2(1, "edited"),
      reviewV2(2, "rejected"),
    ]);
    expect(edited).toMatchObject({
      status: "edited",
      review: {
        decision: "edited",
        editDiff: { title: { before: "Send the deck", after: "Send the revised deck" } },
        syncEligibleAt: "2026-11-10T19:16:30.000Z",
      },
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      review: { editDiff: null, syncEligibleAt: null, by: REVIEWER },
    });
  });

  it("returns a reopened proposal to proposed, with the reopen as its latest review", () => {
    const reopened = only([started(), proposal(1), reviewV2(1), reopen(1, uuid(7001))]);
    expect(reopened).toMatchObject({
      status: "proposed",
      review: { reviewId: uuid(7101), decision: "reopened", undoes: uuid(7001), reason: "undo" },
    });
  });

  it("decides again after a reopen, and reopens that decision in turn", () => {
    const again = only([
      started(),
      proposal(1),
      reviewV2(1),
      reopen(1, uuid(7001)),
      reviewV2(1, "rejected", { reviewId: uuid(7201) }),
      reopen(1, uuid(7201), { reviewId: uuid(7301) }),
      reviewV2(1, "edited", { reviewId: uuid(7401) }),
    ]);
    expect(again).toMatchObject({ status: "edited", review: { reviewId: uuid(7401), seq: 6 } });
  });

  it("lets a reopen name a review upcast from v1, by its event id", () => {
    // sessionLog gives the event at seq 2 the id uuid(1002): the v1 review's upcast reviewId.
    const undone = only([started(), proposal(1), review(1, "approved"), reopen(1, uuid(1002))]);
    expect(undone).toMatchObject({ status: "proposed", review: { undoes: uuid(1002) } });
  });

  it("reopens on a later flag, as SessionDO's system review", () => {
    const flaggedReopen = reopen(1, uuid(7001), {
      mode: "system",
      reason: "flagged",
      input: "none",
      surface: "session",
      timing: { decisionMs: 0, handlingMs: 0 },
      by: { userId: REVIEWER.userId, auth: null },
    });
    const reopened = only([
      started(),
      utterance(1),
      proposalV2(1),
      reviewV2(1),
      proposalFlagged(1),
      flaggedReopen,
    ]);
    expect(reopened).toMatchObject({
      status: "proposed",
      riskFlags: [
        { kind: "link_uncertain", field: "target" },
        { kind: "witness_conflict", field: "target" },
      ],
      review: { mode: "system", reason: "flagged", by: { auth: null } },
    });
  });

  it("refuses a reopen of a review that isn't the latest", () => {
    const log = [
      started(),
      proposal(1),
      reviewV2(1),
      reopen(1, uuid(7001)),
      reviewV2(1, "approved", { reviewId: uuid(7201) }),
      reopen(1, uuid(7001), { reviewId: uuid(7301) }),
    ];
    expect(() => fold(log)).toThrow(ProjectionError);
    expect(() => fold(log)).toThrow(
      `the reopen of proposal ${uuid(3001)} names review ${uuid(7001)}, but its latest is ${uuid(7201)}`,
    );
  });

  it("refuses a reopen of a proposal never reviewed, and a reopen of a reopen", () => {
    expect(() => fold([started(), proposal(1), reopen(1, uuid(7001))])).toThrow(
      "but it has no review",
    );
    const twice = [
      started(),
      proposal(1),
      reviewV2(1),
      reopen(1, uuid(7001)),
      reopen(1, uuid(7101), { reviewId: uuid(7201) }),
    ];
    expect(() => fold(twice)).toThrow("which is a reopen itself");
  });

  it("leaves the writers' other rules to checkReview: v1's second decision, with no reopen, loads", () => {
    const twice = only([started(), proposal(1), review(1, "rejected"), reviewV2(1)]);
    expect(twice).toMatchObject({ status: "approved", review: { reviewId: uuid(7001) } });
  });

  it("snoozes a proposal until a time, and wakes it", () => {
    const asleep = only([started(), proposal(1), snoozed(1)]);
    expect(asleep).toMatchObject({ status: "proposed", snoozedUntil: "2026-11-11T14:00:00.000Z" });
    const awake = only([
      started(),
      proposal(1),
      snoozed(1),
      snoozed(1, null, { snoozeId: uuid(8101) }),
    ]);
    expect(awake.snoozedUntil).toBeNull();
  });

  it("keeps a snooze across a review: the status says the proposal is decided", () => {
    const decided = only([started(), proposal(1), snoozed(1), reviewV2(1)]);
    expect(decided).toMatchObject({ status: "approved", snoozedUntil: "2026-11-11T14:00:00.000Z" });
  });

  it("refuses a snooze of a proposal it hasn't seen", () => {
    expect(() => fold([started(), snoozed(9)])).toThrow(`no proposal ${uuid(3009)} to snooze`);
  });

  it("supersedes a proposal: the old one points at its replacement, which points back", () => {
    const correction = proposalV2(2, {}, { supersedes: uuid(3001) });
    const [old, replacement] = fold([started(), utterance(1), proposalV2(1), correction]);
    expect(old).toMatchObject({
      proposalId: uuid(3001),
      status: "superseded",
      supersedes: null,
      supersededBy: uuid(3002),
    });
    expect(replacement).toMatchObject({
      proposalId: uuid(3002),
      status: "proposed",
      supersedes: uuid(3001),
      supersededBy: null,
    });
  });

  it("supersedes a decided proposal too, keeping its last review, and allows a chain", () => {
    const [first, second, third] = fold([
      started(),
      utterance(1),
      proposalV2(1),
      reviewV2(1),
      proposalV2(2, {}, { supersedes: uuid(3001) }),
      proposalV2(3, {}, { supersedes: uuid(3002) }),
    ]);
    expect(first).toMatchObject({ status: "superseded", review: { decision: "approved" } });
    expect(second).toMatchObject({ status: "superseded", supersededBy: uuid(3003) });
    expect(third).toMatchObject({ status: "proposed", supersedes: uuid(3002) });
  });

  it("refuses a review or a snooze of a superseded proposal", () => {
    const replaced = [
      started(),
      utterance(1),
      proposalV2(1),
      proposalV2(2, {}, { supersedes: uuid(3001) }),
    ];
    expect(() => fold([...replaced, reviewV2(1)])).toThrow(
      `proposal ${uuid(3001)} was superseded by ${uuid(3002)}, so it takes no review`,
    );
    expect(() => fold([...replaced, snoozed(1)])).toThrow("so it takes no snooze");
    expect(() => fold([...replaced, review(1, "approved")])).toThrow(ProjectionError);
  });

  it("refuses to supersede a proposal it hasn't seen, or one already replaced", () => {
    expect(() =>
      fold([started(), utterance(1), proposalV2(2, {}, { supersedes: uuid(3001) })]),
    ).toThrow(`no proposal ${uuid(3001)} to supersede`);
    expect(() =>
      fold([
        started(),
        utterance(1),
        proposalV2(1),
        proposalV2(2, {}, { supersedes: uuid(3001) }),
        proposalV2(3, {}, { supersedes: uuid(3001) }),
      ]),
    ).toThrow(`proposal ${uuid(3001)} was already superseded by ${uuid(3002)}`);
  });

  it("still takes a flag on a superseded proposal", () => {
    const [old] = fold([
      started(),
      utterance(1),
      proposalV2(1),
      proposalV2(2, {}, { supersedes: uuid(3001) }),
      proposalFlagged(1),
    ]);
    expect(old).toMatchObject({ status: "superseded", conflicts: [expect.anything()] });
  });
});

describe("Phase 5 WP13: typed words and follow-up questions", () => {
  const fold = (bodies: Parameters<typeof sessionLog>[0]) =>
    replay(sessionLog(bodies), defaultProjections);
  const proposals = (bodies: Parameters<typeof sessionLog>[0]) => fold(bodies).proposals;
  const correction = (n: number, of: number) => proposalV2(n, {}, { supersedes: uuid(3000 + of) });

  it("keeps how each utterance's words arrived: speech, or typed into a correction", () => {
    const { utterances } = fold([
      started(),
      utterance(1, "Send Dana the deck."),
      utteranceV3(2, "the 14th", "typed"),
    ]);
    expect(utterances.map((u) => [u.input, u.confidence, u.startMs, u.endMs, u.words])).toEqual([
      ["speech", 0.9, 1000, 1800, null],
      ["typed", 1, 2000, 2000, null],
    ]);
  });

  it("asks a question about its proposal, open until it closes", () => {
    const [task] = proposals([started(), utterance(1), proposalV2(1), followupAsked(1, 1)]);
    expect(task?.followups).toEqual([
      {
        questionId: uuid(9001),
        turnId: uuid(5001),
        askedAbout: uuid(3001),
        field: "dueDate",
        rule: "due_date",
        text: "When is it due?",
        status: "open",
        answeredBy: null,
        seq: 3,
        ts: tsFor(3),
        closedSeq: null,
        closedAt: null,
      },
    ]);
  });

  it("closes a skipped question on its proposal", () => {
    const [task] = proposals([
      started(),
      utterance(1),
      proposalV2(1),
      followupAsked(1, 1),
      followupClosed(1),
    ]);
    expect(task?.followups[0]).toMatchObject({
      status: "skipped",
      answeredBy: null,
      closedSeq: 4,
      closedAt: tsFor(4),
    });
  });

  it("moves an open question to the correction that replaced its proposal, which answers it", () => {
    const [original, corrected] = proposals([
      started(),
      utterance(1),
      proposalV2(1),
      followupAsked(1, 1),
      utteranceV3(2, "the 14th", "typed"),
      correction(2, 1),
      followupClosed(1, 2),
    ]);
    expect(original).toMatchObject({ status: "superseded", followups: [] });
    expect(corrected?.followups).toEqual([
      expect.objectContaining({
        questionId: uuid(9001),
        askedAbout: uuid(3001),
        status: "answered",
        answeredBy: uuid(3002),
        closedSeq: 6,
      }),
    ]);
  });

  it("keeps an open question on the card through a correction of another field", () => {
    const [, corrected] = proposals([
      started(),
      utterance(1),
      proposalV2(1),
      followupAsked(1, 1),
      correction(2, 1),
    ]);
    expect(corrected?.followups).toEqual([
      expect.objectContaining({ questionId: uuid(9001), status: "open" }),
    ]);
  });

  it("leaves a closed question where it closed when its proposal is replaced", () => {
    const [original, corrected] = proposals([
      started(),
      utterance(1),
      proposalV2(1),
      followupAsked(1, 1),
      followupClosed(1),
      correction(2, 1),
    ]);
    expect(original?.followups).toEqual([expect.objectContaining({ status: "skipped" })]);
    expect(corrected?.followups).toEqual([]);
  });

  it("fails the fold on a writer's bug: a question twice, on nothing, or on a replaced proposal", () => {
    const base = [started(), utterance(1), proposalV2(1)];
    expect(() => fold([...base, followupAsked(1, 1), followupAsked(1, 1)])).toThrow(/asked before/);
    expect(() => fold([...base, followupAsked(1, 7)])).toThrow(/no proposal .* to ask about/);
    expect(() => fold([...base, correction(2, 1), followupAsked(1, 1)])).toThrow(
      /takes no question/,
    );
  });

  it("fails the fold on a close of nothing, a second close, or an answer the correction didn't make", () => {
    const asked = [started(), utterance(1), proposalV2(1), followupAsked(1, 1)];
    expect(() => fold([...asked, followupClosed(2)])).toThrow(/no question .* to close/);
    expect(() => fold([...asked, followupClosed(1), followupClosed(1)])).toThrow(/skipped before/);
    // Answered, but nothing replaced the proposal: no correction answered it.
    expect(() => fold([...asked, followupClosed(1, 1)])).toThrow(/answered by the correction/);
    // Answered by a proposal that doesn't hold it.
    expect(() => fold([...asked, proposalV2(2), followupClosed(1, 2)])).toThrow(
      /answered by the correction/,
    );
    const skipNaming = followupClosed(1);
    skipNaming.payload.proposalId = uuid(3001);
    expect(() => fold([...asked, skipNaming])).toThrow(/skipped question names no proposal/);
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
    snoozed(2),
    reviewV2(2),
    reopen(2, uuid(7002)),
    proposalV2(3, {}, { supersedes: uuid(3002) }),
    ended(),
    sealed(),
    reviewV2(3, "edited"),
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
