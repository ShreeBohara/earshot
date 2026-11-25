import type { EventEnvelope } from "@earshot/core";
import { defaultProjections, fromJsonl, replay } from "@earshot/events";
import { demoSessionId, demoSessionJsonl } from "@earshot/events/testing";
import { describe, expect, it } from "vitest";
import { EMPTY_METER, foldEvent, initialSessionState, SessionStore } from "../src/session/store";

const demo = fromJsonl(demoSessionJsonl);
const SESSION = "0000000a-0000-7000-8000-000000000001";

function envelope(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  extra: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    id: `0000000e-0000-7000-8000-${seq.toString(16).padStart(12, "0")}`,
    sessionId: SESSION,
    seq,
    type,
    schemaVersion: 1,
    ts: new Date(Date.UTC(2026, 10, 19, 12, 0, seq)).toISOString(),
    payload,
    ...extra,
  };
}

const started = envelope(0, "session.started", {
  mode: "debrief",
  engine: "cascaded",
  providers: { speechToText: { provider: "assemblyai", model: "universal-streaming-english" } },
  startedAt: "2026-11-19T12:00:00.000Z",
});
const usage = (seq: number, kind: string, costUsd: number, extra: Record<string, unknown> = {}) =>
  envelope(seq, "usage.recorded", {
    usageId: `0000000b-0000-7000-8000-${seq.toString(16).padStart(12, "0")}`,
    kind,
    provider: kind === "stt" ? "assemblyai" : "anthropic",
    model: kind === "stt" ? "universal-streaming-english" : "claude-haiku-5-5",
    costUsd,
    priceTable: "2026-11-15",
    ...extra,
  });
const TURN = "0000000c-0000-7000-8000-000000000001";
const completed = (seq: number, outcome = "nothing_to_propose") =>
  envelope(seq, "turn.completed", {
    turnId: TURN,
    utteranceIds: [],
    outcome,
    proposalIds: [],
    attempts: 0,
    llmMs: 0,
  });

