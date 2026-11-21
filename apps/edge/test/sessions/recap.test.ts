// The recap (Phase 5 spec §4.9, WP10 step 4): after `session.ended`, in the serial queue, with a
// 15 s deadline (target), SessionDO appends `recap.created` and its `usage.recorded`. No key, no
// speech, a failure, or the deadline gives `skipped` or `failed` with its reason, and the seal
// comes after the recap, never before, and never waits on it for long. The recap's key is used for
// its call and nowhere else. The scripted recap model answers (worker.ts); nothing reaches a
// provider.

import { runDurableObjectAlarm } from "cloudflare:test";
import { DEMO_UTTERANCES, demoTurnId } from "@earshot/agent/testing";
import { RecapCreatedV1, UsageRecordedV1 } from "@earshot/core";
import { defaultProjections, recapProblem, replay } from "@earshot/events";
import { findSecretFragment } from "@earshot/keys/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEAL_TIMING } from "../../src/session/limits";
import {
  armAlarm,
  canaryKey,
  dumpStorage,
  endMessage,
  failSink,
  flushes,
  freezeClock,
  GROQ,
  meta,
  open,
  recapRequest,
  scriptRecap,
  setMeta,
  snoozeMessage,
  startMessage,
  type TestSocket,
  turnEndMessage,
  utteranceMessage,
  withSql,
} from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

type Stub = Awaited<ReturnType<typeof open>>["stub"];

/** Says demo turns `numbers` (1-based), each answered by the demo cassette. */
async function say(socket: TestSocket, numbers: readonly number[], key: string): Promise<void> {
  for (const n of numbers) {
    const utterance = DEMO_UTTERANCES[n - 1];
    if (!utterance) throw new Error(`no demo turn ${n}`);
    await socket.request(utteranceMessage(demoTurnId(n), utterance));
    await socket.request(turnEndMessage(demoTurnId(n), key), 10_000);
  }
}

/** Waits for the session's recap. */
async function recapOf(socket: TestSocket, timeoutMs = 5_000): Promise<void> {
  await socket.waitFor((m) => m.t === "event" && m.event.type === "recap.created", timeoutMs);
}

const fourth = DEMO_UTTERANCES[3];
if (!fourth) throw new Error("no demo turn 4");

function recapPayload(socket: TestSocket): RecapCreatedV1 {
  const [event] = socket.eventsOf("recap.created");
  if (!event) throw new Error("no recap yet");
  return RecapCreatedV1.parse(event.payload);
}

const types = (socket: TestSocket) => socket.events().map((event) => event.type);

/** Runs the alarm with the clock past the seal's grace. */
async function sealByAlarm(stub: Stub): Promise<void> {
  const ended = Number((await meta(stub)).ended_ms);
  await freezeClock(stub, ended + SEAL_TIMING.graceMs + 1);
  await armAlarm(stub);
  await runDurableObjectAlarm(stub);
}

