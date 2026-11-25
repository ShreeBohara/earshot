// Corrections and follow-up questions in SessionDO (Phase 5 spec WP13 step 4): `followup.asked`
// after a turn's proposals; `correct` reading a correction turn's words into a superseding
// proposal, with no model call and no key, and closing the question it answers; `followup` skipping
// one; a superseded proposal refusing reviews in the object; and the limits a security review asked
// for: typed words only on a correction, within the capture limit and a grace, corrections per
// window and per session, typed characters, the depth of a chain, and no idle end pushed back.

import { DEMO_FOCUS_ID, scenario } from "@earshot/agent/testing";
import {
  type ClientMessageOf,
  correctionProposalId,
  FollowupAskedV1,
  type ProposalCreatedV2,
  uuidv7,
} from "@earshot/core";
import { CORRECTION_LIMITS, defaultProjections, replay } from "@earshot/events";
import { describe, expect, it } from "vitest";
import { SESSION_LIMITS, TYPED_CORRECTION_GRACE_MS } from "../../src/session/limits";
import {
  ANTHROPIC,
  canaryKey,
  endMessage,
  freezeClock,
  meta,
  open,
  reviewInput,
  reviewMessage,
  setMeta,
  startMessage,
  type TestSocket,
  turnEndMessage,
  utteranceMessage,
  utteranceOf,
  withSql,
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

/** A typed correction of `proposalId`'s amount, on a fresh correction turn. */
function typedCorrection(
  proposalId: string,
  text: string,
  overrides: Partial<ClientMessageOf<"correct">> = {},
): ClientMessageOf<"correct"> {
  return {
    t: "correct",
    msgId: uuidv7(),
    turnId: uuidv7(),
    correctionId: uuidv7(),
    proposalId,
    field: "amount",
    typed: { utteranceId: uuidv7(), text },
    ...overrides,
  };
}

function skipMessage(questionId: string): ClientMessageOf<"followup"> {
  return { t: "followup", msgId: uuidv7(), questionId, outcome: "skipped" };
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
    const first = await socket.request(skipMessage(questionId));
    expect(socket.eventsOf("followup.closed").map((event) => event.payload)).toEqual([
      { questionId, outcome: "skipped", proposalId: null },
    ]);
    const again = await socket.request(skipMessage(questionId));
    expect(again.seq).toBe(first.seq);
    const unknown = skipMessage(uuidv7());
    socket.send(unknown);
    expect(await socket.error(unknown.msgId)).toMatchObject({ code: "bad_message" });
  });
});

