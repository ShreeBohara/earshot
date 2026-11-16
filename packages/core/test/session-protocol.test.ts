import { describe, expect, it } from "vitest";
import {
  ClientMessage,
  containsKeyShape,
  EntityRef,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  KEY_SHAPES,
  MAX_ENTITY_ALIASES,
  MAX_ENTITY_NAME_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_SESSION_ENTITIES,
  MAX_UTTERANCE_TEXT_CHARS,
  parseClientMessage,
  parseServerMessage,
  SESSION_PROTOCOL_VERSION,
  ServerMessage,
  SessionErrorCode,
  TURN_KEY_MAX_LENGTH,
  TURN_KEY_MIN_LENGTH,
  uuidv7,
} from "../src";

// Clearly fake, but shaped like real keys, so the shape check must catch them.
const FAKE_KEYS = {
  anthropic: `sk-ant-api03-${"x".repeat(40)}`,
  openai: `sk-proj-${"y".repeat(40)}`,
  groq: `gsk_${"Z".repeat(40)}`,
  google: `AIza${"0".repeat(35)}`,
} as const;

const SESSION_ID = "01a1c6e2-9320-7deb-a57a-ba62dc02df02";
const TURN_ID = "01a1c6e2-c1a0-7d2e-8f31-6b4a9c0d2e1f";
const UTTERANCE_ID = "01a1c6e2-af90-75b5-a79c-eb5ca2f0a104";

const entity = (n: number) => ({
  id: `6f1d2c3b-4a5e-4f60-8a7b-${n.toString(16).padStart(12, "0")}`,
  kind: "company",
  name: `Company ${n}`,
  aliases: [`Co ${n}`],
});

// One valid example of every client message. Each test copies what it changes.
function clientMessages() {
  return {
    hello: { t: "hello", protocol: 1, lastSeq: -1 },
    start: {
      t: "start",
      msgId: uuidv7(),
      mode: "debrief",
      engine: "cascaded",
      providers: {
        speechToText: { provider: "assemblyai", model: "universal-streaming-english" },
        llm: { provider: "anthropic", model: "claude-haiku-5-5" },
      },
      startedAt: "2026-11-15T19:15:00.000Z",
      entities: [{ ...entity(1), name: "Acme Corp", aliases: ["Acme"] }],
    },
    utterance: {
      t: "utterance",
      msgId: uuidv7(),
      turnId: TURN_ID,
      utterance: {
        utteranceId: UTTERANCE_ID,
        text: "Met Dana Lee at Acme.",
        confidence: 0.93,
        words: [{ w: "Met", startMs: 1200, endMs: 1400, confidence: 0.97 }],
        startMs: 1200,
        endMs: 2900,
        witness: "biased",
      },
    },
    turn_end: {
      t: "turn_end",
      msgId: uuidv7(),
      turnId: TURN_ID,
      trigger: "ptt_release",
      llm: { provider: "anthropic", model: "claude-haiku-5-5" },
      key: FAKE_KEYS.anthropic,
    },
    usage: {
      t: "usage",
      msgId: uuidv7(),
      provider: "assemblyai",
      model: "universal-streaming-english",
      audioMs: 4200,
      socketMs: 6100,
    },
    metric: {
      t: "metric",
      msgId: uuidv7(),
      turnId: TURN_ID,
      marks: {
        mode: "push_to_talk",
        speechEndMs: 10_512.4,
        finalMs: 11_150.9,
        proposalMs: 12_331,
        paintMs: 12_374.2,
      },
    },
    ack: { t: "ack", seq: 4 },
    end: { t: "end", msgId: uuidv7(), endedAt: "2026-11-15T19:15:40.000Z" },
  };
}

function serverMessages() {
  return {
    welcome: { t: "welcome", sessionId: SESSION_ID, lastSeq: -1, protocol: 1 },
    event: {
      t: "event",
      event: {
        id: uuidv7(),
        sessionId: SESSION_ID,
        seq: 3,
        type: "turn.completed",
        schemaVersion: 1,
        ts: "2026-11-15T19:15:09.120Z",
        payload: { turnId: TURN_ID, outcome: "nothing_to_propose", fields: { note: "Acme" } },
      },
    },
    ack: { t: "ack", msgId: uuidv7(), seq: 3 },
    ackWithoutSeq: { t: "ack", msgId: uuidv7() },
    working: { t: "working", turnId: TURN_ID, state: "retrying", retryInMs: 800 },
    error: { t: "error", code: "llm_key_rejected", retryable: false, msgId: uuidv7() },
  };
}