describe("the recap at the end of a session", () => {
  it("is written after session.ended and before the seal, quoting the session, with its usage", async () => {
    const { socket, stub } = await open();
    const key = canaryKey();
    await socket.request(startMessage());
    await say(socket, [1, 4], key);
    const end = endMessage(recapRequest(key, { lens: "meddic" }));
    const endAck = await socket.request(end);
    await socket.waitFor((m) => m.t === "event" && m.event.type === "recap.created");

    // The ack comes with session.ended; the recap follows it.
    const ended = socket.eventsOf("session.ended")[0];
    expect(endAck.seq).toBe(ended?.seq);
    const recapEvent = socket.eventsOf("recap.created")[0];
    expect(recapEvent?.seq).toBe((ended?.seq ?? 0) + 1);
    const recap = recapPayload(socket);
    expect(recapProblem(recap)).toBeNull();
    expect(recap).toMatchObject({
      outcome: "created",
      reason: null,
      llm: { provider: "anthropic", model: "claude-haiku-5-5" },
      dropped: 0,
      lens: { id: "meddic" },
    });
    expect(recap.sentences.map((sentence) => sentence.kind)).toEqual(["headline", "next_step"]);
    const utteranceIds = new Set(
      socket.eventsOf("utterance.final").map((e) => e.payload.utteranceId),
    );
    for (const sentence of recap.sentences) {
      for (const evidence of sentence.evidence) {
        expect(utteranceIds.has(evidence.utteranceId)).toBe(true);
      }
    }
    expect(recap.lens?.fields).toHaveLength(6);

    // Its usage follows it, priced, and counts toward the meter.
    const usageEvent = (await socket.waitFor(
      (m) => m.t === "event" && m.event.seq === (recapEvent?.seq ?? 0) + 1,
    )) as { event: { type: string; payload: unknown } };
    expect(usageEvent.event.type).toBe("usage.recorded");
    const usage = UsageRecordedV1.parse(usageEvent.event.payload);
    expect(usage).toMatchObject({ kind: "llm", provider: "anthropic" });
    const settings = await meta(stub);
    expect(settings.recap_due).toBeUndefined();
    expect(Number(settings.recap_seq)).toBe(recapEvent?.seq);
    const meter = JSON.parse(settings.meter ?? "{}") as { costUsd: number };
    expect(meter.costUsd).toBeGreaterThan(usage.costUsd);

    await sealByAlarm(stub);
    await socket.waitFor((m) => m.t === "event" && m.event.type === "session.sealed");
    expect(types(socket).slice(-4)).toEqual([
      "session.ended",
      "recap.created",
      "usage.recorded",
      "session.sealed",
    ]);
    const projections = replay(socket.events(), defaultProjections);
    expect(projections.session?.recap).toMatchObject({ outcome: "created", seq: recapEvent?.seq });
    socket.close();
  });

  it("runs on Groq too, the session's own provider", async () => {
    const { socket } = await open();
    const key = canaryKey();
    await socket.request(startMessage({ providers: { llm: { ...GROQ } } }));
    await socket.request(utteranceMessage(demoTurnId(4), fourth));
    await socket.request(endMessage(recapRequest(key, { llm: GROQ, lens: "bant" })));
    await recapOf(socket);
    expect(recapPayload(socket)).toMatchObject({
      outcome: "created",
      llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      lens: { id: "bant" },
    });
    socket.close();
  });

  it("is skipped, no_key, when end carries no recap, and no_speech when nothing was said", async () => {
    const quiet = await open();
    await quiet.socket.request(startMessage());
    await quiet.socket.request(endMessage());
    await recapOf(quiet.socket);
    expect(recapPayload(quiet.socket)).toEqual({
      recapId: expect.any(String),
      outcome: "skipped",
      reason: "no_key",
      llm: null,
      sentences: [],
      dropped: 0,
      lens: null,
    });
    expect(types(quiet.socket).at(-1)).toBe("recap.created");
    quiet.socket.close();

    const silent = await open();
    await silent.socket.request(startMessage());
    await silent.socket.request(endMessage(recapRequest(canaryKey(), { lens: "spiced" })));
    await recapOf(silent.socket);
    expect(recapPayload(silent.socket)).toMatchObject({
      outcome: "skipped",
      reason: "no_speech",
      llm: { provider: "anthropic" },
      lens: null,
    });
    // No call was made, so no usage.
    expect(types(silent.socket).at(-1)).toBe("recap.created");
    silent.socket.close();
  });

  it("records a provider failure, invalid output, and the deadline as failed, and still seals", async () => {
    for (const [mode, reason] of [
      ["error", "provider_error"],
      ["invalid", "invalid_output"],
      ["slow", "timeout"],
    ] as const) {
      const { socket, stub } = await open();
      await scriptRecap(stub, { mode, delayMs: 2_000, deadlineMs: 300 });
      await socket.request(startMessage());
      await say(socket, [4], canaryKey());
      await socket.request(endMessage(recapRequest(canaryKey())));
      await recapOf(socket, 10_000);
      const recap = recapPayload(socket);
      expect(recap, mode).toMatchObject({ outcome: "failed", reason, sentences: [], lens: null });
      expect(recapProblem(recap)).toBeNull();
      await sealByAlarm(stub);
      await socket.waitFor((m) => m.t === "event" && m.event.type === "session.sealed");
      expect(types(socket).indexOf("recap.created")).toBeLessThan(
        types(socket).indexOf("session.sealed"),
      );
      socket.close();
    }
  }, 30_000);

  it("fails closed with provider_error for a model it has no adapter for, and the end stands", async () => {
    const { socket } = await open();
    await socket.request(startMessage());
    await say(socket, [4], canaryKey());
    const end = endMessage(
      recapRequest(canaryKey(), { llm: { provider: "anthropic", model: "claude-opus-5-5" } }),
    );
    const ack = await socket.request(end);
    expect(ack.seq).toBe(socket.eventsOf("session.ended")[0]?.seq);
    await recapOf(socket);
    expect(recapPayload(socket)).toMatchObject({
      outcome: "failed",
      reason: "provider_error",
      llm: null,
    });
    socket.close();
  });

  it("makes the seal wait for a recap still running, and keeps the tray working meanwhile", async () => {
    const { socket, stub } = await open();
    await scriptRecap(stub, { mode: "slow", delayMs: 1_500, deadlineMs: 10_000 });
    await socket.request(startMessage());
    await say(socket, [1], canaryKey());
    const proposal = socket.eventsOf("proposal.created")[0];
    socket.send(endMessage(recapRequest(canaryKey())));
    await socket.waitFor((m) => m.t === "event" && m.event.type === "session.ended");

    // A snooze from the tray is answered while the recap's call is still out.
    const snooze = snoozeMessage(String(proposal?.payload.proposalId));
    await socket.request(snooze);
    expect(socket.eventsOf("recap.created")).toHaveLength(0);

    // The repair path's seal queues behind the recap.
    const answer = await stub.sealNow();
    expect(answer).toBe("sealing");
    await socket.waitFor((m) => m.t === "event" && m.event.type === "session.sealed");
    expect(types(socket).slice(types(socket).indexOf("session.ended"))).toEqual([
      "session.ended",
      "proposal.snoozed",
      "recap.created",
      "usage.recorded",
      "session.sealed",
    ]);
    expect(recapPayload(socket).outcome).toBe("created");
    socket.close();
  }, 20_000);

  it("runs once: a resend of end, or a second end, writes no second recap", async () => {
    const { socket } = await open();
    await socket.request(startMessage());
    await say(socket, [4], canaryKey());
    const end = endMessage(recapRequest(canaryKey()));
    const first = await socket.request(end);
    await recapOf(socket);
    await socket.waitForCount(
      (m) => m.t === "event" && m.event.type === "usage.recorded",
      socket.eventsOf("usage.recorded").length + 1,
    );
    const before = socket.received.length;
    socket.send(end);
    await socket.waitFor(() => socket.received.length > before);
    expect(socket.received.at(-1)).toEqual(first);
    const again = endMessage(recapRequest(canaryKey()));
    expect((await socket.request(again)).seq).toBe(first.seq);
    expect(socket.eventsOf("recap.created")).toHaveLength(1);
    socket.close();
  });

  it("records an idle session's recap as skipped, no_key: no client, no key", async () => {
    const { socket, stub } = await open();
    const started = Date.now();
    await freezeClock(stub, started);
    await socket.request(startMessage());
    await freezeClock(stub, started + 2 * 60 * 60_000);
    await armAlarm(stub);
    await runDurableObjectAlarm(stub);
    await recapOf(socket);
    expect(types(socket)).toEqual(["session.started", "session.ended", "recap.created"]);
    expect(recapPayload(socket)).toMatchObject({ outcome: "skipped", reason: "no_key" });
    socket.close();
  });

  it("records a recap lost to a restart mid-call as failed, timeout, with the seal", async () => {
    const { socket, stub, ids } = await open();
    // Nothing reaches the Queue, so the log below is the whole story.
    await failSink(stub, true);
    await socket.request(startMessage());
    await socket.request(endMessage());
    await recapOf(socket);
    // The state a restart mid-call leaves behind: session.ended written and its recap owed, with
    // no recap.created, and the key gone with the memory that held it.
    await withSql(stub, (sql) => {
      sql.exec("DELETE FROM events WHERE type = 'recap.created'");
      sql.exec("DELETE FROM meta WHERE k = 'recap_seq'");
    });
    await setMeta(stub, { recap_due: 1 });
    await sealByAlarm(stub);
    // A fresh connection replays the whole log.
    const replayed = await open(ids);
    await replayed.socket.waitFor((m) => m.t === "event" && m.event.type === "session.sealed");
    const events = replayed.socket.events();
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "session.ended",
      "recap.created",
      "session.sealed",
    ]);
    expect(events[2]?.payload).toMatchObject({ outcome: "failed", reason: "timeout", llm: null });
    expect(recapProblem(RecapCreatedV1.parse(events[2]?.payload))).toBeNull();
    const settings = await meta(stub);
    expect(settings.recap_due).toBeUndefined();
    expect(Number(settings.recap_seq)).toBe(2);
    replayed.socket.close();
    socket.close();
  });
});

