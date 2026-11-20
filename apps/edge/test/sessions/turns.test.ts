// The turn flow (spec WP6 steps 4–5): extraction through `@earshot/agent`'s runTurn, answered from
// its cassettes, one turn at a time, with the per-turn key used once and stored nowhere.

import { evictDurableObject } from "cloudflare:test";
import {
  DEMO_COMPANY_ID,
  DEMO_DEAL_ID,
  DEMO_UTTERANCES,
  demoTurnId,
  scenario,
} from "@earshot/agent/testing";
import {
  ProposalCreatedV2,
  type ServerMessage,
  TurnCompletedV1,
  UsageRecordedV1,
  type UtteranceFinalV2,
  uuidv7,
} from "@earshot/core";
import { findSecretFragment } from "@earshot/keys/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC,
  canaryKey,
  dumpStorage,
  endMessage,
  flushes,
  GROQ,
  meta,
  open,
  setMeta,
  startMessage,
  type TestSocket,
  turnEndMessage,
  useCassette,
  utteranceMessage,
} from "./helpers";

function demoUtterance(index: number): UtteranceFinalV2 {
  const utterance = DEMO_UTTERANCES[index];
  if (!utterance) throw new Error(`no demo utterance ${index}`);
  return utterance;
}

/** Sends a scenario turn's utterances and its turn_end; resolves with the turn_end's ack. */
async function runScenarioTurn(
  socket: TestSocket,
  provider: "anthropic" | "groq",
  name: string,
  key: string,
) {
  const { turn } = scenario(provider, name);
  for (const utterance of turn.utterances) {
    await socket.request(utteranceMessage(turn.turnId, utterance));
  }
  const message = turnEndMessage(turn.turnId, key, provider === "anthropic" ? ANTHROPIC : GROQ);
  const ack = await socket.request(message, 15_000);
  return { message, ack, turnId: turn.turnId };
}

const completedFor = (socket: TestSocket, turnId: string) =>
  socket.eventsOf("turn.completed").filter((event) => event.payload.turnId === turnId);