const frame = (message: unknown) => JSON.stringify(message);

describe("client messages", () => {
  it.each(Object.entries(clientMessages()))("accepts a valid %s", (_, message) => {
    expect(parseClientMessage(frame(message))).toEqual({ ok: true, message });
  });

  it("speaks protocol version 1", () => {
    expect(SESSION_PROTOCOL_VERSION).toBe(1);
    const { hello } = clientMessages();
    expect(parseClientMessage(frame({ ...hello, protocol: 2 }))).toMatchObject({ ok: false });
  });

  it("rejects an unknown t", () => {
    expect(parseClientMessage(frame({ t: "subscribe", msgId: uuidv7() }))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(parseClientMessage(frame({ lastSeq: -1, protocol: 1 }))).toMatchObject({
      reason: "invalid",
    });
  });

  it("rejects missing and extra fields, at every level", () => {
    const { hello, utterance, turn_end } = clientMessages();
    const { lastSeq: _, ...noLastSeq } = hello;
    expect(parseClientMessage(frame(noLastSeq))).toMatchObject({ reason: "invalid" });
    expect(parseClientMessage(frame({ ...hello, token: "abc" }))).toMatchObject({
      reason: "invalid",
    });
    const extraInUtterance = {
      ...utterance,
      utterance: { ...utterance.utterance, speaker: "rep" },
    };
    expect(parseClientMessage(frame(extraInUtterance))).toMatchObject({ reason: "invalid" });
    const extraInLlm = { ...turn_end, llm: { ...turn_end.llm, temperature: 0 } };
    expect(parseClientMessage(frame(extraInLlm))).toMatchObject({ reason: "invalid" });
  });

  it("requires a UUIDv7 msgId, so resends can be recognized", () => {
    const { end } = clientMessages();
    const v4 = "6f1d2c3b-4a5e-4f60-8a7b-9c8d7e6f5a4b";
    expect(parseClientMessage(frame({ ...end, msgId: v4 }))).toMatchObject({ reason: "invalid" });
  });

  it("takes -1 as the last seq of a client with no events, and nothing lower", () => {
    const { hello, ack } = clientMessages();
    expect(parseClientMessage(frame({ ...hello, lastSeq: 7 })).ok).toBe(true);
    expect(parseClientMessage(frame({ ...hello, lastSeq: -2 })).ok).toBe(false);
    expect(parseClientMessage(frame({ ...ack, seq: -1 })).ok).toBe(false);
    expect(parseClientMessage(frame({ ...ack, seq: 1.5 })).ok).toBe(false);
  });

  it("accepts only the Phase 3 engine and the two LLM providers", () => {
    const { start, turn_end } = clientMessages();
    expect(parseClientMessage(frame({ ...start, mode: "conversation" })).ok).toBe(false);
    expect(parseClientMessage(frame({ ...start, engine: "speech_to_speech" })).ok).toBe(false);
    const openai = { ...turn_end, llm: { provider: "openai", model: "gpt-6-luna" } };
    expect(parseClientMessage(frame(openai)).ok).toBe(false);
    const groq = { ...turn_end, llm: { provider: "groq", model: "openai/gpt-oss-20b" } };
    expect(parseClientMessage(frame({ ...groq, key: FAKE_KEYS.groq })).ok).toBe(true);
  });

  it("refuses negative or fractional usage and metric numbers", () => {
    const { usage, metric } = clientMessages();
    expect(parseClientMessage(frame({ ...usage, audioMs: -1 })).ok).toBe(false);
    expect(parseClientMessage(frame({ ...usage, socketMs: 1.5 })).ok).toBe(false);
    const badMark = { ...metric, marks: { ...metric.marks, paintMs: -0.5 } };
    expect(parseClientMessage(frame(badMark)).ok).toBe(false);
    const badMode = { ...metric, marks: { ...metric.marks, mode: "ptt" } };
    expect(parseClientMessage(frame(badMode)).ok).toBe(false);
  });
});

describe("size caps", () => {
  it("measures the cap in UTF-8 bytes, before parsing any JSON", () => {
    const { hello } = clientMessages();
    const json = frame(hello);
    // JSON allows trailing whitespace, so padding keeps the frame a valid message.
    const atCap = json + " ".repeat(MAX_MESSAGE_BYTES - json.length);
    expect(parseClientMessage(atCap)).toEqual({ ok: true, message: hello });
    expect(parseClientMessage(`${atCap} `)).toEqual({ ok: false, reason: "too_large" });

    // Under the cap in UTF-16 code units, over it in bytes; and not even JSON.
    expect(parseClientMessage("é".repeat(MAX_MESSAGE_BYTES / 2 + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(parseClientMessage("😀".repeat(MAX_MESSAGE_BYTES / 4 + 1))).toMatchObject({
      reason: "too_large",
    });
    expect(parseClientMessage("😀".repeat(MAX_MESSAGE_BYTES / 4))).toMatchObject({
      reason: "not_json",
    });
    expect(parseClientMessage("€".repeat(MAX_MESSAGE_BYTES / 3))).toMatchObject({
      reason: "not_json",
    });
    expect(parseClientMessage("€".repeat(MAX_MESSAGE_BYTES / 3 + 1))).toMatchObject({
      reason: "too_large",
    });
  });

  it("caps an utterance's text at 4,000 characters", () => {
    const { utterance } = clientMessages();
    const withText = (text: string) => ({
      ...utterance,
      utterance: { ...utterance.utterance, text },
    });
    expect(MAX_UTTERANCE_TEXT_CHARS).toBe(4000);
    expect(parseClientMessage(frame(withText("a".repeat(4000)))).ok).toBe(true);
    expect(parseClientMessage(frame(withText("a".repeat(4001))))).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("caps each entity's id, name, and aliases on the socket, not in the contract", () => {
    const { start } = clientMessages();
    const accepts = (overrides: Record<string, unknown>) =>
      parseClientMessage(frame({ ...start, entities: [{ ...entity(1), ...overrides }] })).ok;
    const aliases = (count: number) => Array.from({ length: count }, (_, i) => `Alias ${i}`);
    expect(accepts({ name: "n".repeat(MAX_ENTITY_NAME_CHARS) })).toBe(true);
    expect(accepts({ name: "n".repeat(MAX_ENTITY_NAME_CHARS + 1) })).toBe(false);
    expect(accepts({ aliases: aliases(MAX_ENTITY_ALIASES) })).toBe(true);
    expect(accepts({ aliases: aliases(MAX_ENTITY_ALIASES + 1) })).toBe(false);
    expect(accepts({ aliases: ["a".repeat(MAX_ENTITY_NAME_CHARS + 1)] })).toBe(false);
    expect(accepts({ id: "i".repeat(129) })).toBe(false);
    const long = { ...entity(1), name: "n".repeat(MAX_ENTITY_NAME_CHARS + 1) };
    expect(EntityRef.safeParse(long).success).toBe(true);
  });

  it("caps start at 250 entities", () => {
    const { start } = clientMessages();
    const entities = Array.from({ length: MAX_SESSION_ENTITIES + 1 }, (_, n) => entity(n));
    expect(parseClientMessage(frame({ ...start, entities: entities.slice(0, 250) })).ok).toBe(true);
    expect(parseClientMessage(frame({ ...start, entities }))).toMatchObject({ reason: "invalid" });
  });
});

describe("keys", () => {
  type Messages = ReturnType<typeof clientMessages>;
  // Every string field a client controls, outside turn_end.key.
  const placements: [string, (key: string, m: Messages) => unknown][] = [
    [
      "start.providers.llm.model",
      (key, { start }) => ({
        ...start,
        providers: { ...start.providers, llm: { provider: "anthropic", model: key } },
      }),
    ],
    [
      "start.entities[0].name",
      (key, { start }) => ({
        ...start,
        entities: [{ ...entity(1), name: `Acme ${key}` }],
      }),
    ],
    [
      "start.entities[0].aliases[0]",
      (key, { start }) => ({
        ...start,
        entities: [{ ...entity(1), aliases: [key] }],
      }),
    ],
    [
      "start.entities[0].id",
      (key, { start }) => ({ ...start, entities: [{ ...entity(1), id: key }] }),
    ],
    [
      "utterance.utterance.text",
      (key, { utterance }) => ({
        ...utterance,
        utterance: { ...utterance.utterance, text: `my key is ${key}, read it back` },
      }),
    ],
    [
      "utterance.utterance.words[0].w",
      (key, { utterance }) => ({
        ...utterance,
        utterance: {
          ...utterance.utterance,
          words: [{ w: key, startMs: 1200, endMs: 1400, confidence: 0.9 }],
        },
      }),
    ],
    [
      "turn_end.llm.model",
      (key, { turn_end }) => ({
        ...turn_end,
        llm: { provider: "anthropic", model: key },
      }),
    ],
    ["usage.provider", (key, { usage }) => ({ ...usage, provider: key })],
    ["usage.model", (key, { usage }) => ({ ...usage, model: key })],
  ];
  const cases = placements.flatMap(([where, place]) =>
    Object.entries(FAKE_KEYS).map(([shape, key]) => ({ where, shape, key, place })),
  );

  it.each(cases)("refuses a $shape-shaped key in $where", ({ key, place }) => {
    const message = place(key, clientMessages());
    expect(parseClientMessage(frame(message))).toEqual({ ok: false, reason: "stray_key" });
  });

  it("accepts a key in turn_end.key, the one place it belongs", () => {
    const { turn_end } = clientMessages();
    for (const key of Object.values(FAKE_KEYS)) {
      expect(parseClientMessage(frame({ ...turn_end, key })).ok).toBe(true);
    }
  });

  it("refuses the turn's own key anywhere else in turn_end, whatever its shape", () => {
    const { turn_end } = clientMessages();
    const unshaped = "0123456789abcdef0123456789abcdef"; // no known prefix, like a Deepgram key
    const message = { ...turn_end, key: unshaped, llm: { provider: "groq", model: unshaped } };
    expect(parseClientMessage(frame({ ...turn_end, key: unshaped })).ok).toBe(true);
    expect(parseClientMessage(frame(message))).toEqual({ ok: false, reason: "stray_key" });
  });

  it("points at the field, and never quotes the key in the issue", () => {
    const { utterance } = clientMessages();
    const key = FAKE_KEYS.openai;
    const message = { ...utterance, utterance: { ...utterance.utterance, text: key } };
    const result = ClientMessage.safeParse(message);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: "custom", path: ["utterance", "text"] }),
    ]);
    expect(JSON.stringify(result.error?.issues)).not.toContain(key);
  });

  it("returns only a reason, so a failure is safe to log", () => {
    const { start } = clientMessages();
    const result = parseClientMessage(frame({ ...start, [FAKE_KEYS.anthropic]: true }));
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("checks turn_end.key's length and characters, but not its prefix", () => {
    const { turn_end } = clientMessages();
    const withKey = (key: string) => parseClientMessage(frame({ ...turn_end, key })).ok;
    expect(withKey("k".repeat(TURN_KEY_MIN_LENGTH))).toBe(true);
    expect(withKey("k".repeat(TURN_KEY_MAX_LENGTH))).toBe(true);
    expect(withKey("k".repeat(TURN_KEY_MIN_LENGTH - 1))).toBe(false);
    expect(withKey("k".repeat(TURN_KEY_MAX_LENGTH + 1))).toBe(false);
    expect(withKey(`${FAKE_KEYS.groq} `)).toBe(false);
    expect(withKey(`${FAKE_KEYS.groq}\n`)).toBe(false);
    expect(withKey(`${FAKE_KEYS.groq}é`)).toBe(false);
    expect(withKey(`Bearer ${FAKE_KEYS.anthropic}`)).toBe(false);
  });

  it("doesn't mistake ordinary names for keys", () => {
    const { start } = clientMessages();
    const names = [
      "Risk-Management-Partners-International",
      "Whisk-Analytics-Corporation-Holdings",
      "Brisk_Logistics_and_Freight_Forwarding",
    ];
    const entities = names.map((name, n) => ({ ...entity(n), name }));
    expect(parseClientMessage(frame({ ...start, entities })).ok).toBe(true);
  });
});

describe("containsKeyShape", () => {
  it("finds each known shape alone, in a header, and in running text", () => {
    for (const key of Object.values(FAKE_KEYS)) {
      expect(containsKeyShape(key)).toBe(true);
      expect(containsKeyShape(`authorization: Bearer ${key}`)).toBe(true);
      expect(containsKeyShape(`{"apiKey":"${key}"}`)).toBe(true);
      expect(containsKeyShape(`key=${key}&x=1`)).toBe(true);
    }
  });

  it("passes ids, model names, and words that merely contain sk-", () => {
    for (const text of [
      uuidv7(),
      "claude-haiku-5-5",
      "openai/gpt-oss-20b",
      "universal-streaming-english",
      "ask-me-anything-about-the-renewal-date",
      "sk-short",
    ]) {
      expect(containsKeyShape(text)).toBe(false);
    }
  });

  it("uses stateless patterns", () => {
    for (const shape of KEY_SHAPES) expect(shape.flags).not.toContain("g");
    expect(containsKeyShape(FAKE_KEYS.groq)).toBe(true);
    expect(containsKeyShape(FAKE_KEYS.groq)).toBe(true);
  });
});

describe("server messages", () => {
  it.each(Object.entries(serverMessages()))("accepts a valid %s", (_, message) => {
    expect(parseServerMessage(frame(message))).toEqual({ ok: true, message });
  });

  it("rejects an unknown t and an unknown error code", () => {
    expect(parseServerMessage(frame({ t: "proposal", turnId: TURN_ID }))).toEqual({
      ok: false,
      reason: "invalid",
    });
    const { error } = serverMessages();
    expect(parseServerMessage(frame({ ...error, code: "oops" }))).toMatchObject({
      reason: "invalid",
    });
  });

  it("never carries a key: not in a value, and not in a property name", () => {
    const { event } = serverMessages();
    const inValue = {
      ...event,
      event: { ...event.event, payload: { note: `Dana read out ${FAKE_KEYS.anthropic}` } },
    };
    expect(parseServerMessage(frame(inValue))).toEqual({ ok: false, reason: "stray_key" });

    const inName = { ...event, event: { ...event.event, payload: { [FAKE_KEYS.google]: 1 } } };
    expect(parseServerMessage(frame(inName))).toEqual({ ok: false, reason: "stray_key" });
    const issues = ServerMessage.safeParse(inName).error?.issues;
    expect(issues).toEqual([expect.objectContaining({ path: ["event", "payload"] })]);
    expect(JSON.stringify(issues)).not.toContain(FAKE_KEYS.google);
  });

  it("has no size cap: an event can run a little longer than the message it echoes", () => {
    const { event } = serverMessages();
    const long = { ...event, event: { ...event.event, payload: { text: "a".repeat(70_000) } } };
    expect(parseServerMessage(frame(long)).ok).toBe(true);
  });

  it("walks deep payloads without overflowing the stack", () => {
    const { event } = serverMessages();
    let payload: Record<string, unknown> = { leaf: FAKE_KEYS.openai };
    for (let depth = 0; depth < 50_000; depth++) payload = { child: payload };
    const deep = { ...event, event: { ...event.event, payload } };
    const [issue] = ServerMessage.safeParse(deep).error?.issues ?? [];
    expect(issue).toMatchObject({ code: "custom" });
    expect(issue?.path).toHaveLength(50_000 + 3); // event, payload, 50,000 × child, leaf
  });
});

describe("frames that aren't messages", () => {
  it("refuses binary frames and anything that isn't JSON", () => {
    for (const parse of [parseClientMessage, parseServerMessage]) {
      expect(parse(new TextEncoder().encode('{"t":"ack","seq":1}'))).toEqual({
        ok: false,
        reason: "not_text",
      });
      expect(parse(new ArrayBuffer(8))).toMatchObject({ reason: "not_text" });
      expect(parse(undefined)).toMatchObject({ reason: "not_text" });
      expect(parse("{")).toEqual({ ok: false, reason: "not_json" });
      expect(parse("")).toMatchObject({ reason: "not_json" });
      expect(parse("[]")).toMatchObject({ reason: "invalid" });
      expect(parse("null")).toMatchObject({ reason: "invalid" });
    }
  });

  it("names the heartbeat frames, which the parsers leave to the caller", () => {
    expect([HEARTBEAT_PING, HEARTBEAT_PONG]).toEqual(["ping", "pong"]);
    expect(parseClientMessage(HEARTBEAT_PING)).toMatchObject({ reason: "not_json" });
    expect(parseServerMessage(HEARTBEAT_PONG)).toMatchObject({ reason: "not_json" });
  });

  it("has an error code for each kind of parse failure", () => {
    expect(SessionErrorCode.options).toEqual(expect.arrayContaining(["bad_message", "too_large"]));
  });
});
