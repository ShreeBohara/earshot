import {
  MAX_UTTERANCE_TEXT_CHARS,
  parseClientMessage,
  UtteranceFinalV2,
  uuidv7,
} from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  clampConfidence,
  fitUtterance,
  MAX_UTTERANCE_BYTES,
  toUtterances,
} from "../src/stt/normalize";
import { counterIds } from "./support/ids";

const offset = (baseOffsetMs: number) => (ms: number) => baseOffsetMs + ms;

describe("toUtterances", () => {
  it("puts words on the session's clock, averages confidence, and marks the biased witness", () => {
    const [utterance, ...rest] = toUtterances(
      [
        { text: "Acme", startMs: 120, endMs: 480, confidence: 0.9 },
        { text: "renewed", startMs: 500, endMs: 900, confidence: 0.7 },
      ],
      { toSessionMs: offset(10_000), text: "Acme renewed.", createId: counterIds() },
    );
    expect(rest).toEqual([]);
    expect(utterance).toEqual({
      utteranceId: "00000000-0000-7000-8000-000000000001",
      text: "Acme renewed.",
      confidence: 0.8,
      words: [
        { w: "Acme", startMs: 10_120, endMs: 10_480, confidence: 0.9 },
        { w: "renewed", startMs: 10_500, endMs: 10_900, confidence: 0.7 },
      ],
      startMs: 10_120,
      endMs: 10_900,
      witness: "biased",
    });
    expect(UtteranceFinalV2.parse(utterance)).toEqual(utterance);
  });

  it("joins the words when the provider gives no transcript", () => {
    const [utterance] = toUtterances(
      [
        { text: "hello", startMs: 0, endMs: 100, confidence: 1 },
        { text: "there", startMs: 100, endMs: 200, confidence: 1 },
      ],
      { toSessionMs: offset(0) },
    );
    expect(utterance?.text).toBe("hello there");
    expect(UtteranceFinalV2.safeParse(utterance).success).toBe(true);
  });

  it("rounds fractional ms, keeps times non-negative, and never ends a word before it starts", () => {
    const [utterance] = toUtterances([{ text: "x", startMs: -40.6, endMs: -50, confidence: 0.5 }], {
      toSessionMs: offset(12.4),
    });
    expect(utterance?.words).toEqual([{ w: "x", startMs: 0, endMs: 0, confidence: 0.5 }]);
  });

  it("skips empty words and gives nothing for an empty segment", () => {
    expect(
      toUtterances([{ text: "  ", startMs: 0, endMs: 1, confidence: 1 }], {
        toSessionMs: offset(0),
      }),
    ).toEqual([]);
    expect(toUtterances([], { toSessionMs: offset(0), text: "   " })).toEqual([]);
  });

  it("keeps a wordless segment, with its own times and confidence", () => {
    const [utterance] = toUtterances([], {
      toSessionMs: offset(1_000),
      text: "fine",
      startMs: 200,
      endMs: 700,
      confidence: 0.6,
    });
    expect(utterance).toMatchObject({
      text: "fine",
      startMs: 1_200,
      endMs: 1_700,
      confidence: 0.6,
    });
    expect(utterance?.words).toBeUndefined();
    expect(UtteranceFinalV2.safeParse(utterance).success).toBe(true);
  });

  it("splits text past the session socket's cap at word boundaries", () => {
    const words = Array.from({ length: 900 }, (_, i) => ({
      text: `word${i}`,
      startMs: i * 300,
      endMs: i * 300 + 250,
      confidence: 0.9,
    }));
    const utterances = toUtterances(words, { toSessionMs: offset(0) });
    expect(utterances.length).toBeGreaterThan(1);
    for (const utterance of utterances) {
      expect(utterance.text.length).toBeLessThanOrEqual(MAX_UTTERANCE_TEXT_CHARS);
      expect(utterance.text).toBe(utterance.words?.map((word) => word.w).join(" "));
      expect(UtteranceFinalV2.safeParse(utterance).success).toBe(true);
    }
    expect(utterances.flatMap((utterance) => utterance.words ?? [])).toHaveLength(900);
    expect(new Set(utterances.map((utterance) => utterance.utteranceId)).size).toBe(
      utterances.length,
    );
  });

  it("splits by serialized size too, so many word timings can't make a frame too large", () => {
    // 1,500 one-letter words: 2,999 characters of text, but about 90 KB of JSON with timings.
    const words = Array.from({ length: 1_500 }, (_, i) => ({
      text: "a",
      startMs: i * 100,
      endMs: i * 100 + 80,
      confidence: 0.9,
    }));
    const utterances = toUtterances(words, { toSessionMs: offset(0) });
    expect(utterances.length).toBeGreaterThan(1);
    for (const utterance of utterances) {
      const message = {
        t: "utterance",
        msgId: uuidv7(),
        turnId: "0000000a-0000-7000-8000-000000000001",
        utterance,
      };
      expect(new TextEncoder().encode(JSON.stringify(utterance)).byteLength).toBeLessThanOrEqual(
        MAX_UTTERANCE_BYTES,
      );
      expect(parseClientMessage(JSON.stringify(message)).ok).toBe(true);
    }
    expect(utterances.flatMap((utterance) => utterance.words ?? [])).toHaveLength(1_500);
  });

  it("leaves an utterance that already fits alone, provider text included", () => {
    const [one] = toUtterances([{ text: "Acme", startMs: 0, endMs: 300, confidence: 0.8 }], {
      toSessionMs: offset(0),
      text: "Acme.",
    });
    expect(one && fitUtterance(one)).toEqual([one]);
  });

  it("clamps confidence to [0, 1] and parses Flux's string confidences", () => {
    expect(clampConfidence("0.83")).toBe(0.83);
    expect(clampConfidence(1.4)).toBe(1);
    expect(clampConfidence(-2)).toBe(0);
    expect(clampConfidence("n/a")).toBe(0);
    expect(clampConfidence(undefined)).toBe(0);
  });
});
