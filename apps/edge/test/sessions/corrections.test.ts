// Corrections and follow-up questions in SessionDO (Phase 5 spec WP13 step 4): `followup.asked`
// after a turn's proposals; `correct` reading a correction turn's utterances into a superseding
// proposal, with no model call and no key, and closing the question it answers; `followup` skipping
// one; and a superseded proposal refusing reviews in the object.

import { DEMO_FOCUS_ID, scenario } from "@earshot/agent/testing";
import {
  type ClientMessageOf,
  correctionProposalId,
  FollowupAskedV1,
  type ProposalCreatedV2,
  uuidv7,
} from "@earshot/core";
import { defaultProjections, replay } from "@earshot/events";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC,
  canaryKey,
  endMessage,
  open,
  reviewInput,
  reviewMessage,
  startMessage,
  type TestSocket,
  turnEndMessage,
  utteranceMessage,
  utteranceOf,
} from "./helpers";

/** Runs one of the demo's scenario turns; resolves with the proposals it created. */
async function demoTurn(socket: TestSocket, name: string): Promise<ProposalCreatedV2[]> {
  const { turn } = scenario("anthropic", name);
  const before = socket.eventsOf("proposal.created").length;
  for (const utterance of turn.utterances) {
    await socket.request(utteranceMessage(turn.turnId, utterance));
  }
  await socket.request(turnEndMessage(turn.turnId, canaryKey(), ANTHROPIC), 15_000);
  return socket
    .eventsOf("proposal.created")
    .slice(before)
    .map((event) => event.payload as unknown as ProposalCreatedV2);
}

/**
 * A started session with the demo's turns 3 and 4: a deal update that moves the stage and names no
 * amount, which a question asks for, and a task whose record the linker asked about (loud).
 */
async function withProposals() {
  const opened = await open();
  await opened.socket.request(startMessage());
  const [deal] = await demoTurn(opened.socket, "demo-turn-3");
  const [task] = await demoTurn(opened.socket, "demo-turn-4");
  if (deal?.type !== "deal_update" || task?.target.decision !== "ask") {
    throw new Error("the demo turns no longer give a deal update and a task that asks");
  }
  return { ...opened, deal, task };
}

/** A typed correction's words: one utterance, confidence 1, no words. */
function typedMessage(turnId: string, text: string): ClientMessageOf<"utterance"> {
  return utteranceMessage(turnId, {
    ...utteranceOf(text, 20_000),
    confidence: 1,
    endMs: 20_000,
    input: "typed",
  } as never);
}

function correctMessage(
  overrides: Partial<ClientMessageOf<"correct">> & { turnId: string; proposalId: string },
): ClientMessageOf<"correct"> {
  return {
    t: "correct",
    msgId: uuidv7(),
    correctionId: uuidv7(),
    field: "amount",
    ...overrides,
  };
}

const proposalsOf = (socket: TestSocket) => replay(socket.events(), defaultProjections).proposals;

describe("follow-up questions", () => {
  it("asks for a value a proposal needs right after it, and nothing about a loud card", async () => {
    const { socket, deal, task } = await withProposals();
    const questions = socket
      .eventsOf("followup.asked")
      .map((event) => FollowupAskedV1.parse(event.payload));
    expect(questions).toEqual([
      {
        questionId: expect.any(String),
        turnId: scenario("anthropic", "demo-turn-3").turn.turnId,
        proposalId: deal.proposalId,
        field: "amount",
        rule: "deal_amount",
        text: "What's the amount?",
      },
    ]);
    // Right after the deal update, before the turn's usage and its completion.
    const types = socket.events().map((event) => event.type);
    const at = types.indexOf("followup.asked");
    expect(types.slice(at - 1, at + 3)).toEqual([
      "proposal.created",
      "followup.asked",
      "usage.recorded",
      "turn.completed",
    ]);
    expect(questions.some((question) => question.proposalId === task.proposalId)).toBe(false);
  });

  it("skips a question once, and answers a second skip with the first one's seq", async () => {
    const { socket } = await withProposals();
    const questionId = socket.eventsOf("followup.asked")[0]?.payload.questionId as string;
    const first = await socket.request({
      t: "followup",
      msgId: uuidv7(),
      questionId,
      outcome: "skipped",
    });
    expect(socket.eventsOf("followup.closed").map((event) => event.payload)).toEqual([
      { questionId, outcome: "skipped", proposalId: null },
    ]);
    const again = await socket.request({
      t: "followup",
      msgId: uuidv7(),
      questionId,
      outcome: "skipped",
    });
    expect(again.seq).toBe(first.seq);
    const unknown = { t: "followup", msgId: uuidv7(), questionId: uuidv7(), outcome: "skipped" };
    socket.send(unknown);
    expect(await socket.error(unknown.msgId)).toMatchObject({ code: "bad_message" });
  });
});