describe("the recap's key", () => {
  for (const shape of ["anthropic", "plain"] as const) {
    it(`is never stored, flushed, logged, or sent back (${shape}-shaped)`, async () => {
      const lines: string[] = [];
      for (const level of ["log", "info", "warn", "error", "debug"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        });
      }
      const { socket, stub } = await open();
      const key = canaryKey(shape);
      await socket.request(startMessage());
      await say(socket, [1, 4], canaryKey());
      await socket.request(endMessage(recapRequest(key, { lens: "meddic" })));
      await recapOf(socket);
      await sealByAlarm(stub);
      await socket.waitFor((m) => m.t === "event" && m.event.type === "session.sealed");
      expect(findSecretFragment(await dumpStorage(stub), key)).toBeUndefined();
      expect(findSecretFragment(JSON.stringify(await flushes(stub)), key)).toBeUndefined();
      expect(findSecretFragment(socket.frames.join("\n"), key)).toBeUndefined();
      expect(findSecretFragment(lines.join("\n"), key)).toBeUndefined();
      expect(lines.join("\n")).toContain('recap recorded {"outcome":"created"');
      // The flush carries the recap to Postgres.
      const flushed = (await flushes(stub)).flatMap((message) => message.events);
      expect(flushed.some((event) => event.type === "recap.created")).toBe(true);
      socket.close();
    });
  }
});
