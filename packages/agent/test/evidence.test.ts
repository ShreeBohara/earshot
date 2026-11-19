import type { UtteranceFinalV2 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { evidenceFor, locateQuote } from "../src/evidence";
import { DEMO_UTTERANCES } from "../src/testing/scenarios";

function demo(index: number): UtteranceFinalV2 {
  const utterance = DEMO_UTTERANCES[index];
  if (!utterance) throw new Error(`no demo utterance ${index}`);
  return utterance;
}

const meeting = demo(0); // "Just got out of the meeting with Acme Corp. Met Dana Lee, their new VP of Operations."
const dealStage = demo(2); // no word timings
const task = demo(3); // "I need to send Dana the pricing breakdown by Thursday."

function utterance(text: string, extra: Partial<UtteranceFinalV2> = {}): UtteranceFinalV2 {
  return {
    utteranceId: "01a1c6e5-0000-7000-8000-000000000001",
    text,
    confidence: 0.9,
    startMs: 0,
    endMs: 1000,
    witness: "biased",
    ...extra,
  };
}

describe("locateQuote", () => {
  it("finds an exact quote and gives its [start, end) span", () => {
    const location = locateQuote("Dana Lee", [meeting]);
    expect(location).toMatchObject({ span: [48, 56], match: "exact" });
    expect(meeting.text.slice(48, 56)).toBe("Dana Lee");
  });

  it("ignores case and runs of whitespace, as the spec allows, and maps back to the original", () => {
    const location = locateQuote("  vp OF\n operations ", [meeting]);
    expect(location).toMatchObject({ span: [68, 84], match: "case_whitespace" });
    expect(meeting.text.slice(68, 84)).toBe("VP of Operations");
  });

  it("ignores punctuation at the edges of words, and straightens curly quotes", () => {
    const comma = locateQuote("Met Dana Lee their new VP", [meeting]);
    expect(comma?.match).toBe("word_edges");
    expect(meeting.text.slice(...(comma?.span ?? [0, 0]))).toBe("Met Dana Lee, their new VP");

    const pilot = demo(4); // "Overall the pilot's going well. ..."
    const curly = locateQuote("the pilot’s going well", [pilot]);
    expect(curly?.match).toBe("word_edges");
    expect(pilot.text.slice(...(curly?.span ?? [0, 0]))).toBe("the pilot's going well");
  });

  it("doesn't ignore punctuation inside a word, so a number can't match a different number", () => {
    expect(locateQuote("15 million", [utterance("They budgeted 1.5 million for it.")])).toBeNull();
    expect(locateQuote("1.5 million", [utterance("They budgeted 1.5 million for it.")])).not.toBe(
      null,
    );
  });

  it("returns null for a quote that isn't there, an empty quote, and one spanning utterances", () => {
    expect(locateQuote("Dana Smith", [meeting, task])).toBeNull();
    expect(locateQuote("", [meeting])).toBeNull();
    expect(locateQuote("   ", [meeting])).toBeNull();
    expect(locateQuote("Operations. I need", [meeting, task])).toBeNull();
  });

  it("prefers an exact match in a later utterance to a lenient one in an earlier utterance", () => {
    const first = utterance("send Dana THE pricing", {
      utteranceId: "01a1c6e5-0000-7000-8000-00000000000a",
    });
    const location = locateQuote("send Dana the pricing", [first, task]);
    expect(location?.utterance.utteranceId).toBe(task.utteranceId);
    expect(location?.match).toBe("exact");
  });
});

describe("evidenceFor", () => {
  it("maps the span to word timings and takes the lowest word confidence", () => {
    const location = locateQuote("Dana Lee", [meeting]);
    if (!location) throw new Error("not found");
    expect(evidenceFor(location)).toEqual({
      utteranceId: meeting.utteranceId,
      span: [48, 56],
      audioMs: [4420, 4960], // "Dana" 4420–4690, "Lee" 4750–4960
      confidence: 0.81, // Lee's 0.81, not the mean
    });
  });

  it("lines words up with the text when punctuation differs ('Corp' and 'Corp.')", () => {
    const location = locateQuote("Acme Corp.", [meeting]);
    if (!location) throw new Error("not found");
    expect(evidenceFor(location)).toMatchObject({ audioMs: [3410, 4020], confidence: 0.9 });
  });

  it("interpolates by character position when the utterance has no word timings", () => {
    const location = locateQuote("move the deal to the proposal stage", [dealStage]);
    if (!location) throw new Error("not found");
    const evidence = evidenceFor(location);
    expect(evidence.span).toEqual([58, 93]);
    // 13,500 ms + 6,100 ms × offset / 94 characters
    expect(evidence.audioMs).toEqual([17264, 19535]);
    expect(evidence.confidence).toBe(dealStage.confidence);
  });

  // The formatter wrote "$50k" where the provider heard "fifty thousand", with less confidence.
  // The utterance's own confidence (0.8) sits below the clean words and above the amount.
  const amount = utterance("They want $50k for it.", {
    confidence: 0.8,
    startMs: 1000,
    endMs: 3200,
    words: [
      { w: "They", startMs: 1000, endMs: 1200, confidence: 0.95 },
      { w: "want", startMs: 1250, endMs: 1500, confidence: 0.95 },
      { w: "fifty", startMs: 1550, endMs: 1900, confidence: 0.6 },
      { w: "thousand", startMs: 1950, endMs: 2400, confidence: 0.55 },
      { w: "for", startMs: 2500, endMs: 2700, confidence: 0.95 },
      { w: "it", startMs: 2750, endMs: 3000, confidence: 0.95 },
    ],
  });

  function evidenceOf(quote: string, utterances: readonly UtteranceFinalV2[]) {
    const location = locateQuote(quote, utterances);
    if (!location) throw new Error(`"${quote}" not found`);
    return evidenceFor(location);
  }

  it("covers the unmatched words of a partly lined-up quote, and their confidence (Codex's case)", () => {
    // "want" lines up; "$50k" doesn't. The window runs through "thousand", not just "want", and
    // the confidence is the amount's, low enough to flag.
    expect(evidenceOf("want $50k", [amount])).toMatchObject({
      span: [5, 14],
      audioMs: [1250, 2400],
      confidence: 0.55,
    });
    expect(evidenceOf("$50k", [amount])).toMatchObject({ audioMs: [1550, 2400], confidence: 0.55 });
  });

  it("still uses word timings, uncapped, when every word of the quote lines up", () => {
    // Full coverage: the words' own confidence, even above the utterance's 0.8.
    expect(evidenceOf("for it", [amount])).toMatchObject({
      audioMs: [2500, 3000],
      confidence: 0.95,
    });
  });

  it("caps a partial match at the utterance's confidence, so it can't raise it", () => {
    // "at" has no recognized word; "Dana" and "noon" do, at 0.99. The match is partial, so 0.8.
    const noon = utterance("Call Dana at noon.", {
      confidence: 0.8,
      startMs: 0,
      endMs: 1800,
      words: [
        { w: "Call", startMs: 0, endMs: 300, confidence: 0.99 },
        { w: "Dana", startMs: 400, endMs: 800, confidence: 0.99 },
        { w: "noon", startMs: 1200, endMs: 1700, confidence: 0.99 },
      ],
    });
    expect(evidenceOf("Dana at noon", [noon])).toMatchObject({
      audioMs: [400, 1700],
      confidence: 0.8,
    });
    // Nothing recognized to attribute "at" to: interpolation, with the utterance's confidence.
    expect(evidenceOf("at", [noon])).toEqual({
      utteranceId: noon.utteranceId,
      span: [10, 12],
      audioMs: [1000, 1200], // 1,800 ms × offset / 18 characters
      confidence: 0.8,
    });
  });
});