describe("correct", () => {
  it("reads typed words into a proposal that supersedes the one corrected, and answers its question", async () => {
    const { socket, deal, ids } = await withProposals();
    const questionId = socket.eventsOf("followup.asked")[0]?.payload.questionId as string;
    const turnId = uuidv7();
    await socket.request(typedMessage(turnId, "Make it forty thousand."));
    const correction = correctMessage({ turnId, proposalId: deal.proposalId, questionId });
    await socket.request(correction);
    const proposalId = await correctionProposalId(ids.sid, correction.correctionId);

    const typed = socket.eventsOf("utterance.final").at(-1);
    expect(typed).toMatchObject({ schemaVersion: 3, payload: { input: "typed", confidence: 1 } });
    const created = socket.eventsOf("proposal.created").at(-1)?.payload as ProposalCreatedV2;
    expect(created).toMatchObject({
      proposalId,
      type: "deal_update",
      supersedes: deal.proposalId,
      target: deal.target,
      fields: {
        stage: deal.fields.stage,
        amount: {
          value: 40_000,
          evidence: { utteranceId: typed?.payload.utteranceId, span: [8, 22] },
        },
      },
    });
    expect(socket.eventsOf("followup.closed").map((event) => event.payload)).toEqual([
      { questionId, outcome: "answered", proposalId },
    ]);
    const proposals = proposalsOf(socket);
    expect(proposals.find((p) => p.proposalId === deal.proposalId)).toMatchObject({
      status: "superseded",
      supersededBy: proposalId,
    });
    expect(proposals.find((p) => p.proposalId === proposalId)?.followups).toEqual([
      expect.objectContaining({ questionId, status: "answered", answeredBy: proposalId }),
    ]);
  });

  it("re-links a record from typed words, with no model call", async () => {
    const { socket, task } = await withProposals();
    const turnId = uuidv7();
    await socket.request(typedMessage(turnId, "No, it's Acme Corp."));
    await socket.request(correctMessage({ turnId, proposalId: task.proposalId, field: "target" }));
    const created = socket.eventsOf("proposal.created").at(-1)?.payload as ProposalCreatedV2;
    expect(created.supersedes).toBe(task.proposalId);
    // Linked in context: the open account settles "Acme Corp" against Akme and Acmi Dynamics.
    expect(created.target).toMatchObject({
      entityId: DEMO_FOCUS_ID,
      decision: "linked",
      kind: "company",
      mention: { quote: "Acme Corp" },
    });
    // The question the linker asked about Dana is gone with the record it asked about.
    expect(created.riskFlags).not.toContainEqual({ kind: "ambiguous_target", field: "target" });
    // No turn ran: no usage, no turn completion, for the correction.
    expect(socket.eventsOf("turn.completed")).toHaveLength(2);
  });

  it("answers a resend under a new msgId with the first one's seq, appending nothing", async () => {
    const { socket, deal } = await withProposals();
    const turnId = uuidv7();
    await socket.request(typedMessage(turnId, "fifty thousand"));
    const correction = correctMessage({ turnId, proposalId: deal.proposalId });
    const first = await socket.request(correction);
    const count = socket.events().length;
    const again = await socket.request({ ...correction, msgId: uuidv7() });
    expect(again.seq).toBe(first.seq);
    expect(socket.events()).toHaveLength(count);
  });

  it("refuses words it can't read with unreadable, and appends nothing", async () => {
    const { socket, deal } = await withProposals();
    const turnId = uuidv7();
    await socket.request(typedMessage(turnId, "about what we said last time"));
    const proposalsBefore = socket.eventsOf("proposal.created").length;
    const correction = correctMessage({ turnId, proposalId: deal.proposalId });
    socket.send(correction);
    expect(await socket.error(correction.msgId)).toMatchObject({
      code: "unreadable",
      retryable: false,
    });
    expect(socket.eventsOf("proposal.created")).toHaveLength(proposalsBefore);
    expect(proposalsOf(socket).find((p) => p.proposalId === deal.proposalId)?.status).toBe(
      "proposed",
    );
  });

  it("leaves a superseded proposal refusing reviews and corrections in the object", async () => {
    const { socket, deal, stub } = await withProposals();
    const turnId = uuidv7();
    await socket.request(typedMessage(turnId, "sixty thousand"));
    await socket.request(correctMessage({ turnId, proposalId: deal.proposalId }));
    void stub;
    const review = reviewMessage(reviewInput(deal.proposalId));
    socket.send(review);
    expect(await socket.error(review.msgId)).toMatchObject({ code: "bad_message" });
    expect(socket.eventsOf("proposal.reviewed")).toHaveLength(0);
    const nextTurn = uuidv7();
    await socket.request(typedMessage(nextTurn, "seventy thousand"));
    const again = correctMessage({ turnId: nextTurn, proposalId: deal.proposalId });
    socket.send(again);
    expect(await socket.error(again.msgId)).toMatchObject({ code: "bad_message" });
  });

  it("refuses a correction with no words, and one on a turn that already ended", async () => {
    const { socket, deal } = await withProposals();
    const empty = correctMessage({ turnId: uuidv7(), proposalId: deal.proposalId });
    socket.send(empty);
    expect(await socket.error(empty.msgId)).toMatchObject({ code: "bad_message" });
    const ended = correctMessage({
      turnId: scenario("anthropic", "demo-turn-3").turn.turnId,
      proposalId: deal.proposalId,
    });
    socket.send(ended);
    expect(await socket.error(ended.msgId)).toMatchObject({ code: "bad_message" });
  });

  it("never ends a typed turn with turn_end: typed words are a correction's", async () => {
    const { socket } = await withProposals();
    const turnId = uuidv7();
    await socket.request(typedMessage(turnId, "fifty thousand"));
    const turnEnd = turnEndMessage(turnId, canaryKey(), ANTHROPIC);
    socket.send(turnEnd);
    expect(await socket.error(turnEnd.msgId)).toMatchObject({ code: "bad_message" });
  });

  it("takes typed words after the end, before the seal, though speech is over", async () => {
    const { socket, deal } = await withProposals();
    await socket.request(endMessage());
    const speech = utteranceMessage(uuidv7(), utteranceOf("One more thing."));
    socket.send(speech);
    expect(await socket.error(speech.msgId)).toMatchObject({ code: "already_ended" });
    const turnId = uuidv7();
    await socket.request(typedMessage(turnId, "forty five thousand"));
    await socket.request(correctMessage({ turnId, proposalId: deal.proposalId }));
    expect(socket.eventsOf("proposal.created").at(-1)?.payload).toMatchObject({
      supersedes: deal.proposalId,
      fields: { amount: { value: 45_000 } },
    });
  });
});
