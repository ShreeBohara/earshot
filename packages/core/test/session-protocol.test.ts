import { describe, expect, it } from "vitest";
import {
  ClientMessage,
  containsKeyShape,
  EntityRef,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  isIanaTimeZone,
  isSessionCloseCode,
  KEY_SHAPES,
  MAX_ENTITY_ALIASES,
  MAX_ENTITY_ID_CHARS,
  MAX_ENTITY_NAME_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_REVIEW_REQUEST_BYTES,
  MAX_REVIEW_REQUEST_ITEMS,
  MAX_REVIEWS_PER_MESSAGE,
  MAX_SESSION_ENTITIES,
  MAX_UTTERANCE_TEXT_CHARS,
  parseClientMessage,
  parseServerMessage,
  ReviewInput,
  ReviewRouteRequest,
  SESSION_CLOSE_CODES,
  SESSION_PROTOCOL_VERSION,
  ServerMessage,
  SessionErrorCode,
  sessionCloseFor,
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
  openaiEphemeral: `ek_${"68af296e".repeat(4)}`,
  jwt: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.${"Sg9".repeat(14)}x`,
} as const;

const SESSION_ID = "01a1c6e2-9320-7deb-a57a-ba62dc02df02";
const TURN_ID = "01a1c6e2-c1a0-7d2e-8f31-6b4a9c0d2e1f";
const UTTERANCE_ID = "01a1c6e2-af90-75b5-a79c-eb5ca2f0a104";
const UNBIASED_UTTERANCE_ID = "01a1c6f0-2b10-7c4e-9a3d-5e6f7a8b9c0d";
const PROPOSAL_ID = "01a1c6e2-b422-7d40-b863-98e9e102c114";
const REVIEW_ID = "01a1c6e4-0a10-7b2c-8d3e-4f5a6b7c8d01";
const SNOOZE_ID = "01a1c6e4-2c30-7d4e-8f5a-6b7c8d9e0f01";

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
    witness: {
      t: "witness",
      msgId: uuidv7(),
      turnId: TURN_ID,
      provider: "groq",
      model: "whisper-large-v3-turbo",
      outcome: "transcribed",
      utterance: {
        utteranceId: UNBIASED_UTTERANCE_ID,
        text: "Met Dana Li at Akme.",
        confidence: 0.81,
        words: [{ w: "Met", startMs: 1210, endMs: 1390, confidence: 0.9 }],
        startMs: 1210,
        endMs: 2880,
        witness: "unbiased",
      },
      latencyMs: 640,
    },
    ack: { t: "ack", seq: 4 },
    end: { t: "end", msgId: uuidv7(), endedAt: "2026-11-15T19:15:40.000Z" },
    review: {
      t: "review",
      msgId: uuidv7(),
      reviews: [
        {
          reviewId: REVIEW_ID,
          proposalId: PROPOSAL_ID,
          decision: "edited",
          target: { entityId: entity(1).id },
          editDiff: { title: { before: "VP of Operations", after: "VP Operations" } },
          mode: "single",
          batchId: null,
          policy: null,
          undoes: null,
          reason: null,
          seen: {
            tier: "loud",
            fields: {
              name: { proposed: "Dana Lee" },
              title: { proposed: "VP of Operations", base: "Director", current: "VP" },
            },
            target: { entityId: null, offered: [entity(1).id, entity(2).id, null] },
            relinked: null,
            clip: "played",
          },
          timing: { decisionMs: 2_100, handlingMs: 9_400 },
          input: "keyboard",
          surface: "tray",
        },
      ],
    },
    snooze: {
      t: "snooze",
      msgId: uuidv7(),
      snoozeId: SNOOZE_ID,
      proposalId: PROPOSAL_ID,
      until: "2026-11-16T14:00:00.000Z",
    },
  };
}

type ReviewItem = ReturnType<typeof clientMessages>["review"]["reviews"][number];

/** A `review` message whose one review is the example's, changed by `overrides`. */
function reviewWith(overrides: Record<string, unknown>) {
  const { review } = clientMessages();
  const [item] = review.reviews;
  return { ...review, reviews: [{ ...item, ...overrides }] };
}

/** The example review's `seen`, changed by `overrides`. */
function seenWith(overrides: Record<string, unknown>) {
  const [item] = clientMessages().review.reviews;
  return { ...(item as ReviewItem).seen, ...overrides };
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

  it("takes an optional IANA time zone in start, and nothing else there", () => {
    const { start } = clientMessages();
    for (const timeZone of ["America/Chicago", "Europe/London", "Asia/Kolkata", "UTC"]) {
      expect(parseClientMessage(frame({ ...start, timeZone })).ok).toBe(true);
    }
    for (const timeZone of ["Mars/Olympus_Mons", "", "America/Chicago; drop", "x".repeat(65)]) {
      expect(parseClientMessage(frame({ ...start, timeZone }))).toMatchObject({
        reason: "invalid",
      });
    }
    expect(isIanaTimeZone("America/Chicago")).toBe(true);
    expect(isIanaTimeZone("../etc/passwd")).toBe(false);
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
    [
      "start.entities[0].parentId",
      (key, { start }) => ({ ...start, entities: [{ ...entity(1), parentId: key }] }),
    ],
    // Not one of the entities either, but the key is what the parse reports.
    ["start.focusEntityId", (key, { start }) => ({ ...start, focusEntityId: key })],
    [
      "witness.utterance.text",
      (key, { witness }) => ({
        ...witness,
        utterance: { ...witness.utterance, text: `the key was ${key}` },
      }),
    ],
    [
      "witness.utterance.words[0].w",
      (key, { witness }) => ({
        ...witness,
        utterance: {
          ...witness.utterance,
          words: [{ w: key, startMs: 1210, endMs: 1390, confidence: 0.9 }],
        },
      }),
    ],
    ["witness.provider", (key, { witness }) => ({ ...witness, provider: key })],
    ["witness.model", (key, { witness }) => ({ ...witness, model: key })],
    ["review.reviews[0].target.entityId", (key) => reviewWith({ target: { entityId: key } })],
    [
      "review.reviews[0].editDiff.title.after",
      (key) => reviewWith({ editDiff: { title: { before: "VP of Operations", after: key } } }),
    ],
    [
      "review.reviews[0].editDiff.title.before",
      (key) => reviewWith({ editDiff: { title: { before: `pasted ${key}`, after: "VP" } } }),
    ],
    [
      "review.reviews[0].seen.fields.name.proposed",
      (key) => reviewWith({ seen: seenWith({ fields: { name: { proposed: key } } }) }),
    ],
    [
      "review.reviews[0].seen.fields.title.base",
      (key) => reviewWith({ seen: seenWith({ fields: { title: { proposed: "VP", base: key } } }) }),
    ],
    [
      "review.reviews[0].seen.fields.title.current",
      (key) =>
        reviewWith({ seen: seenWith({ fields: { title: { proposed: "VP", current: key } } }) }),
    ],
    [
      "review.reviews[0].seen.target.entityId",
      (key) => reviewWith({ seen: seenWith({ target: { entityId: key, offered: [] } }) }),
    ],
    [
      "review.reviews[0].seen.target.offered[1]",
      (key) => reviewWith({ seen: seenWith({ target: { entityId: null, offered: [null, key] } }) }),
    ],
    ["review.reviews[0].seen.relinked", (key) => reviewWith({ seen: seenWith({ relinked: key }) })],
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

  it("refuses a key as a field name in a review, where field names can't hold one", () => {
    for (const key of Object.values(FAKE_KEYS)) {
      const inDiff = reviewWith({ editDiff: { [key]: { before: null, after: "x" } } });
      expect(parseClientMessage(frame(inDiff))).toMatchObject({ ok: false });
      const inSeen = reviewWith({ seen: seenWith({ fields: { [key]: { proposed: "x" } } }) });
      expect(parseClientMessage(frame(inSeen))).toMatchObject({ ok: false });
    }
  });

  it("keeps the guard on ReviewInput, for the web route that parses it on its own", () => {
    const [item] = clientMessages().review.reviews;
    const key = FAKE_KEYS.anthropic;
    const result = ReviewInput.safeParse({ ...item, target: { entityId: key } });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        code: "custom",
        path: ["target", "entityId"],
        params: { reason: "stray_key" },
      }),
    ]);
    expect(JSON.stringify(result.error?.issues)).not.toContain(key);
    expect(ReviewInput.safeParse(item).success).toBe(true);
  });

  it("guards the review route's body the same way, and caps it at 25 items in all", () => {
    const [item] = clientMessages().review.reviews;
    const snooze = {
      snoozeId: uuidv7(),
      proposalId: item?.proposalId ?? "",
      until: "2026-11-21T09:00:00.000Z",
    };
    expect(ReviewRouteRequest.safeParse({ reviews: [item], snoozes: [snooze] }).success).toBe(true);
    expect(ReviewRouteRequest.parse({ snoozes: [snooze] }).reviews).toEqual([]);
    for (const bad of [
      {},
      { reviews: [], snoozes: [] },
      {
        reviews: Array.from({ length: 13 }, () => item),
        snoozes: Array.from({ length: 13 }, () => snooze),
      },
      { reviews: [item], extra: 1 },
      { reviews: [{ ...item, target: { entityId: FAKE_KEYS.groq } }] },
      { snoozes: [{ ...snooze, [FAKE_KEYS.anthropic]: 1 }] },
    ]) {
      expect(ReviewRouteRequest.safeParse(bad).success).toBe(false);
    }
    expect(MAX_REVIEW_REQUEST_ITEMS).toBe(MAX_REVIEWS_PER_MESSAGE);
    expect(MAX_REVIEW_REQUEST_BYTES).toBe(MAX_MESSAGE_BYTES);
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

describe("Phase 4: the open account, parent records, and the second witness", () => {
  const withEntities = (overrides: Record<string, unknown> = {}) => {
    const { start } = clientMessages();
    return {
      ...start,
      entities: [
        { ...entity(1), name: "Acme Dynamics", aliases: ["Acme"] },
        { ...entity(2), kind: "contact", name: "Dana Lee", aliases: [], parentId: entity(1).id },
        { ...entity(3), kind: "deal", name: "Acme renewal", aliases: [], parentId: entity(1).id },
      ],
      ...overrides,
    };
  };

  it("takes each record's parent and the open account in start", () => {
    const start = withEntities({ focusEntityId: entity(1).id });
    expect(parseClientMessage(frame(start))).toEqual({ ok: true, message: start });
    expect(parseClientMessage(frame(withEntities())).ok).toBe(true);
  });

  it("refuses an open account that isn't one of start's entities", () => {
    const outside = withEntities({ focusEntityId: entity(9).id });
    expect(parseClientMessage(frame(outside))).toEqual({ ok: false, reason: "invalid" });
    const issues = ClientMessage.safeParse(outside).error?.issues;
    expect(issues).toEqual([expect.objectContaining({ path: ["focusEntityId"] })]);
    const noEntities = { ...clientMessages().start, entities: [], focusEntityId: entity(1).id };
    expect(parseClientMessage(frame(noEntities))).toMatchObject({ reason: "invalid" });
  });

  it("caps parent and focus ids at the entity id's length, and refuses empty ones", () => {
    expect(MAX_ENTITY_ID_CHARS).toBe(128);
    const { start } = clientMessages();
    const withParent = (parentId: string) =>
      parseClientMessage(frame({ ...start, entities: [{ ...entity(1), parentId }] })).ok;
    expect(withParent("p".repeat(MAX_ENTITY_ID_CHARS))).toBe(true);
    expect(withParent("p".repeat(MAX_ENTITY_ID_CHARS + 1))).toBe(false);
    expect(withParent("")).toBe(false);
    const longId = "i".repeat(MAX_ENTITY_ID_CHARS + 1);
    const longFocus = { ...start, entities: [{ ...entity(1), id: longId }], focusEntityId: longId };
    expect(parseClientMessage(frame(longFocus)).ok).toBe(false);
    expect(parseClientMessage(frame({ ...start, focusEntityId: "" })).ok).toBe(false);
    // The contract itself takes any non-empty parent id, as it takes any length of name.
    const contact = { ...entity(2), kind: "contact", parentId: "p".repeat(500) };
    expect(EntityRef.safeParse(contact).success).toBe(true);
    expect(EntityRef.safeParse({ ...contact, parentId: "" }).success).toBe(false);
  });

  it("accepts a witness that failed or was skipped, with its reason and no utterance", () => {
    const { witness } = clientMessages();
    const { utterance: _, ...base } = witness;
    for (const [outcome, reason] of [
      ["failed", "timeout"],
      ["failed", "rate_limited"],
      ["failed", "provider_error"],
      ["skipped", "off"],
      ["skipped", "no_key"],
      ["skipped", "too_long"],
    ] as const) {
      const message = { ...base, outcome, reason };
      expect(parseClientMessage(frame(message))).toEqual({ ok: true, message });
    }
    const { latencyMs: __, ...noLatency } = { ...base, outcome: "skipped", reason: "off" };
    expect(parseClientMessage(frame(noLatency)).ok).toBe(true);
  });

  it("refuses a witness utterance labelled biased, or with no witness", () => {
    const { witness } = clientMessages();
    const labelled = (label: unknown) => ({
      ...witness,
      utterance: { ...witness.utterance, witness: label },
    });
    expect(parseClientMessage(frame(labelled("biased")))).toEqual({
      ok: false,
      reason: "invalid",
    });
    const { witness: _, ...unlabelled } = witness.utterance;
    expect(parseClientMessage(frame({ ...witness, utterance: unlabelled })).ok).toBe(false);
  });

  it("ties the utterance to a transcribed witness, and the reason to the others", () => {
    const { witness } = clientMessages();
    const { utterance, ...base } = witness;
    const refused = [
      base, // transcribed, with no utterance
      { ...witness, reason: "timeout" }, // transcribed, with a reason
      { ...base, outcome: "failed" }, // failed, with no reason
      { ...witness, outcome: "failed", reason: "timeout" }, // failed, with an utterance
      { ...base, outcome: "skipped", reason: "cancelled" }, // not a reason
      { ...base, outcome: "compared", reason: "off" }, // the event's word, not the message's
    ];
    for (const message of refused) {
      expect(parseClientMessage(frame(message))).toEqual({ ok: false, reason: "invalid" });
    }
    expect(utterance.witness).toBe("unbiased");
  });

  it("checks the witness's turn, names, and latency", () => {
    const { witness } = clientMessages();
    const accepts = (overrides: Record<string, unknown>) =>
      parseClientMessage(frame({ ...witness, ...overrides })).ok;
    expect(accepts({ turnId: "turn-1" })).toBe(false);
    expect(accepts({ msgId: "6f1d2c3b-4a5e-4f60-8a7b-9c8d7e6f5a4b" })).toBe(false);
    expect(accepts({ provider: "" })).toBe(false);
    expect(accepts({ model: "m".repeat(129) })).toBe(false);
    expect(accepts({ latencyMs: -1 })).toBe(false);
    expect(accepts({ latencyMs: 640.5 })).toBe(false);
    expect(accepts({ latencyMs: 0 })).toBe(true);
    expect(accepts({ audio: "UklGRg==" })).toBe(false);
  });

  it("caps the witness's text like any utterance, and its frame like any message", () => {
    const { witness } = clientMessages();
    const withText = (text: string) => ({ ...witness, utterance: { ...witness.utterance, text } });
    expect(parseClientMessage(frame(withText("a".repeat(MAX_UTTERANCE_TEXT_CHARS)))).ok).toBe(true);
    expect(parseClientMessage(frame(withText("a".repeat(MAX_UTTERANCE_TEXT_CHARS + 1))))).toEqual({
      ok: false,
      reason: "invalid",
    });
    // Word timings have no count cap of their own; the frame's 64 KiB holds them.
    const words = Array.from({ length: 1_200 }, (_, i) => ({
      w: "word",
      startMs: 1210 + i * 10,
      endMs: 1215 + i * 10,
      confidence: 0.9,
    }));
    const long = { ...witness, utterance: { ...witness.utterance, words } };
    expect(frame(long).length).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(parseClientMessage(frame(long))).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("Phase 5: reviews, snoozes, and the seal", () => {
  const item = clientMessages().review.reviews[0] as ReviewItem;
  const accepts = (message: unknown) => parseClientMessage(frame(message)).ok;

  it("takes 1 to 25 reviews in a message", () => {
    expect(MAX_REVIEWS_PER_MESSAGE).toBe(25);
    const { review } = clientMessages();
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...item,
        reviewId: `01a1c6e4-0a10-7b2c-8d3e-${i.toString(16).padStart(12, "0")}`,
        mode: "batch",
        batchId: "01a1c6e4-1b20-7c3d-9e4f-5a6b7c8d9e01",
      }));
    expect(accepts({ ...review, reviews: many(25) })).toBe(true);
    expect(parseClientMessage(frame({ ...review, reviews: many(26) }))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(accepts({ ...review, reviews: [] })).toBe(false);
  });

  it("takes only a person's modes: no policy, no system review, and reopens only to undo", () => {
    expect(accepts(reviewWith({ mode: "batch", batchId: SNOOZE_ID }))).toBe(true);
    expect(accepts(reviewWith({ mode: "policy" }))).toBe(false);
    expect(accepts(reviewWith({ mode: "system" }))).toBe(false);
    const policy = { id: SNOOZE_ID, version: 1, rule: "notes" };
    expect(accepts(reviewWith({ policy }))).toBe(false);
    const undo = { decision: "reopened", target: null, undoes: REVIEW_ID, editDiff: undefined };
    expect(accepts(reviewWith({ ...undo, reason: "undo" }))).toBe(true);
    expect(accepts(reviewWith({ ...undo, reason: "flagged" }))).toBe(false);
  });

  it("leaves who reviewed, and when it may sync, to the writer", () => {
    const by = { userId: "u_9fK2mQx7Lr", auth: null };
    expect(accepts(reviewWith({ by }))).toBe(false);
    expect(accepts(reviewWith({ syncEligibleAt: "2026-11-15T19:16:10.000Z" }))).toBe(false);
  });

  it("caps record ids like start's, and offers at most four records", () => {
    const at = (length: number) => "r".repeat(length);
    expect(MAX_ENTITY_ID_CHARS).toBe(128);
    expect(accepts(reviewWith({ target: { entityId: at(128) } }))).toBe(true);
    expect(accepts(reviewWith({ target: { entityId: at(129) } }))).toBe(false);
    expect(accepts(reviewWith({ target: { entityId: "" } }))).toBe(false);
    const target = (entityId: string | null, offered: (string | null)[]) =>
      reviewWith({ seen: seenWith({ target: { entityId, offered } }) });
    expect(accepts(target(at(129), []))).toBe(false);
    expect(accepts(target(null, [at(129)]))).toBe(false);
    expect(accepts(target(null, [null, "a", "b", "c"]))).toBe(true);
    expect(accepts(target(null, [null, "a", "b", "c", "d"]))).toBe(false);
    expect(accepts(reviewWith({ seen: seenWith({ relinked: at(128) }) }))).toBe(true);
    expect(accepts(reviewWith({ seen: seenWith({ relinked: at(129) }) }))).toBe(false);
  });

  it("refuses missing and extra fields at every level of a review", () => {
    const { reviewId: _, ...noId } = item;
    expect(accepts({ ...clientMessages().review, reviews: [noId] })).toBe(false);
    expect(accepts(reviewWith({ reviewerMs: 2_400 }))).toBe(false);
    expect(accepts(reviewWith({ seen: seenWith({ note: "checked" }) }))).toBe(false);
    expect(accepts(reviewWith({ timing: { decisionMs: 1, handlingMs: 2, idleMs: 3 } }))).toBe(
      false,
    );
    expect(accepts(reviewWith({ timing: { decisionMs: 1.5, handlingMs: 2 } }))).toBe(false);
    expect(accepts(reviewWith({ target: { entityId: null, p: 0.4 } }))).toBe(false);
    const seenField = { proposed: "Dana", previous: "Dana Li" };
    expect(accepts(reviewWith({ seen: seenWith({ fields: { name: seenField } }) }))).toBe(false);
    expect(accepts(reviewWith({ seen: seenWith({ tier: "medium" }) }))).toBe(false);
    expect(accepts(reviewWith({ input: "mouse" }))).toBe(false);
    expect(accepts(reviewWith({ surface: "session" }))).toBe(true); // checkReview refuses it
    expect(accepts({ ...clientMessages().review, extra: true })).toBe(false);
  });

  it("takes a snooze until a time, or a wake, and leaves the reviewer to the writer", () => {
    const { snooze } = clientMessages();
    expect(accepts({ ...snooze, until: null })).toBe(true);
    expect(accepts({ ...snooze, until: "2026-11-16T09:00:00-05:00" })).toBe(true);
    expect(accepts({ ...snooze, until: "2026-11-16T14:00:00" })).toBe(false);
    expect(accepts({ ...snooze, until: "tomorrow" })).toBe(false);
    expect(accepts({ ...snooze, by: { userId: "u_9fK2mQx7Lr", auth: null } })).toBe(false);
    expect(accepts({ ...snooze, snoozeId: "snooze-1" })).toBe(false);
    const { until: _, ...noUntil } = snooze;
    expect(accepts(noUntil)).toBe(false);
  });

  it("adds sealed to the error codes, which the server may send", () => {
    expect(SessionErrorCode.options).toContain("sealed");
    const sealed = { t: "error", code: "sealed", retryable: false, msgId: uuidv7() };
    expect(parseServerMessage(frame(sealed))).toEqual({ ok: true, message: sealed });
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

describe("close codes", () => {
  const closes = Object.entries(SESSION_CLOSE_CODES);

  it("are unique, in 4000–4099, with reasons WebSocket close() takes (at most 123 bytes)", () => {
    for (const [name, { code, reason }] of closes) {
      expect(Number.isInteger(code), name).toBe(true);
      expect(code, name).toBeGreaterThanOrEqual(4000);
      expect(code, name).toBeLessThanOrEqual(4099);
      expect(reason.length, name).toBeGreaterThan(0);
      expect(new TextEncoder().encode(reason).byteLength, name).toBeLessThanOrEqual(123);
    }
    const codes = closes.map(([, close]) => close.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("cover tickets, the session's end, takeovers, versions, limits, errors, and redeploys", () => {
    expect(Object.keys(SESSION_CLOSE_CODES).sort()).toEqual([
      "forbidden",
      "going_away",
      "internal_error",
      "rate_limited",
      "replaced",
      "session_ended",
      "ticket_refused",
      "ticket_reused",
      "unsupported_protocol",
    ]);
  });

  it("mark the final ones; the client reconnects after the rest", () => {
    const final = closes.filter(([, close]) => !close.reconnect).map(([name]) => name);
    expect(final.sort()).toEqual([
      "forbidden",
      "replaced",
      "session_ended",
      "unsupported_protocol",
    ]);
  });

  it("give 4000 to going away, which the end-to-end test's forced drop uses to make a reconnect", () => {
    expect(SESSION_CLOSE_CODES.going_away).toEqual({
      code: 4000,
      reason: "server going away",
      reconnect: true,
    });
  });

  it("are frozen, entry by entry", () => {
    expect(Object.isFrozen(SESSION_CLOSE_CODES)).toBe(true);
    for (const [, close] of closes) expect(Object.isFrozen(close)).toBe(true);
  });

  it("are recognized and looked up by code, and nothing else is", () => {
    for (const [name, close] of closes) {
      expect(isSessionCloseCode(close.code)).toBe(true);
      expect(sessionCloseFor(close.code)).toEqual({ name, ...close });
    }
    for (const other of [1000, 1001, 1006, 3999, 4099, 4100]) {
      expect(isSessionCloseCode(other)).toBe(false);
      expect(sessionCloseFor(other)).toBeUndefined();
    }
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
