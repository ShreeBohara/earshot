// Reading a deal stage from a rep's words (Phase 6 spec §4.9): exact on a label or a word, else a
// near miss at trigram similarity 0.6 or more with one clear winner, else unmapped.
import type { CrmMappedStage } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { readStage, STAGE_MARGIN, STAGE_SIMILARITY } from "../src";

const stage = (
  stageId: string,
  label: string,
  words: string[] = [],
  pipelineId: string | null = "sales",
): CrmMappedStage => ({ stageId, pipelineId, label, words });

const STAGES: CrmMappedStage[] = [
  stage("s_discovery", "Discovery"),
  stage("s_proposal", "Proposal", ["sent the proposal", "proposal out"]),
  stage("s_negotiation", "Negotiation"),
  stage("s_evaluation", "Evaluation"),
  stage("s_evaluating", "Evaluating"),
  stage("s_won", "Closed won"),
  stage("s_lost", "Closed lost"),
];

describe("readStage", () => {
  it("matches a label exactly, as the name toolkit normalizes it", () => {
    expect(readStage("negotiation", STAGES)).toMatchObject({
      ok: true,
      how: "exact",
      score: 1,
      stage: { stageId: "s_negotiation" },
    });
    expect(readStage("  CLOSED-WON ", STAGES)).toMatchObject({
      ok: true,
      stage: { stageId: "s_won" },
    });
  });

  it("matches one of a stage's words, its aliases, exactly", () => {
    expect(readStage("Sent the proposal", STAGES)).toMatchObject({
      ok: true,
      how: "exact",
      stage: { stageId: "s_proposal" },
    });
  });

  it("takes a near miss at 0.6 or more when it's the clear winner", () => {
    const reading = readStage("negotation", STAGES);
    expect(reading).toMatchObject({
      ok: true,
      how: "similar",
      stage: { stageId: "s_negotiation" },
    });
    expect(reading.ok && reading.score).toBeGreaterThanOrEqual(STAGE_SIMILARITY);
  });

  it("takes the best near miss when the next is more than the margin behind", () => {
    // "evaluatin" is 0.75 like Evaluating and 0.615 like Evaluation: 0.135 apart.
    const reading = readStage("evaluatin", STAGES);
    expect(reading).toMatchObject({ ok: true, how: "similar", stage: { stageId: "s_evaluating" } });
    expect(STAGE_MARGIN).toBe(0.1);
  });

  it("refuses two close candidates", () => {
    // "closed" is 0.636 like both Closed won and Closed lost.
    expect(readStage("closed", STAGES)).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: [
        expect.objectContaining({ stageId: "s_won" }),
        expect.objectContaining({ stageId: "s_lost" }),
      ],
    });
  });

  it("finds nothing below 0.6 or with nothing alike, and nothing in no words", () => {
    // "discovry" is 0.583 like Discovery: close, but under the line.
    expect(readStage("discovry", STAGES)).toEqual({ ok: false, reason: "none", candidates: [] });
    expect(readStage("final review", STAGES)).toEqual({
      ok: false,
      reason: "none",
      candidates: [],
    });
    expect(readStage("  ", STAGES)).toEqual({ ok: false, reason: "empty", candidates: [] });
    expect(readStage("proposal", [])).toEqual({ ok: false, reason: "none", candidates: [] });
  });

  it("narrows to a pipeline when one is given, and refuses one label in two pipelines otherwise", () => {
    const two = [stage("a_disc", "Discovery", [], "a"), stage("b_disc", "Discovery", [], "b")];
    expect(readStage("discovery", two)).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(readStage("discovery", two, { pipelineId: "b" })).toMatchObject({
      ok: true,
      stage: { stageId: "b_disc" },
    });
    expect(readStage("discovery", two, { pipelineId: null })).toMatchObject({ ok: false });
  });

  it("counts a stage once, though its label and a word both match", () => {
    const echo = [stage("s1", "Proposal", ["proposal"])];
    expect(readStage("proposal", echo)).toMatchObject({ ok: true, stage: { stageId: "s1" } });
  });
});
