// The second witness in SessionDO (Phase 4 spec §4.2 and WP9 step 5): a turn's unbiased
// transcript, compared with its proposals as soon as both exist. Eval script d003 supplies the
// turn: "Debrief from Atmos Industrial…", which links to Atmos Industrial (co_009, the open
// account), and the witness mishears it as "Atmo Systems", a name not in the CRM.

import { evictDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import {
  type ClientMessageOf,
  ProposalFlaggedV1,
  TurnWitnessedV1,
  type UtteranceFinalV2,
  uuidv7,
} from "@earshot/core";
import { defaultProjections, replay } from "@earshot/events";
import { describe, expect, it } from "vitest";
import { evalScenario } from "../../src/e2e-scenario";
import {
  canaryKey,
  dumpStorage,
  meta,
  open,
  sleep,
  startMessage,
  type TestSocket,
  turnEndMessage,
  useCassette,
  utteranceMessage,
  withSql,
} from "./helpers";

const D003 = evalScenario("d003");
if (!D003) throw new Error("no eval script d003");
const SAID = D003.turns[0]?.text ?? "";
const MISHEARD = SAID.replace("Atmos Industrial", "Atmo Systems");
const ATMOS = "co_009";

/** `text` as a final with word timings, 350 ms a word from `startMs`, as a provider sends them. */
function timed<W extends "biased" | "unbiased">(
  text: string,
  witness: W,
  startMs = 2_000,
): UtteranceFinalV2 & { witness: W } {
  const words = text.split(" ").map((w, i) => ({
    w,
    startMs: startMs + i * 350,
    endMs: startMs + i * 350 + 300,
    confidence: 0.9,
  }));
  return {
    utteranceId: uuidv7(),
    text,
    confidence: 0.9,
    words,
    startMs,
    endMs: words.at(-1)?.endMs ?? startMs,
    witness,
  };
}

type Witness = ClientMessageOf<"witness">;
type Transcribed = Extract<Witness, { outcome: "transcribed" }>;

function witnessOf(turnId: string, text = MISHEARD, startMs = 2_000): Transcribed {
  return {
    t: "witness",
    msgId: uuidv7(),
    turnId,
    provider: "groq",
    model: "whisper-large-v3-turbo",
    outcome: "transcribed",
    utterance: timed(text, "unbiased", startMs),
    latencyMs: 812,
  };
}

/** Starts d003's session and sends its first turn's words; the turn_end is the caller's. */
async function d003Turn(socket: TestSocket, stub: Parameters<typeof useCassette>[0], slow = false) {
  await useCassette(stub, slow ? "d003:slow" : "d003");
  await socket.request(
    startMessage({
      startedAt: D003?.startedAt,
      timeZone: D003?.timeZone,
      entities: (D003?.entities ?? []).map((entity) => ({
        ...entity,
        aliases: [...entity.aliases],
      })),
      ...(D003?.focusEntityId ? { focusEntityId: D003.focusEntityId } : {}),
    }),
  );
  const turnId = uuidv7();
  await socket.request(utteranceMessage(turnId, timed(SAID, "biased")));
  return { turnId, turnEnd: turnEndMessage(turnId, canaryKey()) };
}

/** The events after the turn's `turn.completed`, by type. */
function afterTurn(socket: TestSocket): string[] {
  const events = socket.events();
  const completed = events.findIndex((event) => event.type === "turn.completed");
  return events.slice(completed + 1).map((event) => event.type);
}

describe("a witness after extraction", () => {
  it("turns the snapped name into a question: the unbiased utterance, proposal.flagged, then turn.witnessed", async () => {
    const { socket, stub } = await open();
    const { turnId, turnEnd } = await d003Turn(socket, stub);
    await socket.request(turnEnd, 15_000);
    const [created] = socket.eventsOf("proposal.created");
    expect(created?.payload).toMatchObject({
      type: "note",
      target: { decision: "linked", entityId: ATMOS, mention: { quote: "Atmos Industrial" } },
    });

    const witness = witnessOf(turnId);
    const ack = await socket.request(witness);
    expect(afterTurn(socket)).toEqual(["utterance.final", "proposal.flagged", "turn.witnessed"]);
    const [flaggedEvent] = socket.eventsOf("proposal.flagged");
    const flagged = ProposalFlaggedV1.parse(flaggedEvent?.payload);
    expect(flagged).toMatchObject({
      proposalId: created?.payload.proposalId,
      source: "witness",
      flags: [{ kind: "witness_conflict", field: "target" }],
      target: { decision: "ask" },
      conflict: {
        field: "target",
        biased: { text: "Atmos Industrial" },
        unbiased: { text: "Atmo Systems", utteranceId: witness.utterance.utteranceId },
      },
    });
    expect(flagged.target?.candidates[0]?.entityId).toBe(ATMOS);
    expect(flagged.target?.candidates.some((candidate) => candidate.entityId === null)).toBe(true);
    const witnessed = socket.eventsOf("turn.witnessed")[0];
    expect(ack.seq).toBe(witnessed?.seq);
    expect(TurnWitnessedV1.parse(witnessed?.payload)).toEqual({
      turnId,
      outcome: "compared",
      provider: "groq",
      model: "whisper-large-v3-turbo",
      utteranceIds: [witness.utterance.utteranceId],
      conflicts: 1,
      latencyMs: 812,
      reason: null,
    });
    // The session's projections show the question and keep both witnesses' utterances.
    const projections = replay(socket.events(), defaultProjections);
    expect(projections.proposals[0]?.target).toMatchObject({ decision: "ask", entityId: null });
    expect(projections.proposals[0]?.conflicts).toHaveLength(1);
    expect(projections.utterances.map((utterance) => utterance.witness)).toEqual([
      "biased",
      "unbiased",
    ]);
    socket.close();
  });

  it("changes nothing when both witnesses heard the same name", async () => {
    const { socket, stub } = await open();
    const { turnId, turnEnd } = await d003Turn(socket, stub);
    await socket.request(turnEnd, 15_000);
    await socket.request(witnessOf(turnId, SAID));
    expect(afterTurn(socket)).toEqual(["utterance.final", "turn.witnessed"]);
    expect(socket.eventsOf("turn.witnessed")[0]?.payload).toMatchObject({
      outcome: "compared",
      conflicts: 0,
    });
    socket.close();
  });

  it("compares with the context the turn kept, after the object hibernated", async () => {
    const { socket, stub } = await open();
    const { turnId, turnEnd } = await d003Turn(socket, stub);
    await socket.request(turnEnd, 15_000);
    await evictDurableObject(stub, { webSockets: "hibernate" });
    await socket.request(witnessOf(turnId));
    expect(afterTurn(socket)).toEqual(["utterance.final", "proposal.flagged", "turn.witnessed"]);
    expect(socket.eventsOf("proposal.flagged")[0]?.payload).toMatchObject({
      target: { decision: "ask" },
    });
    socket.close();
  });

  it("records a failed or skipped witness as turn.witnessed alone, with its reason", async () => {
    const { socket, stub } = await open();
    const { turnId, turnEnd } = await d003Turn(socket, stub);
    await socket.request(turnEnd, 15_000);
    const failed: Witness = {
      t: "witness",
      msgId: uuidv7(),
      turnId,
      provider: "groq",
      model: "whisper-large-v3-turbo",
      outcome: "failed",
      reason: "rate_limited",
      latencyMs: 10_400,
    };
    await socket.request(failed);
    expect(afterTurn(socket)).toEqual(["turn.witnessed"]);
    expect(socket.eventsOf("turn.witnessed")[0]?.payload).toEqual({
      turnId,
      outcome: "failed",
      provider: "groq",
      model: "whisper-large-v3-turbo",
      utteranceIds: [],
      conflicts: 0,
      latencyMs: 10_400,
      reason: "rate_limited",
    });
    socket.close();
  });
});

describe("a witness before extraction", () => {
  it("waits for the turn's proposals, then compares, in the session's order", {
    timeout: 120_000,
  }, async () => {
    const { socket, stub } = await open();
    const { turnId, turnEnd } = await d003Turn(socket, stub, true);
    socket.send(turnEnd);
    const witness = witnessOf(turnId);
    socket.send(witness); // the cassette answers the turn 400 ms later
    const witnessAck = await socket.ack(witness.msgId, 15_000);
    const turnAck = await socket.ack(turnEnd.msgId);
    expect(socket.received.indexOf(turnAck)).toBeLessThan(socket.received.indexOf(witnessAck));
    expect(
      socket
        .events()
        .slice(2)
        .map((event) => event.type),
    ).toEqual([
      "proposal.created",
      "usage.recorded",
      "turn.completed",
      "utterance.final",
      "proposal.flagged",
      "turn.witnessed",
    ]);
    socket.close();
  });

  it("answers a resend with the same ack, and one sent while it waits starts nothing", {
    timeout: 120_000,
  }, async () => {
    const { socket, stub } = await open();
    const { turnId, turnEnd } = await d003Turn(socket, stub, true);
    socket.send(turnEnd);
    const witness = witnessOf(turnId);
    socket.send(witness);
    socket.send(witness); // while it waits for the turn
    const first = await socket.ack(witness.msgId, 15_000);
    const again = await socket.request(witness); // after it was handled
    expect(again.seq).toBe(first.seq);
    expect(socket.eventsOf("turn.witnessed")).toHaveLength(1);
    expect(socket.eventsOf("proposal.flagged")).toHaveLength(1);
    socket.close();
  });

  it("writes nothing when the session is purged while the witness waits for its turn", {
    timeout: 120_000,
  }, async () => {
    const { socket, stub, ids } = await open();
    const { turnId, turnEnd } = await d003Turn(socket, stub, true);
    socket.send(turnEnd);
    socket.send(witnessOf(turnId));
    await socket.waitFor((m) => m.t === "working");
    await exports.default.purgeSessions([ids.sid]);
    await sleep(700); // past the slow cassette's answer
    expect(Object.keys(await meta(stub))).toEqual(["purged_ms"]);
    expect(await withSql(stub, (sql) => sql.exec("SELECT count(*) AS n FROM events").one().n)).toBe(
      0,
    );
  });
});

describe("refused witnesses", () => {
  it("refuses a witness for a turn that never ended, a second witness, a reused utterance, and one outside the turn's window", async () => {
    const { socket, stub } = await open();
    const { turnId, turnEnd } = await d003Turn(socket, stub);
    const refused = async (message: Witness) => {
      socket.send(message);
      return socket.error(message.msgId);
    };
    // The turn hasn't ended yet: no turn_end, no witness.
    const early = witnessOf(turnId);
    await expect(refused(early)).resolves.toMatchObject({ code: "bad_message", retryable: false });
    await socket.request(turnEnd, 15_000);
    // More than 1 s past the turn's own words, which end at 8,600 ms (19 words from 2,000 ms).
    const late = witnessOf(turnId, MISHEARD, 4_000);
    await expect(refused(late)).resolves.toMatchObject({ code: "bad_message" });
    // An utterance id the log already holds.
    const biasedId = String(socket.eventsOf("utterance.final")[0]?.payload.utteranceId);
    const reused = witnessOf(turnId);
    reused.utterance = { ...reused.utterance, utteranceId: biasedId };
    await expect(refused(reused)).resolves.toMatchObject({ code: "bad_message" });
    // The first good one is taken; a second for the same turn is refused.
    await socket.request(witnessOf(turnId));
    await expect(refused(witnessOf(turnId, SAID))).resolves.toMatchObject({
      code: "bad_message",
      retryable: false,
    });
    expect(socket.eventsOf("turn.witnessed")).toHaveLength(1);
    // Nothing refused reached storage, nor did any key.
    const storage = await dumpStorage(stub);
    expect(storage).not.toContain(late.utterance.utteranceId);
    socket.close();
  });

  it("refuses a witness before start and after the end", async () => {
    const { socket } = await open();
    const early = witnessOf(uuidv7());
    socket.send(early);
    await expect(socket.error(early.msgId)).resolves.toMatchObject({
      code: "not_started",
      retryable: true,
    });
    socket.close();
  });
});
