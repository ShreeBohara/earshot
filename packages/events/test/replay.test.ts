import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultProjections,
  EventValidationError,
  fromJsonl,
  type Projection,
  replay,
  type SessionEvent,
  StreamError,
  UnknownEventError,
} from "../src";
import {
  deepFreeze,
  ended,
  proposal,
  readFixture,
  review,
  sessionLog,
  started,
  utterance,
  utteranceV1,
  uuid,
} from "./helpers";

/** A projection that records the type and seq of every event it's given. */
function recorder(): Projection<readonly string[]> {
  return { initial: [], apply: (seen, event) => [...seen, `${event.type}@${event.seq}`] };
}

const demo = readFixture("demo-session.jsonl");

describe("replay", () => {
  it("returns each projection's initial state for an empty log", () => {
    expect(replay([], defaultProjections)).toEqual({
      session: null,
      utterances: [],
      proposals: [],
    });
  });

  it("folds every event into every projection, in seq order", () => {
    const log = sessionLog([started(), utterance(1), proposal(1), review(1, "approved"), ended()]);
    const { a, b } = replay(log, { a: recorder(), b: recorder() });
    const expected = [
      "session.started@0",
      "utterance.final@1",
      "proposal.created@2",
      "proposal.reviewed@3",
      "session.ended@4",
    ];
    expect(a).toEqual(expected);
    expect(b).toEqual(expected);
  });

  it("upcasts old events before projections see them", () => {
    const log = sessionLog([started(), utteranceV1(1, "Met Dana Lee.")]);
    const everything: Projection<readonly SessionEvent[]> = {
      initial: [],
      apply: (seen, event) => [...seen, event],
    };
    const { seen } = replay(log, { seen: everything });
    expect(seen[1]).toMatchObject({
      schemaVersion: 3,
      payload: { witness: "biased", input: "speech" },
    });
  });

  it("validates every event before folding any", () => {
    const bad = utterance(2);
    bad.payload.text = "";
    const log = sessionLog([started(), utterance(1), bad]);
    const spy = recorder();
    const apply = vi.spyOn(spy, "apply");
    expect(() => replay(log, { spy })).toThrow(EventValidationError);
    expect(apply).not.toHaveBeenCalled();
  });

  it("rejects an invalid envelope", () => {
    const [first] = sessionLog([started()]);
    expect(() => replay([{ ...first, ts: "Tuesday" }], defaultProjections)).toThrow(
      /^event 0: invalid event envelope: ts: /,
    );
  });

  describe("stream checks", () => {
    const log = sessionLog([started(), utterance(1), utterance(2)]);

    it("rejects events from more than one session", () => {
      const mixed = [...log.slice(0, 2), { ...log[2], sessionId: uuid(0xb0b) }];
      expect(() => replay(mixed, defaultProjections)).toThrow(StreamError);
    });

    it("rejects a gap, a repeat, or a log that doesn't start at seq 0", () => {
      const gap = [...log.slice(0, 2), { ...log[2], seq: 3 }];
      expect(() => replay(gap, defaultProjections)).toThrow(/event 2 has seq 3/);
      const repeat = [...log.slice(0, 2), { ...log[2], seq: 1 }];
      expect(() => replay(repeat, defaultProjections)).toThrow(StreamError);
      expect(() => replay(log.slice(1), defaultProjections)).toThrow(/event 0 has seq 1/);
    });

    it("rejects a repeated event id", () => {
      const repeated = [...log.slice(0, 2), { ...log[2], id: log[1]?.id }];
      expect(() => replay(repeated, defaultProjections)).toThrow(/appears twice/);
    });
  });

  describe("unknown event types", () => {
    const log = sessionLog([
      started(),
      utterance(1),
      { type: "brief.drafted", schemaVersion: 1, payload: { question: "Which plan?" } },
      proposal(1),
    ]);

    it("are rejected by default", () => {
      expect(() => replay(log, defaultProjections)).toThrow(UnknownEventError);
      expect(() => replay(log, defaultProjections)).toThrow(/brief.drafted v1 at seq 2/);
    });

    it("are skipped, never reaching a projection, when the caller allows them", () => {
      const { seen, session, proposals } = replay(
        log,
        { seen: recorder(), ...defaultProjections },
        { allowUnknownTypes: true },
      );
      expect(seen).toEqual(["session.started@0", "utterance.final@1", "proposal.created@3"]);
      expect(session?.lastSeq).toBe(3);
      expect(proposals).toHaveLength(1);
    });

    it("don't cover a newer version of a known type", () => {
      const v4 = sessionLog([started(), { ...utterance(1), schemaVersion: 4 }]);
      expect(() => replay(v4, defaultProjections, { allowUnknownTypes: true })).toThrow(
        /utterance.final v4 at seq 1: newer than this reader knows/,
      );
    });
  });

  describe("determinism", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("never reads the clock or randomness", () => {
      const forbid = (what: string) => () => {
        throw new Error(`replay called ${what}`);
      };
      vi.spyOn(Date, "now").mockImplementation(forbid("Date.now()"));
      vi.spyOn(Math, "random").mockImplementation(forbid("Math.random()"));
      vi.spyOn(crypto, "randomUUID").mockImplementation(forbid("crypto.randomUUID()"));
      vi.spyOn(crypto, "getRandomValues").mockImplementation(forbid("crypto.getRandomValues()"));
      expect(() => replay(fromJsonl(demo), defaultProjections)).not.toThrow();
    });

    it("gives the same result whatever the time", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
      const before = replay(fromJsonl(demo), defaultProjections);
      vi.setSystemTime(new Date("2099-12-31T23:59:59Z"));
      const after = replay(fromJsonl(demo), defaultProjections);
      expect(after).toStrictEqual(before);
    });

    it("doesn't mutate its input", () => {
      const events = deepFreeze(fromJsonl(demo));
      expect(() => replay(events, defaultProjections)).not.toThrow();
      expect(events).toEqual(fromJsonl(demo));
    });

    it("returns state that shares no objects with its input", () => {
      const events = fromJsonl(demo);
      const { proposals } = replay(events, defaultProjections);
      const name = proposals[0]?.fields.name;
      if (!name) throw new Error("the demo's first proposal has a name field");
      name.value = "Someone Else";
      expect(events).toEqual(fromJsonl(demo));
    });
  });
});
