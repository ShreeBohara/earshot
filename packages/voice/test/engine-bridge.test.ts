import type { UtteranceFinalV2 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import type { VoiceEvent } from "../src/engine";
import { createDebriefEngine } from "../src/engines/debrief";
import { createSessionClient } from "../src/session/client";
import { type ArmedCorrection, connectEngine } from "../src/session/engine-bridge";
import { SessionWitness } from "../src/session/witness";
import { FakeCaptureSource } from "../src/testing/fake-capture";
import { FakePageLifecycle } from "../src/testing/fake-page";
import { FakeSessionServer, NO_TARGET } from "../src/testing/fake-session-server";
import { settle } from "../src/testing/fake-socket";
import { createFakeSttAdapter, fakeCredential } from "../src/testing/fake-stt";
import { createFakeWitness } from "../src/testing/fake-witness";
import { counterIds } from "./support/ids";
import { ManualClock } from "./support/manual-clock";

const KEY = "gsk_canary0123456789abcdefghijklmnop";
const LLM = { provider: "groq", model: "openai/gpt-oss-20b" } as const;

const said: UtteranceFinalV2 = {
  utteranceId: "0000000d-0000-7000-8000-000000000001",
  text: "Acme renewed for two years",
  confidence: 0.9,
  startMs: 1_000,
  endMs: 2_600,
  witness: "biased",
};

function fakeEngine() {
  const listeners = new Set<(event: VoiceEvent) => void>();
  return {
    on(listener: (event: VoiceEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: VoiceEvent) {
      for (const listener of listeners) listener(event);
    },
    get listeners() {
      return listeners.size;
    },
  };
}

function fakeClient() {
  const calls: string[] = [];
  return {
    calls,
    sendUtterance: (turnId: string, utterance: UtteranceFinalV2) => {
      calls.push(`utterance ${turnId} ${utterance.text}`);
      return "id";
    },
    sendTurnEnd: (input: { turnId: string; trigger: string; key: string; llm: unknown }) => {
      calls.push(
        `turn_end ${input.turnId} ${input.trigger} ${input.key} ${JSON.stringify(input.llm)}`,
      );
      return "id";
    },
    sendUsage: (input: { provider: string; audioMs: number; socketMs: number }) => {
      calls.push(`usage ${input.provider} ${input.audioMs} ${input.socketMs}`);
      return "id";
    },
    reportIssue: (issue: { code: string }) => {
      calls.push(`issue ${issue.code}`);
    },
    sendCorrection: async (input: { turnId: string; proposalId: string; field: string }) => {
      calls.push(`correct ${input.turnId} ${input.proposalId} ${input.field}`);
      return { ok: true as const, via: "socket" as const };
    },
  };
}

describe("connectEngine: a spoken correction (Phase 5 WP13)", () => {
  it("ends the armed turn with correct, no key, and no witness, then goes back to turn_end", async () => {
    const engine = fakeEngine();
    const client = fakeClient();
    const dropped: string[] = [];
    const settled: unknown[] = [];
    let armed: ArmedCorrection | undefined = {
      correctionId: "c1",
      proposalId: "p1",
      field: "dueDate",
      settled: (delivery) => void settled.push(delivery),
    };
    connectEngine(engine, client, {
      llm: () => LLM,
      key: () => KEY,
      witness: {
        finalHeard: () => {},
        turnEnded: () => {},
        turnDropped: (turnId: string) => dropped.push(turnId),
        turnAudio: () => {},
      },
      takeCorrection: () => {
        const taken = armed;
        armed = undefined;
        return taken;
      },
    });
    engine.emit({ type: "turn_end", turnId: "t1", trigger: "ptt_release" });
    engine.emit({ type: "turn_end", turnId: "t2", trigger: "ptt_release" });
    await Promise.resolve();
    expect(client.calls).toEqual([
      "correct t1 p1 dueDate",
      `turn_end t2 ptt_release ${KEY} ${JSON.stringify(LLM)}`,
    ]);
    expect(dropped).toEqual(["t1"]);
    expect(settled).toEqual([{ ok: true, via: "socket" }]);
  });
});

describe("connectEngine", () => {
  it("sends finals, turn ends with this turn's key, and usage; keeps the rest on the device", () => {
    const engine = fakeEngine();
    const client = fakeClient();
    let key: string | undefined = KEY;
    const stop = connectEngine(engine, client, { llm: () => LLM, key: () => key });
    engine.emit({ type: "state", state: "recording" });
    engine.emit({ type: "level", mic: 0.4, agent: 0 });
    engine.emit({ type: "partial", text: "Acme ren", startMs: 1_000, endMs: 1_400 });
    engine.emit({ type: "final", turnId: "t1", utterance: said });
    engine.emit({ type: "turn_end", turnId: "t1", trigger: "ptt_release" });
    engine.emit({ type: "error", code: "keyterms_rejected", retryable: false });
    engine.emit({
      type: "usage",
      provider: "fake",
      model: "fake-1",
      audioMs: 1_800,
      socketMs: 2_400,
    });
    key = undefined;
    engine.emit({ type: "turn_end", turnId: "t2", trigger: "ptt_release" });
    expect(client.calls).toEqual([
      "utterance t1 Acme renewed for two years",
      `turn_end t1 ptt_release ${KEY} ${JSON.stringify(LLM)}`,
      "usage fake 1800 2400",
      "issue missing_key",
    ]);
    stop();
    expect(engine.listeners).toBe(0);
  });

  it("hands the second witness each sent turn, its finals, and its audio; a turn not sent is dropped", () => {
    const engine = fakeEngine();
    const client = fakeClient();
    const calls: string[] = [];
    const witness = {
      finalHeard: (turnId: string, u: { startMs: number; endMs: number }) =>
        void calls.push(`final ${turnId} ${u.startMs}-${u.endMs}`),
      turnEnded: (turnId: string) => void calls.push(`ended ${turnId}`),
      turnDropped: (turnId: string) => void calls.push(`dropped ${turnId}`),
      turnAudio: (turnId: string, audio: { durationMs: number } | null) =>
        void calls.push(`audio ${turnId} ${audio?.durationMs ?? "none"}`),
    };
    let key: string | undefined = KEY;
    connectEngine(engine, client, { llm: () => LLM, key: () => key, witness });
    engine.emit({ type: "final", turnId: "t1", utterance: said });
    engine.emit({ type: "turn_end", turnId: "t1", trigger: "ptt_release" });
    engine.emit({
      type: "turn_audio",
      turnId: "t1",
      audio: { startMs: 1_000, durationMs: 2_000, pcm: new Int16Array(32_000) },
    });
    key = undefined;
    engine.emit({ type: "turn_end", turnId: "t2", trigger: "ptt_release" });
    engine.emit({ type: "turn_audio", turnId: "t2", audio: null });
    expect(calls).toEqual([
      "final t1 1000-2600",
      "ended t1",
      "audio t1 2000",
      "dropped t2",
      "audio t2 none",
    ]);
    // The audio never reaches SessionDO.
    expect(client.calls.some((call) => call.includes("audio"))).toBe(false);
  });
});

describe("the Debrief engine through SessionClient to SessionDO (fakes end to end)", () => {
  it("turns one push-to-talk turn into a proposal card, with the key only on turn_end", async () => {
    const clock = new ManualClock();
    const sessionId = "0000000a-0000-7000-8000-0000000e2e01";
    const server = new FakeSessionServer({
      sessionId,
      propose: (turn) =>
        turn.utterances.map((utterance) => ({
          type: "note",
          target: NO_TARGET,
          fields: {
            body: {
              value: utterance.text,
              evidence: {
                utteranceId: utterance.utteranceId,
                span: [0, utterance.text.length],
                audioMs: [utterance.startMs, utterance.endMs],
                confidence: utterance.confidence,
              },
            },
          },
          riskFlags: [],
        })),
    });
    const client = createSessionClient({
      sessionId,
      url: server.edgeUrl,
      socket: server.factory,
      clock,
      random: () => 0.5,
      page: new FakePageLifecycle(),
      getTicket: async () => server.issueTicket(),
    });
    client.start();
    await settle(200);
    client.sendStart({
      providers: { speechToText: { provider: "fake", model: "fake-1" }, llm: LLM },
      startedAt: "2026-11-19T12:00:00.000Z",
      entities: [{ id: "acme", kind: "company", name: "Acme", aliases: [] }],
      timeZone: "America/Chicago",
    });
    await settle(200);

    const capture = new FakeCaptureSource();
    const engine = createDebriefEngine({
      adapter: createFakeSttAdapter({
        script: { turns: [{ text: "Acme renewed for two years", startMs: 1_000, endMs: 2_600 }] },
        clock,
        createId: counterIds(),
      }),
      getCredential: async () => fakeCredential(),
      capture: capture.factory(),
      clock,
      random: () => 0.5,
    });
    const disconnect = connectEngine(engine, client, { llm: () => LLM, key: () => KEY });
    await engine.start({
      stream: {} as MediaStream,
      keyterms: ["Acme"],
      signal: new AbortController().signal,
    });
    engine.pushToTalk(true);
    for (let done = 0; done < 1_800; done += 32) {
      capture.speak(32);
      await clock.advance(32);
    }
    engine.pushToTalk(false);
    await clock.advance(2_000);
    await engine.stop();
    await settle(200);
    await clock.advance(300);

    const state = client.store.getState();
    expect(state.projections.utterances.map((u) => u.text)).toEqual(["Acme renewed for two years"]);
    expect(state.projections.proposals).toHaveLength(1);
    expect(state.projections.proposals[0]?.fields.body?.value).toBe("Acme renewed for two years");
    expect(state.turns.map((turn) => turn.completed?.outcome)).toEqual(["proposals"]);
    expect(state.meter.stt.socketMs).toBeGreaterThan(0);
    expect(state.pending).toBe(0);
    // Only finals, turn ends, and usage reached SessionDO; the key only inside turn_end.
    expect([...new Set(server.received.map((m) => m.t))].sort()).toEqual([
      "ack",
      "hello",
      "start",
      "turn_end",
      "usage",
      "utterance",
    ]);
    const frames = server.sockets.flatMap((socket) => socket.received).map(String);
    for (const frame of frames.filter((f) => f.includes(KEY))) {
      expect(JSON.parse(frame).t).toBe("turn_end");
    }
    expect(JSON.stringify(state)).not.toContain(KEY);
    disconnect();
    client.stop();
  });

  it("runs the second witness beside the turn: its witness follows turn_end, and its usage is priced by the Groq row", async () => {
    const clock = new ManualClock();
    const sessionId = "0000000a-0000-7000-8000-0000000e2e02";
    const server = new FakeSessionServer({
      sessionId,
      compare: ({ proposals }) =>
        proposals.map((proposal) => ({
          proposalId: proposal.proposalId,
          source: "witness" as const,
          flags: [{ kind: "witness_conflict" as const, field: "target" }],
          target: null,
          conflict: null,
        })),
      propose: (turn) =>
        turn.utterances.map((utterance) => ({
          type: "note",
          target: NO_TARGET,
          fields: {
            body: {
              value: utterance.text,
              evidence: {
                utteranceId: utterance.utteranceId,
                span: [0, utterance.text.length],
                audioMs: [utterance.startMs, utterance.endMs],
                confidence: utterance.confidence,
              },
            },
          },
          riskFlags: [],
        })),
    });
    const client = createSessionClient({
      sessionId,
      url: server.edgeUrl,
      socket: server.factory,
      clock,
      random: () => 0.5,
      page: new FakePageLifecycle(),
      getTicket: async () => server.issueTicket(),
    });
    client.start();
    await settle(200);
    client.sendStart({
      providers: { speechToText: { provider: "fake", model: "fake-1" }, llm: LLM },
      startedAt: "2026-11-19T12:00:00.000Z",
      entities: [{ id: "acme", kind: "company", name: "Acme", aliases: [] }],
    });
    await settle(200);

    const runner = createFakeWitness({
      script: { turns: [{ text: "Akme renewed for two years", latencyMs: 700 }] },
      createId: counterIds(),
    });
    const witness = new SessionWitness({
      client,
      setup: () => ({ status: "on", runner }),
      clock,
    });
    const capture = new FakeCaptureSource();
    const engine = createDebriefEngine({
      adapter: createFakeSttAdapter({
        script: { turns: [{ text: "Acme renewed for two years", startMs: 1_000, endMs: 2_600 }] },
        clock,
        createId: () => "0000000d-0000-7000-8000-00000000aaaa",
      }),
      getCredential: async () => fakeCredential(),
      capture: capture.factory(),
      clock,
      random: () => 0.5,
      turnAudio: witness.recordsAudio,
    });
    const disconnect = connectEngine(engine, client, { llm: () => LLM, key: () => KEY, witness });
    await engine.start({
      stream: {} as MediaStream,
      keyterms: ["Acme"],
      signal: new AbortController().signal,
    });
    engine.pushToTalk(true);
    for (let done = 0; done < 1_800; done += 32) {
      capture.speak(32);
      await clock.advance(32);
    }
    engine.pushToTalk(false);
    for (let done = 0; done < 320; done += 32) {
      capture.silence(32);
      await clock.advance(32);
    }
    await clock.advance(2_000);
    await witness.idle();
    await engine.stop();
    await settle(200);
    await clock.advance(300);

    // The audio went to the witness, once, from the press on the session's clock.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.turnStartMs).toBe(0);
    // The witness reached SessionDO after its turn's turn_end.
    const order = server.received.flatMap((m) =>
      m.t === "turn_end" || m.t === "witness" ? [m.t] : [],
    );
    expect(order).toEqual(["turn_end", "witness"]);
    const state = client.store.getState();
    expect(state.projections.utterances.map((u) => [u.witness, u.text])).toEqual([
      ["biased", "Acme renewed for two years"],
      ["unbiased", "Akme renewed for two years"],
    ]);
    const witnessed = state.events.find((event) => event.type === "turn.witnessed");
    expect(witnessed?.payload).toMatchObject({
      outcome: "compared",
      provider: "groq",
      model: "whisper-large-v3-turbo",
      conflicts: 1,
      latencyMs: 700,
      reason: null,
    });
    expect(state.projections.proposals[0]?.riskFlags).toEqual([
      { kind: "witness_conflict", field: "target" },
    ]);
    // 2 s of audio, billed as Groq's 10 s minimum at $0.04/hr.
    const groq = state.events.find(
      (event) => event.type === "usage.recorded" && event.payload.provider === "groq",
    );
    expect(groq?.payload).toMatchObject({ kind: "stt", costUsd: 0.000111111, socketMs: 0 });
    expect(state.pending).toBe(0);
    // The turn's key rode on turn_end alone.
    const frames = server.sockets.flatMap((socket) => socket.received).map(String);
    for (const frame of frames.filter((f) => f.includes(KEY))) {
      expect(JSON.parse(frame).t).toBe("turn_end");
    }
    disconnect();
    client.stop();
  });
});