describe("the session store's fold", () => {
  it("folds the demo fixture to exactly what replay() builds", () => {
    const store = new SessionStore(demoSessionId, { now: () => 0 });
    for (const event of demo) expect(store.applyEvent(event).kind).toBe("applied");
    const state = store.getState();
    expect(state.projections).toStrictEqual(replay(demo, defaultProjections));
    expect(state.lastSeq).toBe(demo.length - 1);
    expect(state.fold).toBe("live");
    // Version 1 utterances arrive upcast, as replay() upcasts them.
    expect(state.events.filter((event) => event.type === "utterance.final")).not.toHaveLength(0);
    expect(
      state.events.every((event) => event.type !== "utterance.final" || event.schemaVersion === 3),
    ).toBe(true);
  });

  it("shares no objects with the messages it folded", () => {
    const store = new SessionStore(demoSessionId);
    const copies = demo.map((event) => structuredClone(event));
    for (const event of copies) store.applyEvent(event);
    const first = copies[0] as { payload: Record<string, unknown> };
    first.payload.mode = "tampered";
    expect(store.getState().projections.session?.mode).toBe("debrief");
  });

  it("ignores a duplicate, and reports a gap without folding past it", () => {
    let state = initialSessionState(SESSION);
    state = foldEvent(state, started, 0).state;
    expect(foldEvent(state, started, 1)).toEqual({ state, result: { kind: "duplicate" } });
    const gap = foldEvent(state, usage(2, "stt", 0.001), 2);
    expect(gap).toEqual({ state, result: { kind: "gap", expectedSeq: 1 } });
  });

  it("calls the logs out of sync when a seq it holds comes back as another event", () => {
    let state = initialSessionState(SESSION);
    state = foldEvent(state, started, 0).state;
    const other = { ...started, id: "0000000e-0000-7000-8000-0000000000ff" };
    const step = foldEvent(state, other, 5);
    expect(step.result).toEqual({ kind: "invalid" });
    expect(step.state.fold).toBe("invalid");
    expect(step.state.issues.at(-1)).toMatchObject({ code: "desynced", source: "client" });
  });

  it("refuses another session's event, and keeps folding its own", () => {
    let state = foldEvent(initialSessionState(SESSION), started, 0).state;
    const foreign = { ...usage(1, "stt", 0.5), sessionId: "0000000a-0000-7000-8000-0000000000ff" };
    const step = foldEvent(state, foreign, 1);
    expect(step.result).toEqual({ kind: "foreign" });
    expect(step.state.meter).toBe(EMPTY_METER);
    state = foldEvent(step.state, usage(1, "stt", 0.25), 2).state;
    expect(state.meter.costUsd).toBe(0.25);
  });

  it("stops folding, without guessing, at an event type or version it doesn't know", () => {
    const base = foldEvent(initialSessionState(SESSION), started, 0).state;
    const unknown = foldEvent(base, envelope(1, "crm.synced", {}), 1);
    expect(unknown.result).toEqual({ kind: "outdated" });
    expect(unknown.state.issues.at(-1)?.code).toBe("unknown_event");
    const newer = foldEvent(base, { ...completed(1), schemaVersion: 9 }, 1);
    expect(newer.result).toEqual({ kind: "outdated" });
    // Once stopped, nothing more folds.
    expect(foldEvent(newer.state, completed(1), 2).result).toEqual({ kind: "ignored" });
  });

  it("stops folding at an event that breaks its schema or a projection", () => {
    const base = foldEvent(initialSessionState(SESSION), started, 0).state;
    const badPayload = foldEvent(base, completed(1, "maybe"), 1);
    expect(badPayload.result).toEqual({ kind: "invalid" });
    expect(badPayload.state.issues.at(-1)?.code).toBe("bad_event");
    expect(foldEvent(base, { seq: 1 }, 1).result).toEqual({ kind: "invalid" });
    // A second session.started is impossible for the session projection.
    expect(foldEvent(base, { ...started, seq: 1, id: completed(1).id }, 1).result).toEqual({
      kind: "invalid",
    });
  });

  it("keeps the cost meter as SessionDO's meter keeps it, to the nano-dollar", () => {
    let state = foldEvent(initialSessionState(SESSION), started, 0).state;
    const records = [
      usage(1, "stt", 0.000_1, { audioMs: 4_000, socketMs: 6_000 }),
      usage(2, "llm", 0.000_2, { inputTokens: 1_500, outputTokens: 300, cachedInputTokens: 100 }),
      usage(3, "stt", 0.000_000_000_4, { audioMs: 1, socketMs: 2 }),
    ];
    for (const record of records) state = foldEvent(state, record, 0).state;
    expect(state.meter).toEqual({
      costUsd: 0.0003,
      stt: { costUsd: 0.0001, audioMs: 4_001, socketMs: 6_002 },
      llm: { costUsd: 0.0002, inputTokens: 1_500, outputTokens: 300, cachedInputTokens: 100 },
      speechToSpeech: { costUsd: 0 },
      records: 3,
    });
  });

  it("follows turns, and clears a turn's working state when it completes", () => {
    const store = new SessionStore(SESSION, { now: () => 7 });
    store.applyEvent(started);
    store.dispatch({
      type: "working",
      message: { t: "working", turnId: TURN, state: "thinking" },
      at: 5,
    });
    expect(store.getState().working).toEqual({
      [TURN]: { state: "thinking", retryInMs: null, at: 5 },
    });
    store.applyEvent(completed(1));
    expect(store.getState().working).toEqual({});
    expect(store.getState().turns).toEqual([
      {
        turnId: TURN,
        completed: {
          outcome: "nothing_to_propose",
          utteranceIds: [],
          proposalIds: [],
          attempts: 0,
          llmMs: 0,
          seq: 1,
          ts: completed(1).ts,
        },
        measured: null,
      },
    ]);
    // A late `working` for a completed turn doesn't bring it back.
    store.dispatch({
      type: "working",
      message: { t: "working", turnId: TURN, state: "retrying", retryInMs: 500 },
      at: 9,
    });
    expect(store.getState().working).toEqual({});
    expect(store.getState().receivedAt).toEqual([7, 7]);
  });

  it("changes identity only on change, and tells subscribers", () => {
    const store = new SessionStore(SESSION);
    const calls: number[] = [];
    const unsubscribe = store.subscribe(() => calls.push(store.getState().lastSeq));
    const before = store.getState();
    store.applyEvent(started);
    const after = store.getState();
    expect(after).not.toBe(before);
    store.applyEvent(started); // a duplicate changes nothing
    store.dispatch({ type: "pending", pending: 0 });
    expect(store.getState()).toBe(after);
    expect(calls).toEqual([0]);
    unsubscribe();
    store.dispatch({ type: "pending", pending: 2 });
    expect(calls).toEqual([0]);
  });

  it("keeps a second session's store free of the first one's proposals (v1's bug)", () => {
    // v1 kept tool calls in state that outlived the call; here each session gets its own store,
    // and a store refuses another session's events outright.
    const first = new SessionStore(demoSessionId);
    for (const event of demo) first.applyEvent(event);
    expect(first.getState().projections.proposals).toHaveLength(5);
    const second = new SessionStore(SESSION);
    for (const event of demo) expect(second.applyEvent(event).kind).toBe("foreign");
    second.applyEvent(started);
    expect(second.getState().projections.proposals).toEqual([]);
    expect(second.getState().events).toHaveLength(1);
  });
});
