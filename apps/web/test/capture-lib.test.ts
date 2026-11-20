import type { EntityRef, TargetV2 } from "@earshot/core";
import type { StoredKeyMeta } from "@earshot/keys";
import { SessionStore } from "@earshot/voice/session";
import { describe, expect, it } from "vitest";
import { demoState } from "@/components/capture/fixtures";
import { deriveActivity } from "@/lib/capture/activity";
import {
  askCandidates,
  listProposals,
  RISK_LABELS,
  riskLabel,
  targetHeading,
  turnOutcomeText,
} from "@/lib/capture/copy";
import { TurnMarksRecorder } from "@/lib/capture/marks";
import { evidenceSpans, findMentions, segmentText } from "@/lib/capture/mentions";
import { choiceLabel, defaultSelection, providerChoices } from "@/lib/capture/providers";
import {
  readWitnessSetting,
  WITNESS_COPY,
  WITNESS_SETTING_EVENT,
  WITNESS_SETTING_KEY,
  witnessPromptDue,
  witnessStatus,
  writeWitnessSetting,
} from "@/lib/capture/witness";

const ACME: EntityRef = { id: "co_1", kind: "company", name: "Acme Corp", aliases: ["Acme"] };
const DANA: EntityRef = { id: "ct_1", kind: "contact", name: "Dana Lee", aliases: [] };
const AKME: EntityRef = { id: "co_2", kind: "company", name: "Akme Dynamics", aliases: ["Akme"] };

describe("findMentions", () => {
  it("finds exact names and aliases, ignoring case, longest first, at word boundaries", () => {
    const text = "Met dana lee at ACME CORP. Acme's team, not Acmeville or Akme.";
    const found = findMentions(text, [ACME, DANA, AKME]).map((m) => [
      text.slice(m.start, m.end),
      m.entity.id,
    ]);
    expect(found).toEqual([
      ["dana lee", "ct_1"],
      ["ACME CORP", "co_1"],
      ["Acme", "co_1"],
      ["Akme", "co_2"],
    ]);
  });

  it("matches nothing in an empty list, and ignores blank aliases", () => {
    expect(findMentions("Acme Corp", [])).toEqual([]);
    expect(findMentions("a  b", [{ ...ACME, name: " ", aliases: [""] }])).toEqual([]);
  });
});

describe("segmentText", () => {
  it("splits at mention and highlight edges, so each run has one style", () => {
    const text = "Met Dana Lee at Acme Corp.";
    const segments = segmentText(text, findMentions(text, [ACME, DANA]), [[4, 16]]);
    expect(segments.map((s) => [s.text, s.mention?.id ?? null, s.highlight])).toEqual([
      ["Met ", null, false],
      ["Dana Lee", "ct_1", true],
      [" at ", null, true],
      ["Acme Corp", "co_1", false],
      [".", null, false],
    ]);
    expect(segments.map((s) => s.text).join("")).toBe(text);
  });

  it("clamps out-of-range highlights", () => {
    expect(segmentText("abc", [], [[-5, 99]]).map((s) => [s.text, s.highlight])).toEqual([
      ["abc", true],
    ]);
  });
});

describe("evidenceSpans", () => {
  it("groups each field's quoted span by utterance", () => {
    const evidence = (utteranceId: string, span: [number, number]) => ({
      value: "x",
      evidence: { utteranceId, span, audioMs: [0, 1] as [number, number], confidence: 0.9 },
    });
    const spans = evidenceSpans({ name: evidence("u1", [4, 12]), title: evidence("u1", [20, 30]) });
    expect([...spans]).toEqual([
      [
        "u1",
        [
          [4, 12],
          [20, 30],
        ],
      ],
    ]);
  });
});

describe("provider choices", () => {
  const key = (provider: StoredKeyMeta["provider"], label = "default"): StoredKeyMeta => ({
    provider,
    label,
    last4: "abcd",
    addedAt: "2026-11-19T00:00:00.000Z",
  });

  it("offers each provider the device has a key for, one entry per key", () => {
    const choices = providerChoices([
      key("deepgram"),
      key("groq"),
      key("groq", "work"),
      key("openai"),
    ]);
    expect(choices.stt.map((c) => c.value)).toEqual([
      "deepgram-nova3:default",
      "deepgram-flux:default",
    ]);
    expect(choices.llm.map((c) => c.value)).toEqual(["groq:default", "groq:work"]);
    expect(defaultSelection(choices)).toEqual({
      stt: "deepgram-nova3:default",
      llm: "groq:default",
    });
    const work = choices.llm.find((choice) => choice.keyLabel === "work");
    expect(work && choiceLabel(work)).toBe("Groq · gpt-oss-20b (key “work” …abcd)");
  });

  it("has no default without both kinds of key", () => {
    expect(defaultSelection(providerChoices([key("assemblyai")]))).toBeNull();
    expect(defaultSelection(providerChoices([]))).toBeNull();
  });
});

