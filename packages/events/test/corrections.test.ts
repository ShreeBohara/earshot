// The writers' rules for corrections and follow-up skips (Phase 5 WP13; ADR-0038): which proposals
// take a correction, on which fields, and which questions a correction answers or a skip closes.
import { describe, expect, it } from "vitest";
import {
  checkCorrection,
  checkFollowupSkip,
  correctableFields,
  type ProposalView,
  proposalsProjection,
  replay,
} from "../src";
import {
  followupAsked,
  followupClosed,
  proposalV2,
  reviewV2,
  sessionLog,
  started,
  utterance,
  uuid,
} from "./helpers";

function proposalsOf(bodies: Parameters<typeof sessionLog>[0]): readonly ProposalView[] {
  return replay(sessionLog(bodies), { proposals: proposalsProjection }).proposals;
}

const correction = (n: number, of: number) => proposalV2(n, {}, { supersedes: uuid(3000 + of) });
const base = [started(), utterance(1), proposalV2(1)];

describe("correctableFields", () => {
  it("is the record, then the type's fields", () => {
    expect(correctableFields("task")).toEqual(["target", "title", "dueDate"]);
    expect(correctableFields("deal_update")).toEqual(["target", "stage", "amount", "closeDate"]);
    expect(correctableFields("contact")).toEqual([
      "target",
      "name",
      "title",
      "company",
      "email",
      "phone",
    ]);
  });
});

describe("checkCorrection", () => {
  it("takes the record or a field of a proposal still under review", () => {
    const proposals = proposalsOf(base);
    for (const field of ["target", "title", "dueDate"]) {
      expect(checkCorrection(proposals, { proposalId: uuid(3001), field })).toMatchObject({
        ok: true,
        answers: [],
      });
    }
  });

  it("refuses a field the type doesn't have, an unknown proposal, and a replaced one", () => {
    const proposals = proposalsOf(base);
    expect(checkCorrection(proposals, { proposalId: uuid(3001), field: "amount" })).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(checkCorrection(proposals, { proposalId: uuid(3009), field: "title" })).toMatchObject({
      ok: false,
      reason: "unknown_proposal",
    });
    const replaced = proposalsOf([...base, correction(2, 1)]);
    expect(checkCorrection(replaced, { proposalId: uuid(3001), field: "title" })).toMatchObject({
      ok: false,
      reason: "superseded",
    });
    // Its replacement takes one: a correction of a correction.
    expect(checkCorrection(replaced, { proposalId: uuid(3002), field: "title" }).ok).toBe(true);
  });

  it("refuses a decided proposal: a correction replaces one under review, never a decision", () => {
    for (const decision of ["approved", "edited", "rejected"] as const) {
      const proposals = proposalsOf([...base, reviewV2(1, decision)]);
      expect(checkCorrection(proposals, { proposalId: uuid(3001), field: "title" })).toMatchObject({
        ok: false,
        reason: "not_proposed",
      });
    }
  });

  it("answers the question it names, and any other open one asking for the same field", () => {
    const proposals = proposalsOf([
      ...base,
      followupAsked(1, 1),
      followupAsked(2, 1, { field: "title", rule: "due_date", text: "What's the task?" }),
    ]);
    const answered = checkCorrection(proposals, {
      proposalId: uuid(3001),
      field: "dueDate",
      questionId: uuid(9001),
    });
    expect(answered.ok && answered.answers.map((question) => question.questionId)).toEqual([
      uuid(9001),
    ]);
    // Without naming it, a correction of the field still answers it.
    const unnamed = checkCorrection(proposals, { proposalId: uuid(3001), field: "dueDate" });
    expect(unnamed.ok && unnamed.answers.map((question) => question.questionId)).toEqual([
      uuid(9001),
    ]);
  });

  it("refuses a question that isn't the proposal's, is closed, or asks for another field", () => {
    const proposals = proposalsOf([
      ...base,
      proposalV2(2),
      followupAsked(1, 1),
      followupAsked(2, 2),
      followupClosed(2),
    ]);
    const check = (proposalId: string, field: string, questionId: string) =>
      checkCorrection(proposals, { proposalId, field, questionId });
    expect(check(uuid(3001), "dueDate", uuid(9009))).toMatchObject({
      reason: "unknown_question",
    });
    expect(check(uuid(3001), "dueDate", uuid(9002))).toMatchObject({
      reason: "unknown_question",
    });
    expect(check(uuid(3002), "dueDate", uuid(9002))).toMatchObject({ reason: "question_closed" });
    expect(check(uuid(3001), "title", uuid(9001))).toMatchObject({ reason: "malformed" });
  });

  it("finds a question that moved with its proposal's correction", () => {
    const proposals = proposalsOf([...base, followupAsked(1, 1), correction(2, 1)]);
    expect(
      checkCorrection(proposals, {
        proposalId: uuid(3002),
        field: "dueDate",
        questionId: uuid(9001),
      }).ok,
    ).toBe(true);
  });
});

describe("checkFollowupSkip", () => {
  it("closes an open question, wherever its corrections moved it", () => {
    expect(
      checkFollowupSkip(proposalsOf([...base, followupAsked(1, 1)]), uuid(9001)),
    ).toMatchObject({ ok: true, question: { questionId: uuid(9001), status: "open" } });
    const moved = proposalsOf([...base, followupAsked(1, 1), correction(2, 1)]);
    expect(checkFollowupSkip(moved, uuid(9001)).ok).toBe(true);
  });

  it("refuses an unknown question, and one already closed", () => {
    expect(checkFollowupSkip(proposalsOf(base), uuid(9001))).toMatchObject({
      ok: false,
      reason: "unknown_question",
    });
    const skipped = proposalsOf([...base, followupAsked(1, 1), followupClosed(1)]);
    expect(checkFollowupSkip(skipped, uuid(9001))).toMatchObject({
      ok: false,
      reason: "question_closed",
    });
  });
});
