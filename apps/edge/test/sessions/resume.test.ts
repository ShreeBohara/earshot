// Resume after a drop (spec §6 gate G2c, the workerd half): a plain close, hibernation, and an
// eviction that closes sockets, as a deploy does. Nothing may be lost or duplicated.

import { evictDurableObject } from "cloudflare:test";
import { DEMO_UTTERANCES, demoTurnId } from "@earshot/agent/testing";
import { type EventEnvelope, uuidv7 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  canaryKey,
  endMessage,
  meta,
  newSession,
  open,
  startMessage,
  type TestSocket,
  turnEndMessage,
  useCassette,
  utteranceMessage,
  utteranceOf,
} from "./helpers";

/** Merges what two sockets received, as a client folding by seq would, keeping duplicates. */
function folded(...sockets: TestSocket[]): EventEnvelope[] {
  return sockets.flatMap((socket) => socket.events());
}

function expectCompleteLog(events: EventEnvelope[], lastSeq: number) {
  const bySeq = new Map<number, EventEnvelope>();
  for (const event of events) {
    const seen = bySeq.get(event.seq);
    // A replayed event must be the same event, not a new one under the same seq.
    if (seen) expect(seen).toEqual(event);
    bySeq.set(event.seq, event);
  }
  expect([...bySeq.keys()].sort((a, b) => a - b)).toEqual(
    Array.from({ length: lastSeq + 1 }, (_, seq) => seq),
  );
  const ids = [...bySeq.values()].map((event) => event.id);
  expect(new Set(ids).size).toBe(ids.length);
}

describe("resume", () => {
  it("replays exactly what the client missed after a plain close, and resends are harmless", async () => {
    const ids = newSession();
    const first = await open(ids);
    await first.socket.request(startMessage());
    const turnId = uuidv7();
    const utterances = [1, 2, 3, 4].map((n) =>
      utteranceMessage(turnId, utteranceOf(`Point ${n}.`)),
    );
    // Two are acked; the next two are sent as the socket drops, so their acks are lost.
    await first.socket.request(utterances[0] as (typeof utterances)[0]);
    await first.socket.request(utterances[1] as (typeof utterances)[0]);
    const lastSeen = first.socket.events().at(-1)?.seq ?? -1;
    first.socket.send(utterances[2] as object);
    first.socket.close();
    await first.socket.closed;

    const second = await open(ids, lastSeen);
    // The client's outbox resends everything unacknowledged, in order.
    for (const message of utterances.slice(2)) await second.socket.request(message);
    const end = endMessage();
    await second.socket.request(end);

    const lastSeq = Number((await meta(second.stub)).ended_seq);
    expect(second.welcome.lastSeq).toBeGreaterThanOrEqual(lastSeen);
    expectCompleteLog(folded(first.socket, second.socket), lastSeq);
    // Every scripted utterance appears exactly once in the log.
    const texts = folded(first.socket, second.socket)
      .filter((event) => event.type === "utterance.final")
      .map((event) => event.payload.text);
    expect([...new Set(texts)].sort()).toEqual(["Point 1.", "Point 2.", "Point 3.", "Point 4."]);
    expect(second.socket.events().filter((event) => event.seq <= lastSeen)).toEqual([]);
    second.socket.close();
  });

  it("keeps the session across hibernation: same socket, state rehydrated from SQLite", async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    await socket.request(utteranceMessage(uuidv7(), utteranceOf("Before the nap.")));
    await evictDurableObject(stub, { webSockets: "hibernate" });

    // The constructor ran again; the socket and its attachment survived.
    const after = utteranceMessage(uuidv7(), utteranceOf("After the nap."));
    expect((await socket.request(after)).seq).toBe(2);
    expect(socket.eventsOf("utterance.final").map((event) => event.seq)).toEqual([1, 2]);
    // A resend from before the nap is still recognized.
    const resend = await socket.request(after);
    expect(resend.seq).toBe(2);
    expect(socket.events()).toHaveLength(3);
    socket.close();
  });

  it("resumes after an eviction that closes sockets, as a deploy does", async () => {
    const ids = newSession();
    const first = await open(ids);
    await first.socket.request(startMessage());
    await first.socket.request(utteranceMessage(uuidv7(), utteranceOf("Mid-deploy.")));
    await evictDurableObject(first.stub, { webSockets: "close" });
    const closed = await first.socket.closed;
    expect(closed.code).not.toBe(1000);

    const lastSeen = first.socket.events().at(-1)?.seq ?? -1;
    const second = await open(ids, lastSeen);
    const next = utteranceMessage(uuidv7(), utteranceOf("After the deploy."));
    expect((await second.socket.request(next)).seq).toBe(lastSeen + 1);
    expectCompleteLog(folded(first.socket, second.socket), lastSeen + 1);
    second.socket.close();
  });

  it("runs a turn exactly once when its turn_end is resent across a drop", async () => {
    const ids = newSession();
    const first = await open(ids);
    await useCassette(first.stub, "demo-turn-4:slow");
    await first.socket.request(startMessage());
    const turnId = demoTurnId(4);
    const taskUtterance = DEMO_UTTERANCES[3];
    if (!taskUtterance) throw new Error("no demo utterance 4");
    await first.socket.request(utteranceMessage(turnId, taskUtterance));
    const turnEnd = turnEndMessage(turnId, canaryKey());
    first.socket.send(turnEnd);
    await first.socket.waitFor((m) => m.t === "working");
    first.socket.close(); // the call is still running

    const second = await open(ids, first.socket.events().at(-1)?.seq ?? -1);
    const ack = await second.socket.request(turnEnd, 10_000);
    expect(ack.seq).toBeDefined();
    const completed = folded(first.socket, second.socket).filter(
      (event) => event.type === "turn.completed",
    );
    expect(new Set(completed.map((event) => event.id)).size).toBe(1);
    expect(completed[0]?.payload).toMatchObject({ outcome: "proposals", attempts: 1 });
    second.socket.close();
  });
});