describe("a turn", () => {
  it("drafts proposals, then usage, then turn.completed, after a working message", async () => {
    const { socket } = await open();
    await socket.request(startMessage());
    const { ack, turnId } = await runScenarioTurn(socket, "anthropic", "demo-turn-4", canaryKey());

    const working = socket.received.filter((m) => m.t === "working");
    expect(working).toEqual([{ t: "working", turnId, state: "thinking" }]);
    const events = socket.events().slice(2); // after session.started and the utterance
    expect(events.map((event) => event.type)).toEqual([
      "proposal.created",
      "usage.recorded",
      "turn.completed",
    ]);
    const [proposal, usage, completed] = events.map((event) => event.payload);
    // proposal.created v2: "Dana" sounds like two contacts, so the linker asks.
    expect(events[0]?.schemaVersion).toBe(2);
    expect(ProposalCreatedV2.parse(proposal)).toMatchObject({
      type: "task",
      target: { decision: "ask", entityId: null, kind: "contact", mention: { quote: "Dana" } },
      fields: { title: { value: "Send Dana the pricing breakdown" } },
      linker: "linker.v1",
    });
    expect(UsageRecordedV1.parse(usage)).toMatchObject({
      kind: "llm",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      priceTable: "2026-11-15",
    });
    expect(TurnCompletedV1.parse(completed)).toMatchObject({
      turnId,
      outcome: "proposals",
      utteranceIds: [demoUtterance(3).utteranceId],
      proposalIds: [(proposal as { proposalId: string }).proposalId],
      attempts: 1,
    });
    // The ack names the turn's last event, turn.completed.
    expect(ack.seq).toBe(events.at(-1)?.seq);
    socket.close();
  });

  it("runs on Groq too, and records nothing_to_propose when the turn has nothing", async () => {
    const { socket } = await open();
    await socket.request(startMessage({ providers: { llm: { ...GROQ } } }));
    const nothing = await runScenarioTurn(socket, "groq", "demo-turn-2", canaryKey("plain"));
    expect(completedFor(socket, nothing.turnId)[0]?.payload).toMatchObject({
      outcome: "nothing_to_propose",
      proposalIds: [],
    });
    const deal = await runScenarioTurn(socket, "groq", "demo-turn-3", canaryKey("plain"));
    expect(completedFor(socket, deal.turnId)[0]?.payload).toMatchObject({ outcome: "proposals" });
    expect(socket.eventsOf("proposal.created")).toHaveLength(1);
    socket.close();
  });

  it("records a turn with no speech as nothing_to_propose, without a call", async () => {
    const { socket } = await open();
    await socket.request(startMessage());
    const turnId = uuidv7();
    await socket.request(turnEndMessage(turnId, canaryKey()));
    expect(completedFor(socket, turnId)[0]?.payload).toEqual({
      turnId,
      utteranceIds: [],
      outcome: "nothing_to_propose",
      proposalIds: [],
      attempts: 0,
      llmMs: 0,
    });
    expect(socket.eventsOf("usage.recorded")).toEqual([]);
    socket.close();
  });

  it("waits out a 429's Retry-After, telling the client it's retrying", async () => {
    const { socket, stub } = await open();
    await useCassette(stub, "rate-limited-then-ok");
    await socket.request(startMessage());
    const { turnId } = await runScenarioTurn(
      socket,
      "anthropic",
      "rate-limited-then-ok",
      canaryKey(),
    );
    const working = socket.received.filter((m) => m.t === "working");
    expect(working).toEqual([
      { t: "working", turnId, state: "thinking" },
      { t: "working", turnId, state: "retrying", retryInMs: 1_000 },
    ]);
    expect(completedFor(socket, turnId)[0]?.payload).toMatchObject({
      outcome: "proposals",
      attempts: 2,
    });
    socket.close();
  });

  it("answers a rejected key with llm_key_rejected, and repeats that answer to a resend", async () => {
    const { socket, stub } = await open();
    await useCassette(stub, "key-rejected");
    await socket.request(startMessage({ providers: { llm: { ...GROQ } } }));
    const { message, ack, turnId } = await runScenarioTurn(
      socket,
      "groq",
      "key-rejected",
      canaryKey("plain"),
    );
    expect(await socket.error(message.msgId)).toEqual({
      t: "error",
      code: "llm_key_rejected",
      retryable: false,
      msgId: message.msgId,
    });
    expect(completedFor(socket, turnId)[0]?.payload).toMatchObject({
      outcome: "provider_error",
      attempts: 1,
    });
    const errorsBefore = socket.received.filter((m) => m.t === "error").length;
    socket.send(message);
    await socket.waitFor(
      () => socket.received.filter((m) => m.t === "error").length > errorsBefore,
    );
    expect(socket.received.filter((m) => m.t === "ack" && m.msgId === message.msgId)).toEqual([
      ack,
      ack,
    ]);
    expect(completedFor(socket, turnId)).toHaveLength(1);
    socket.close();
  });

  it("records invalid output twice as invalid_output, billing both calls, with no error message", async () => {
    const { socket, stub } = await open();
    await useCassette(stub, "invalid-twice");
    await socket.request(startMessage({ providers: { llm: { ...GROQ } } }));
    const { message, turnId } = await runScenarioTurn(
      socket,
      "groq",
      "invalid-twice",
      canaryKey("plain"),
    );
    expect(completedFor(socket, turnId)[0]?.payload).toMatchObject({
      outcome: "invalid_output",
      attempts: 2,
    });
    expect(socket.eventsOf("usage.recorded")).toHaveLength(1);
    expect(socket.received.filter((m) => m.t === "error" && m.msgId === message.msgId)).toEqual([]);
    socket.close();
  });

  it("refuses a model the agent has no adapter for, without a call or an event", async () => {
    const { socket } = await open();
    await socket.request(startMessage());
    const turnId = demoTurnId(1);
    await socket.request(utteranceMessage(turnId, demoUtterance(0)));
    const message = turnEndMessage(turnId, canaryKey(), {
      provider: "anthropic",
      model: "claude-opus-9",
    });
    socket.send(message);
    expect(await socket.error(message.msgId)).toMatchObject({
      code: "bad_message",
      retryable: false,
    });
    expect(socket.eventsOf("turn.completed")).toEqual([]);
    socket.close();
  });
});

