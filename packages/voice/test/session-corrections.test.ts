// Corrections and follow-up skips from SessionClient (Phase 5 WP13): a typed correction's words ride
// on `correct` itself, the superseding proposal arrives as an event, unreadable words are reported,
// and once SessionDO seals the session a typed correction or a skip goes to the correction route
// with the same id; a spoken one can't, since its words are in the session's turn. Against the
// in-memory SessionDO, on a manual clock.
import { describe, expect, it, vi } from "vitest";
import { type CorrectionRoute, createSessionClient } from "../src/session/client";
import { FakePageLifecycle } from "../src/testing/fake-page";
import { FakeSessionServer } from "../src/testing/fake-session-server";
import { settle } from "../src/testing/fake-socket";
import { counterIds } from "./support/ids";
import { ManualClock } from "./support/manual-clock";

const SESSION = "0000000a-0000-7000-8000-00000000c0de";
const ENTITY = "01a0f831-ac00-75a0-a2b2-cb79eb1835bf";
const PROPOSAL = "0000000e-0000-7000-8000-000000000001";
const QUESTION = "0000000b-0000-7000-8000-000000000001";
const UTTERANCE = "0000000d-0000-7000-8000-000000000001";

/** A task linked to one record, with no due date, and the question that asks for one. */
function seed(server: FakeSessionServer): void {
  const evidence = { utteranceId: UTTERANCE, span: [0, 4], audioMs: [0, 300], confidence: 0.9 };
  server.append("utterance.final", {
    utteranceId: UTTERANCE,
    text: "Acme wants the deck.",
    confidence: 0.9,
    startMs: 0,
    endMs: 1_800,
    witness: "biased",
    input: "speech",
  });
  server.append("proposal.created", {
    proposalId: PROPOSAL,
    type: "task",
    target: {
      decision: "linked",
      entityId: ENTITY,
      kind: "company",
      basis: "exact",
      p: 0.98,
      mention: { quote: "Acme", evidence },
      company: null,
      candidates: [{ entityId: ENTITY, p: 0.98 }],
    },
    fields: { title: { value: "Send the deck", evidence: { ...evidence, span: [5, 18] } } },
    riskFlags: [],
    supersedes: null,
    linker: "linker.v1",
  });
  server.append("followup.asked", {
    questionId: QUESTION,
    turnId: "0000000c-0000-7000-8000-000000000001",
    proposalId: PROPOSAL,
    field: "dueDate",
    rule: "due_date",
    text: "When is it due?",
  });
}

async function harness(
  options: { route?: CorrectionRoute; correct?: FakeSessionServer["constructor"] } = {},
  correct?: ConstructorParameters<typeof FakeSessionServer>[0]["correct"],
) {
  const clock = new ManualClock();
  const server = new FakeSessionServer({ sessionId: SESSION, ...(correct ? { correct } : {}) });
  const client = createSessionClient({
    sessionId: SESSION,
    url: server.edgeUrl,
    socket: server.factory,
    clock,
    random: () => 0.5,
    createId: counterIds(),
    page: new FakePageLifecycle(),
    getTicket: async () => server.issueTicket(),
    ...(options.route ? { correctionRoute: options.route } : {}),
  });
  client.start();
  await settle(400);
  client.sendStart({
    providers: {
      speechToText: { provider: "assemblyai", model: "universal-streaming-english" },
      llm: { provider: "anthropic", model: "claude-haiku-5-5" },
    },
    startedAt: "2026-11-20T12:00:00.000Z",
    entities: [],
  });
  await settle(400);
  seed(server);
  await settle(400);
  return { server, client };
}

const correction = {
  turnId: "0000000c-0000-7000-8000-0000000000aa",
  correctionId: "0000000f-0000-7000-8000-0000000000aa",
  proposalId: PROPOSAL,
  field: "dueDate",
  questionId: QUESTION,
  typed: { utteranceId: "0000000d-0000-7000-8000-0000000000aa", text: "Friday" },
};

describe("SessionClient.sendCorrection", () => {
  it("carries the typed words on correct, and folds the superseding proposal that comes back", async () => {
    const { server, client } = await harness();
    await expect(client.sendCorrection(correction)).resolves.toEqual({ ok: true, via: "socket" });
    const sent = server.received.find((message) => message.t === "correct");
    expect(sent).toMatchObject({ ...correction, t: "correct" });
    // No utterance message carried the typed words: they rode on the correction.
    expect(server.received.filter((message) => message.t === "utterance")).toEqual([]);
    await settle(400);
    const { proposals } = client.store.getState().projections;
    const replacement = proposals.find((proposal) => proposal.supersedes === PROPOSAL);
    expect(replacement?.followups).toEqual([
      expect.objectContaining({ questionId: QUESTION, status: "answered" }),
    ]);
    expect(proposals.find((proposal) => proposal.proposalId === PROPOSAL)?.status).toBe(
      "superseded",
    );
  });

  it("reports words SessionDO couldn't read, and nothing changes", async () => {
    const { client } = await harness({}, () => "unreadable");
    await expect(client.sendCorrection(correction)).resolves.toEqual({
      ok: false,
      code: "unreadable",
    });
    await settle(400);
    expect(
      client.store.getState().projections.proposals.map((proposal) => proposal.status),
    ).toEqual(["proposed"]);
  });

  it("sends a typed correction to the route once the session is sealed, and a spoken one nowhere", async () => {
    const route = vi.fn<CorrectionRoute>(async () => ({ proposalId: "p2" }));
    const { server, client } = await harness({ route });
    server.seal();
    await settle(400);
    await expect(client.sendCorrection(correction)).resolves.toEqual({ ok: true, via: "route" });
    expect(route).toHaveBeenCalledWith({
      t: "correct",
      correctionId: correction.correctionId,
      proposalId: PROPOSAL,
      field: "dueDate",
      questionId: QUESTION,
      text: "Friday",
    });
    const { typed: _, ...spoken } = correction;
    await expect(
      client.sendCorrection({ ...spoken, correctionId: "0000000f-0000-7000-8000-0000000000ab" }),
    ).resolves.toEqual({
      ok: false,
      code: "sealed",
    });
    expect(route).toHaveBeenCalledTimes(1);
  });

  it("passes the route's refusal on as its code", async () => {
    const route: CorrectionRoute = async () => {
      throw Object.assign(new Error("refused"), { code: "unreadable" });
    };
    const { server, client } = await harness({ route });
    server.seal();
    await settle(400);
    await expect(client.sendCorrection(correction)).resolves.toEqual({
      ok: false,
      code: "unreadable",
    });
  });
});

describe("SessionClient.sendFollowupSkip", () => {
  it("skips a question over the socket, and through the route after the seal", async () => {
    const route = vi.fn<CorrectionRoute>(async () => ({ proposalId: null }));
    const { server, client } = await harness({ route });
    await expect(client.sendFollowupSkip(QUESTION)).resolves.toEqual({ ok: true, via: "socket" });
    await settle(400);
    expect(client.store.getState().projections.proposals[0]?.followups[0]?.status).toBe("skipped");
    server.seal();
    await settle(400);
    await expect(client.sendFollowupSkip("0000000b-0000-7000-8000-000000000002")).resolves.toEqual({
      ok: true,
      via: "route",
    });
    expect(route).toHaveBeenCalledWith({
      t: "skip",
      questionId: "0000000b-0000-7000-8000-000000000002",
    });
  });
});