describe("copy", () => {
  it("lists proposal types in plain English", () => {
    expect(listProposals(["contact"])).toBe("a contact");
    expect(listProposals(["contact", "task"])).toBe("a contact and a task");
    expect(listProposals(["contact", "task", "note"])).toBe("a contact, a task, and a note");
    expect(turnOutcomeText("proposals", ["deal_update"])).toBe("Proposed a deal update.");
  });
});

describe("the tray's copy for targets and risks", () => {
  const names: Record<string, string> = {
    co_1: "Acme Dynamics",
    co_2: "Akme Dynamics",
    co_3: "Acmi Dynamics",
  };
  const nameOf = (id: string) => names[id] ?? "A CRM record";
  const target = (overrides: Partial<TargetV2>): TargetV2 => ({
    decision: "none",
    entityId: null,
    kind: null,
    basis: null,
    p: null,
    mention: null,
    company: null,
    candidates: [],
    ...overrides,
  });

  it("says the linker's decision: a name, a question, a new record, or none", () => {
    expect(targetHeading(target({ decision: "linked", entityId: "co_1" }), nameOf)).toBe(
      "Acme Dynamics",
    );
    const ask = target({
      decision: "ask",
      candidates: [
        { entityId: "co_1", p: 0.48 },
        { entityId: "co_2", p: 0.47 },
        { entityId: "co_3", p: 0.03 },
        { entityId: null, p: 0.02 },
      ],
    });
    // The spec's example: candidates under 5% aren't named.
    expect(targetHeading(ask, nameOf)).toBe("Ask: Acme Dynamics or Akme Dynamics?");
    expect(askCandidates(ask).map((candidate) => candidate.entityId)).toEqual(["co_1", "co_2"]);
    const three = target({
      decision: "ask",
      candidates: [
        { entityId: "co_1", p: 0.4 },
        { entityId: "co_2", p: 0.3 },
        { entityId: null, p: 0.3 },
      ],
    });
    expect(targetHeading(three, nameOf)).toBe(
      "Ask: Acme Dynamics, Akme Dynamics, or a new record?",
    );
    const unlikely = target({ decision: "ask", candidates: [{ entityId: "co_3", p: 0.01 }] });
    expect(targetHeading(unlikely, nameOf)).toBe("Ask: Acmi Dynamics?");
    expect(targetHeading(target({ decision: "new" }), nameOf)).toBe("New");
    expect(targetHeading(target({}), nameOf)).toBe("No record");
  });

  it("labels every risk kind, the target's without a field name", () => {
    for (const label of Object.values(RISK_LABELS)) expect(label.length).toBeGreaterThan(0);
    expect(riskLabel({ kind: "value_mismatch", field: "dueDate" })).toBe(
      "Differs from what was said: due date",
    );
    expect(riskLabel({ kind: "ambiguous_target", field: "target" })).toBe("Pick the record");
    expect(riskLabel({ kind: "new_entity" })).toBe("Creates a record");
    // `unsupported` means one thing: the words cited don't back it.
    expect(riskLabel({ kind: "unsupported", field: "dueDate" })).toBe(
      "Not backed by what was said: due date",
    );
    expect(riskLabel({ kind: "unsupported", field: "target" })).toBe(
      "Record's name not in the transcript",
    );
  });
});

describe("TurnMarksRecorder", () => {
  it("sends one turn's four marks once its first proposal's card has painted", () => {
    const sent: unknown[] = [];
    const marks = new TurnMarksRecorder((turnId, m) => sent.push({ turnId, ...m }));
    marks.released(1_000);
    marks.final("t1", 1_400.25);
    marks.turnEnded("t1", "ptt_release", "push_to_talk", 1_450);
    marks.proposalArrived("p2", 2_300);
    marks.proposalArrived("p1", 2_200);
    marks.turnCompleted("t1", ["p1", "p2"]);
    expect(sent).toEqual([]);
    marks.painted("p2", 2_350);
    expect(sent).toEqual([]); // p1 came first: its card is the mark
    marks.painted("p1", 2_260);
    marks.painted("p1", 9_999);
    expect(sent).toEqual([
      {
        turnId: "t1",
        mode: "push_to_talk",
        speechEndMs: 1_000,
        finalMs: 1_400.3,
        proposalMs: 2_200,
        paintMs: 2_260,
      },
    ]);
  });

  it("pairs releases with turn ends in order, and sends nothing for a turn without proposals", () => {
    const sent: { turnId: string; speechEndMs: number }[] = [];
    const marks = new TurnMarksRecorder((turnId, m) =>
      sent.push({ turnId, speechEndMs: m.speechEndMs }),
    );
    marks.released(100);
    marks.released(200);
    marks.turnEnded("a", "ptt_release", "push_to_talk", 150);
    marks.turnEnded("b", "ptt_release", "push_to_talk", 250);
    marks.turnCompleted("a", []);
    marks.proposalArrived("pb", 300);
    marks.turnCompleted("b", ["pb"]);
    marks.painted("pb", 320);
    expect(sent).toEqual([{ turnId: "b", speechEndMs: 200 }]);
  });

  it("uses the end of speech in hands-free", () => {
    const sent: number[] = [];
    const marks = new TurnMarksRecorder((_, m) => sent.push(m.speechEndMs));
    marks.speechStopped(500);
    marks.turnEnded("h", "provider_eot", "hands_free", 900);
    marks.proposalArrived("p", 1_000);
    marks.turnCompleted("h", ["p"]);
    marks.painted("p", 1_010);
    expect(sent).toEqual([500]);
  });
});