describe("the understanding step in SessionDO (Phase 4 WP8)", () => {
  const proposalOf = (socket: TestSocket, turnId: string) => {
    const completed = completedFor(socket, turnId)[0]?.payload as
      | { proposalIds: string[] }
      | undefined;
    const id = completed?.proposalIds[0];
    return socket
      .eventsOf("proposal.created")
      .find((event) => (event.payload as { proposalId: string }).proposalId === id)?.payload;
  };

  it("keeps the open account and the turn's links in meta", async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    expect((await meta(stub)).focus_entity_id).toBe(DEMO_COMPANY_ID);
    // Turn 1: "Dana Lee" asks, and "Acme Corp", the company said beside her, links.
    const { turnId } = await runScenarioTurn(socket, "anthropic", "demo-turn-1", canaryKey());
    expect(proposalOf(socket, turnId)).toMatchObject({
      type: "contact",
      target: { decision: "ask", company: { quote: "Acme Corp", entityId: DEMO_COMPANY_ID } },
    });
    expect(JSON.parse((await meta(stub)).link_recent ?? "null")).toEqual([DEMO_COMPANY_ID]);
    socket.close();
  });

  it("starts with no open account when start names none, and implies nothing", async () => {
    const { socket, stub } = await open();
    await useCassette(stub, "demo-turn-5");
    const { focusEntityId: _focus, ...start } = startMessage();
    await socket.request(start);
    expect((await meta(stub)).focus_entity_id).toBeUndefined();
    // The recorded request named Acme Corp as open: without it, the request isn't the recorded
    // one, so the cassette refuses and the turn fails. That's the prompt carrying the account.
    const { turnId } = await runScenarioTurn(socket, "anthropic", "demo-turn-5", canaryKey());
    expect(completedFor(socket, turnId)[0]?.payload).toMatchObject({ proposalIds: [] });
    expect(socket.eventsOf("proposal.created")).toEqual([]);
    socket.close();
  });

  it("builds the link index again after the object wakes, and reads the stored links", async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    // An earlier link to Dana Li, as a woken object would find it in meta.
    await setMeta(stub, { link_recent: JSON.stringify(["ct_145"]) });
    const { turnId } = await runScenarioTurn(socket, "anthropic", "demo-turn-1", canaryKey());
    expect(proposalOf(socket, turnId)).toMatchObject({
      target: { decision: "linked", entityId: "ct_145", basis: "context" },
    });
    expect(JSON.parse((await meta(stub)).link_recent ?? "null")).toEqual([
      "ct_145",
      DEMO_COMPANY_ID,
    ]);
    // Evicted again: the open account's only deal still comes from a rebuilt index.
    await evictDurableObject(stub, { webSockets: "hibernate" });
    const deal = await runScenarioTurn(socket, "anthropic", "demo-turn-3", canaryKey());
    expect(proposalOf(socket, deal.turnId)).toMatchObject({
      type: "deal_update",
      target: { decision: "linked", entityId: DEMO_DEAL_ID, basis: "focus" },
      riskFlags: [{ kind: "implied_target", field: "target" }],
    });
    socket.close();
  });

  it("leaves the second witness's utterances out of extraction", async () => {
    const { socket } = await open();
    await socket.request(startMessage());
    const { turn } = scenario("anthropic", "demo-turn-4");
    const unbiased: UtteranceFinalV2 = {
      ...demoUtterance(3),
      utteranceId: uuidv7(),
      text: "I need to send Donna the pricing breakdown by Thursday.",
      witness: "unbiased",
    };
    await socket.request(utteranceMessage(turn.turnId, unbiased));
    // The biased utterance alone makes the recorded request, so the cassette answers.
    const { turnId } = await runScenarioTurn(socket, "anthropic", "demo-turn-4", canaryKey());
    expect(completedFor(socket, turnId)[0]?.payload).toMatchObject({
      outcome: "proposals",
      utteranceIds: [demoUtterance(3).utteranceId],
    });
    socket.close();
  });
});

describe("turns in flight", () => {
  it("run one at a time, in order", async () => {
    const { socket, stub } = await open();
    await useCassette(stub, "demo-turn-4:slow");
    await socket.request(startMessage());
    const firstTurn = demoTurnId(4);
    const secondTurn = uuidv7();
    await socket.request(utteranceMessage(firstTurn, demoUtterance(3)));
    const first = turnEndMessage(firstTurn, canaryKey());
    const second = turnEndMessage(secondTurn, canaryKey()); // no speech: no call
    socket.send(first);
    socket.send(second);
    await socket.ack(second.msgId, 10_000);
    const order = socket.received
      .filter((m): m is Extract<ServerMessage, { t: "event" }> => m.t === "event")
      .filter((m) => m.event.type === "turn.completed")
      .map((m) => m.event.payload.turnId);
    expect(order).toEqual([firstTurn, secondTurn]);
    socket.close();
  });

  it("starts nothing for a turn_end resent while its call is still running", async () => {
    const { socket, stub } = await open();
    await useCassette(stub, "demo-turn-4:slow");
    await socket.request(startMessage());
    const turnId = demoTurnId(4);
    await socket.request(utteranceMessage(turnId, demoUtterance(3)));
    const message = turnEndMessage(turnId, canaryKey());
    socket.send(message);
    await socket.waitFor((m) => m.t === "working");
    socket.send(message);
    socket.send(message);
    await socket.ack(message.msgId, 10_000);
    expect(completedFor(socket, turnId)).toHaveLength(1);
    expect(socket.eventsOf("proposal.created")).toHaveLength(1);
    expect(socket.received.filter((m) => m.t === "working")).toHaveLength(1);
    socket.close();
  });
});

describe("the turn's key", () => {
  let logged: string[] = [];
  beforeEach(() => {
    logged = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never reaches SQLite, a flush message, a server message, or a log", async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    const keys = [canaryKey("anthropic"), canaryKey("plain"), canaryKey("anthropic")];
    await runScenarioTurn(socket, "anthropic", "demo-turn-4", keys[0] as string);
    await runScenarioTurn(socket, "anthropic", "demo-turn-1", keys[1] as string);
    await runScenarioTurn(socket, "anthropic", "demo-turn-5", keys[2] as string);
    await socket.request(endMessage());

    const storage = await dumpStorage(stub);
    const queue = JSON.stringify(await flushes(stub));
    const frames = socket.frames.join("\n");
    expect((await flushes(stub)).length).toBeGreaterThan(0);
    expect(storage).toContain("Send Dana the pricing breakdown"); // the scan reads real content
    for (const key of keys) {
      expect(findSecretFragment(storage, key)).toBeUndefined();
      expect(findSecretFragment(queue, key)).toBeUndefined();
      expect(findSecretFragment(frames, key)).toBeUndefined();
      expect(findSecretFragment(logged.join("\n"), key)).toBeUndefined();
    }
    expect(socket.invalid).toEqual([]);
    socket.close();
  });
});
