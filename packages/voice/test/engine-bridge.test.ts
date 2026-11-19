import type { UtteranceFinalV2 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import type { VoiceEvent } from "../src/engine";
import { createDebriefEngine } from "../src/engines/debrief";
import { createSessionClient } from "../src/session/client";
import { connectEngine } from "../src/session/engine-bridge";
import { FakeCaptureSource } from "../src/testing/fake-capture";
import { FakePageLifecycle } from "../src/testing/fake-page";
import { FakeSessionServer } from "../src/testing/fake-session-server";
import { settle } from "../src/testing/fake-socket";
import { createFakeSttAdapter, fakeCredential } from "../src/testing/fake-stt";
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
  };
}

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
          targetEntityId: null,
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
});