describe("deriveActivity", () => {
  const sessionId = "01a1c6e2-9320-7deb-a57a-ba62dc02df02";
  const envelope = (seq: number, type: string, payload: unknown) => ({
    id: `01a1c6e2-9348-7bf1-9633-${String(seq).padStart(12, "0")}`,
    sessionId,
    seq,
    type,
    schemaVersion: 1,
    ts: "2026-11-10T19:15:00.040Z",
    payload,
  });

  it("types turn outcomes as responses or errors, and keeps one Working… row, last", () => {
    let now = 0;
    const store = new SessionStore(sessionId, { now: () => now });
    store.applyEvent(
      envelope(0, "session.started", {
        engine: "cascaded",
        mode: "debrief",
        providers: {
          llm: { model: "gpt-oss-20b", provider: "groq" },
          speechToText: { model: "nova-3", provider: "deepgram" },
        },
        startedAt: "2026-11-10T19:15:00.000Z",
      }),
    );
    now = 10;
    store.applyEvent(
      envelope(1, "turn.completed", {
        turnId: "01a1c6e2-0000-7000-8000-000000000001",
        utteranceIds: [],
        outcome: "nothing_to_propose",
        proposalIds: [],
        attempts: 1,
        llmMs: 300,
      }),
    );
    now = 20;
    store.applyEvent(
      envelope(2, "turn.completed", {
        turnId: "01a1c6e2-0000-7000-8000-000000000002",
        utteranceIds: [],
        outcome: "provider_error",
        proposalIds: [],
        attempts: 3,
        llmMs: 8_000,
      }),
    );
    for (const [turn, at] of [
      ["01a1c6e2-0000-7000-8000-000000000003", 30],
      ["01a1c6e2-0000-7000-8000-000000000004", 40],
    ] as const) {
      store.dispatch({
        type: "working",
        message: {
          t: "working",
          turnId: turn,
          state: at === 40 ? "retrying" : "thinking",
          retryInMs: 2_000,
        },
        at,
      });
    }
    const local = [{ id: "local-1", kind: "connection" as const, text: "Reconnected.", at: 15 }];
    const rows = deriveActivity(store.getState(), local);
    expect(rows.map((row) => [row.kind, row.text])).toEqual([
      ["response", "Nothing to propose from that turn."],
      ["connection", "Reconnected."],
      ["error", "The model provider failed, so that turn got no proposals."],
      ["action", "Retrying in 2 s…"],
    ]);
    expect(rows.filter((row) => row.transient)).toHaveLength(1);
  });
});

describe("the stories' session fixture", () => {
  it("folds cleanly, as a live session would", () => {
    const state = demoState({ reviewed: true });
    expect(state.fold).toBe("live");
    expect(state.issues).toEqual([]);
    expect(state.projections.utterances).toHaveLength(3);
    expect(state.projections.proposals.map((p) => [p.type, p.status, p.target.decision])).toEqual([
      ["contact", "proposed", "ask"],
      ["deal_update", "approved", "linked"],
      ["task", "proposed", "linked"],
    ]);
    expect(state.meter.costUsd).toBeCloseTo(0.00063, 9);
  });
});

describe("the second witness's setting (decision 8)", () => {
  const groq = [{ provider: "groq" as const }];
  const none: { provider: "assemblyai" }[] = [{ provider: "assemblyai" }];

  it("asks once per device, only with a Groq key here, and runs only on a yes", () => {
    expect(witnessPromptDue(null, groq)).toBe(true);
    expect(witnessPromptDue(null, none)).toBe(false); // off without a Groq key, unasked
    expect(witnessPromptDue("off", groq)).toBe(false); // answered: never asked again
    expect(witnessPromptDue("groq", groq)).toBe(false);
    expect(witnessStatus(null, groq)).toBe("off"); // unanswered is off
    expect(witnessStatus("off", groq)).toBe("off");
    expect(witnessStatus("groq", groq)).toBe("on");
    expect(witnessStatus("groq", none)).toBe("no_key");
  });

  it("keeps the answer in the device's storage, and tells this tab", () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };
    const events = new EventTarget();
    let told = 0;
    events.addEventListener(WITNESS_SETTING_EVENT, () => {
      told += 1;
    });
    expect(readWitnessSetting(storage)).toBeNull();
    writeWitnessSetting("groq", { storage, events });
    expect(items.get(WITNESS_SETTING_KEY)).toBe("groq");
    expect(readWitnessSetting(storage)).toBe("groq");
    expect(told).toBe(1);
    items.set(WITNESS_SETTING_KEY, "maybe");
    expect(readWitnessSetting(storage)).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readWitnessSetting(throwing)).toBeNull();
  });

  it("says the spec's line", () => {
    expect(WITNESS_COPY.line).toBe(
      "Sends each turn’s audio to Groq too, about $0.001 per debrief.",
    );
  });
});
