import { describe, expect, it } from "vitest";
import { EventValidationError, fromJsonl, JsonlError, toJsonl, UnknownEventError } from "../src";
import {
  ended,
  proposal,
  SESSION_ID,
  sessionLog,
  started,
  thrown,
  turnCompleted,
  turnMeasured,
  usageRecorded,
  utterance,
  uuid,
} from "./helpers";

const log = sessionLog([started(), utterance(1, "Send Dana the deck."), proposal(1), ended()]);

/** JSONL for `log` with line `n` (1-based) replaced. */
function withLine(n: number, line: string): string {
  const lines = toJsonl(log).split("\n");
  lines[n - 1] = line;
  return lines.join("\n");
}

describe("toJsonl", () => {
  it("writes one canonical line per event: envelope in order, payload keys sorted", () => {
    const [event] = sessionLog([started()]);
    if (!event) throw new Error("unreachable");
    const { id, sessionId, seq, type, schemaVersion, ts, payload } = event;
    const scrambled = { payload: { ...payload }, ts, schemaVersion, type, seq, sessionId, id };
    expect(toJsonl([scrambled])).toBe(
      `{"id":"${uuid(1000)}","sessionId":"${SESSION_ID}","seq":0,"type":"session.started","schemaVersion":1,"ts":"2026-11-10T19:15:00.000Z","payload":{"engine":"cascaded","mode":"debrief","providers":{"speechToText":{"model":"nova-3","provider":"deepgram"}},"startedAt":"2026-11-10T19:15:00.000Z"}}\n`,
    );
  });

  it("ends every line, including the last, with a newline", () => {
    const text = toJsonl(log);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n")).toHaveLength(log.length + 1);
  });

  it("writes nothing for no events", () => {
    expect(toJsonl([])).toBe("");
  });

  it("refuses to write an event it couldn't read back", () => {
    const [event] = log;
    if (!event) throw new Error("unreachable");
    expect(() => toJsonl([{ ...event, seq: -1 }])).toThrow(EventValidationError);
  });
});

describe("fromJsonl", () => {
  it("reads back what toJsonl wrote", () => {
    expect(fromJsonl(toJsonl(log))).toEqual(log);
  });

  it("round-trips the Phase 3 event types byte for byte", () => {
    const phase3 = sessionLog([started(), usageRecorded(1), turnCompleted(1), turnMeasured(1)]);
    const text = toJsonl(phase3);
    expect(fromJsonl(text)).toEqual(phase3);
    expect(toJsonl(fromJsonl(text))).toBe(text);
  });

  it("reads an empty file as no events", () => {
    expect(fromJsonl("")).toEqual([]);
    expect(fromJsonl("\n")).toEqual([]);
  });

  it("skips blank lines but still counts them", () => {
    const text = `\n${toJsonl(log.slice(0, 2))}\n   \n{"broken":`;
    const error = thrown(() => fromJsonl(text));
    expect(error).toBeInstanceOf(JsonlError);
    expect((error as JsonlError).line).toBe(6);
  });

  it("tolerates CRLF line endings and a byte-order mark", () => {
    const text = `\uFEFF${toJsonl(log).replaceAll("\n", "\r\n")}`;
    expect(fromJsonl(text)).toEqual(log);
  });

  it("cites the line of invalid JSON", () => {
    const error = thrown(() => fromJsonl(withLine(2, "{not json")));
    expect(error).toBeInstanceOf(JsonlError);
    expect((error as JsonlError).line).toBe(2);
    expect((error as Error).message).toMatch(/^line 2: not valid JSON/);
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it("cites the line and field of an invalid envelope", () => {
    const line = JSON.stringify({ ...log[2], seq: -1 });
    expect(() => fromJsonl(withLine(3, line))).toThrow(/^line 3: invalid event envelope: seq: /);
  });

  it("cites the line, event, and field of an invalid payload", () => {
    const bad = structuredClone(log[1]);
    if (!bad) throw new Error("unreachable");
    bad.payload.confidence = 1.5;
    const error = thrown(() => fromJsonl(withLine(2, JSON.stringify(bad))));
    expect((error as Error).message).toMatch(
      /^line 2: utterance.final v2 at seq 1: invalid payload: confidence: /,
    );
    expect((error as Error).cause).toBeInstanceOf(EventValidationError);
  });

  it("checks each payload against the schema for its own version", () => {
    const v1WithWitness = { ...log[1], schemaVersion: 1 };
    expect(() => fromJsonl(withLine(2, JSON.stringify(v1WithWitness)))).toThrow(
      /^line 2: utterance.final v1 at seq 1: invalid payload: Unrecognized key: "witness"/,
    );
  });

  describe("unknown event types", () => {
    const future = { ...log[2], type: "brief.drafted", payload: { question: "Which plan?" } };
    const text = withLine(3, JSON.stringify(future));

    it("are rejected by default, citing the line", () => {
      const error = thrown(() => fromJsonl(text));
      expect((error as JsonlError).line).toBe(3);
      expect((error as Error).cause).toBeInstanceOf(UnknownEventError);
    });

    it("are kept, envelope-checked only, when the caller allows them", () => {
      const events = fromJsonl(text, { allowUnknownTypes: true });
      expect(events[2]).toEqual(future);
      expect(toJsonl(events)).toBe(text);
      const badEnvelope = withLine(3, JSON.stringify({ ...future, seq: "2" }));
      expect(() => fromJsonl(badEnvelope, { allowUnknownTypes: true })).toThrow(/^line 3: /);
    });

    it("don't cover newer versions of known types", () => {
      const v4 = withLine(2, JSON.stringify({ ...log[1], schemaVersion: 4 }));
      expect(() => fromJsonl(v4, { allowUnknownTypes: true })).toThrow(
        /^line 2: utterance.final v4 at seq 1: newer than this reader knows/,
      );
    });
  });
});