describe("correct", () => {
  it("writes typed words with the proposal that supersedes the one corrected, and answers its question", async () => {
    const { socket, deal, ids } = await withProposals();
    const questionId = socket.eventsOf("followup.asked")[0]?.payload.questionId as string;
    const correction = typedCorrection(deal.proposalId, "Make it forty thousand.", { questionId });
    const lastAudio = Math.max(
      ...socket.eventsOf("utterance.final").map((event) => event.payload.endMs as number),
    );
    await socket.request(correction);
    const proposalId = await correctionProposalId(ids.sid, correction.correctionId);

    // The typed words and the correction arrive in one commit: typed, at the last audio time.
    const types = socket.events().map((event) => event.type);
    expect(types.slice(-3)).toEqual(["utterance.final", "proposal.created", "followup.closed"]);
    const typed = socket.eventsOf("utterance.final").at(-1);
    expect(typed).toMatchObject({
      schemaVersion: 3,
      payload: {
        utteranceId: correction.typed?.utteranceId,
        text: "Make it forty thousand.",
        input: "typed",
        confidence: 1,
        startMs: lastAudio,
        endMs: lastAudio,
      },
    });
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
          evidence: { utteranceId: correction.typed?.utteranceId, span: [8, 22] },
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

  it("reads a spoken correction turn's utterances, with no turn run", async () => {
    const { socket, task } = await withProposals();
    const turnId = uuidv7();
    await socket.request(utteranceMessage(turnId, utteranceOf("No, it's Acme Corp.", 30_000)));
    const correction: ClientMessageOf<"correct"> = {
      t: "correct",
      msgId: uuidv7(),
      turnId,
      correctionId: uuidv7(),
      proposalId: task.proposalId,
      field: "target",
    };
    await socket.request(correction);
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
    const correction = typedCorrection(deal.proposalId, "fifty thousand");
    const first = await socket.request(correction);
    const count = socket.events().length;
    const again = await socket.request({ ...correction, msgId: uuidv7() });
    expect(again.seq).toBe(first.seq);
    expect(socket.events()).toHaveLength(count);
  });

  it("refuses words it can't read with unreadable, writing nothing, the typed words included", async () => {
    const { socket, deal } = await withProposals();
    const count = socket.events().length;
    const correction = typedCorrection(deal.proposalId, "about what we said last time");
    socket.send(correction);
    expect(await socket.error(correction.msgId)).toMatchObject({
      code: "unreadable",
      retryable: false,
    });
    expect(socket.events()).toHaveLength(count);
    expect(proposalsOf(socket).find((p) => p.proposalId === deal.proposalId)?.status).toBe(
      "proposed",
    );
  });

  it("leaves a superseded proposal refusing reviews and corrections in the object", async () => {
    const { socket, deal } = await withProposals();
    await socket.request(typedCorrection(deal.proposalId, "sixty thousand"));
    const review = reviewMessage(reviewInput(deal.proposalId));
    socket.send(review);
    expect(await socket.error(review.msgId)).toMatchObject({ code: "bad_message" });
    expect(socket.eventsOf("proposal.reviewed")).toHaveLength(0);
    const again = typedCorrection(deal.proposalId, "seventy thousand");
    socket.send(again);
    expect(await socket.error(again.msgId)).toMatchObject({ code: "bad_message" });
  });

  it("refuses a correction with no words, on a turn that ended, or with typed and spoken words both", async () => {
    const { socket, deal } = await withProposals();
    const { typed: _, ...empty } = typedCorrection(deal.proposalId, "x");
    socket.send(empty);
    expect(await socket.error(empty.msgId)).toMatchObject({ code: "bad_message" });
    const ended = typedCorrection(deal.proposalId, "fifty thousand", {
      turnId: scenario("anthropic", "demo-turn-3").turn.turnId,
    });
    socket.send(ended);
    expect(await socket.error(ended.msgId)).toMatchObject({ code: "bad_message" });
    const turnId = uuidv7();
    await socket.request(utteranceMessage(turnId, utteranceOf("Fifty thousand.", 30_000)));
    const both = typedCorrection(deal.proposalId, "fifty thousand", { turnId });
    socket.send(both);
    expect(await socket.error(both.msgId)).toMatchObject({ code: "bad_message" });
  });

  it("takes typed words only on a correction: an utterance can't say it was typed", async () => {
    const { socket } = await withProposals();
    const typed = utteranceMessage(uuidv7(), {
      ...utteranceOf("fifty thousand", 30_000),
      input: "typed",
    } as never);
    socket.send(typed);
    expect(await socket.error(typed.msgId)).toMatchObject({ code: "bad_message" });
    expect(
      socket.eventsOf("utterance.final").every((event) => event.payload.input === "speech"),
    ).toBe(true);
  });

  it("takes a typed correction after the end, before the seal, though speech is over", async () => {
    const { socket, deal } = await withProposals();
    await socket.request(endMessage());
    const speech = utteranceMessage(uuidv7(), utteranceOf("One more thing."));
    socket.send(speech);
    expect(await socket.error(speech.msgId)).toMatchObject({ code: "already_ended" });
    await socket.request(typedCorrection(deal.proposalId, "forty five thousand"));
    expect(socket.eventsOf("proposal.created").at(-1)?.payload).toMatchObject({
      supersedes: deal.proposalId,
      fields: { amount: { value: 45_000 } },
    });
  });
});

describe("the correction limits (a security review's)", () => {
  it("refuses typed words past the capture limit and its grace", async () => {
    const { socket, deal, stub } = await withProposals();
    const started = Number((await meta(stub)).capture_started_ms);
    await freezeClock(stub, started + SESSION_LIMITS.captureMs + TYPED_CORRECTION_GRACE_MS - 1);
    await socket.request(typedCorrection(deal.proposalId, "fifty thousand"));
    await freezeClock(stub, started + SESSION_LIMITS.captureMs + TYPED_CORRECTION_GRACE_MS);
    const late = typedCorrection(
      socket.eventsOf("proposal.created").at(-1)?.payload.proposalId as string,
      "sixty thousand",
    );
    socket.send(late);
    expect(await socket.error(late.msgId)).toMatchObject({
      code: "duration_limit",
      retryable: false,
    });
  });

  it("refuses typed characters past the session's budget, and a resend the same", async () => {
    const { socket, deal, stub } = await withProposals();
    await setMeta(stub, { typed_chars: CORRECTION_LIMITS.typedCharsPerSession - 5 });
    const over = typedCorrection(deal.proposalId, "fifty thousand");
    socket.send(over);
    expect(await socket.error(over.msgId)).toMatchObject({ code: "turn_limit", retryable: false });
    socket.send(over);
    await socket.waitForCount(
      (message) => message.t === "error" && message.msgId === over.msgId,
      2,
    );
  });

  it("counts every attempt in the window, read or not, and refuses past the limit", async () => {
    const { socket, deal } = await withProposals();
    for (let n = 0; n < CORRECTION_LIMITS.perWindow; n += 1) {
      const attempt = typedCorrection(deal.proposalId, "whenever suits them");
      socket.send(attempt);
      expect(await socket.error(attempt.msgId)).toMatchObject({ code: "unreadable" });
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const over = typedCorrection(deal.proposalId, "fifty thousand");
    socket.send(over);
    expect(await socket.error(over.msgId)).toMatchObject({ code: "turn_limit" });
  });

  it("refuses corrections past the session's total", async () => {
    const { socket, deal, stub } = await withProposals();
    await withSql(stub, (sql) => {
      for (let n = 0; n < CORRECTION_LIMITS.perSession; n += 1) {
        sql.exec(
          "INSERT INTO writes (id, kind, seq, proposal_id) VALUES (?, 'correction', 0, ?)",
          uuidv7(),
          uuidv7(),
        );
      }
    });
    const over = typedCorrection(deal.proposalId, "fifty thousand");
    socket.send(over);
    expect(await socket.error(over.msgId)).toMatchObject({ code: "turn_limit" });
  });

  it("refuses a sixth correction of one card, with a fixed reason", async () => {
    const { socket, deal } = await withProposals();
    let proposalId = deal.proposalId;
    for (let n = 1; n <= CORRECTION_LIMITS.maxDepth; n += 1) {
      await socket.request(typedCorrection(proposalId, `${n * 10} thousand`));
      proposalId = socket.eventsOf("proposal.created").at(-1)?.payload.proposalId as string;
    }
    const sixth = typedCorrection(proposalId, "ninety thousand");
    socket.send(sixth);
    expect(await socket.error(sixth.msgId)).toMatchObject({ code: "turn_limit" });
  });

  it("doesn't push back the idle end: it counts from the last event before the correction", async () => {
    const { socket, deal, stub } = await withProposals();
    const before = socket.events().at(-1)?.ts as string;
    await socket.request(typedCorrection(deal.proposalId, "fifty thousand"));
    expect(Number((await meta(stub)).idle_anchor_ms)).toBe(Date.parse(before));
    // A spoken word is capture again: the anchor goes, and the idle end counts from it.
    await socket.request(utteranceMessage(uuidv7(), utteranceOf("One more thing.", 40_000)));
    expect((await meta(stub)).idle_anchor_ms).toBeUndefined();
  });
});
