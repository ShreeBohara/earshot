// The recap in the web app (Phase 5 spec WP10 step 8): the panel's view of a recap (its sentences
// by kind, each with the words its evidence points at; the lens's collapsed line; one line for each
// reason there's none), the words the inbox loads for it, and the device's lens setting.
import type { RecapCreatedV1, RecapReason } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { droppedLine, lensSummary, NO_RECAP_COPY } from "@/lib/recap/copy";
import { RECAP_LENS_KEY, readRecapLens, writeRecapLens } from "@/lib/recap/setting";
import { recapUtteranceIds, recapView, wordsFrom } from "@/lib/recap/view";

const U1 = "01A1C6E2-AF90-75B5-A79C-EB5CA2F0A104";
const U2 = "01a1c6e2-b3c0-7d11-8a2e-5f6a7b8c9d01";
const TEXTS = {
  [U1.toLowerCase()]: "Dana Lee wants two more plants.",
  [U2]: "I owe Dana a quote by Friday, and onboarding took too long.",
};
const evidence = (utteranceId: string, span: [number, number]) => ({
  utteranceId,
  span,
  audioMs: [0, 1_000] as [number, number],
  confidence: 0.9,
});

const RECAP: RecapCreatedV1 = {
  recapId: "01a1c6e9-2a10-7b3c-8d4e-5f6a7b8c9d01",
  outcome: "created",
  reason: null,
  llm: { provider: "groq", model: "openai/gpt-oss-20b" },
  sentences: [
    {
      kind: "headline",
      text: "Dana wants two more plants.",
      evidence: [evidence(U1, [0, 30])],
      weakSupport: false,
    },
    {
      kind: "next_step",
      text: "Send Dana a quote.",
      evidence: [evidence(U2, [2, 18]), evidence("01a1c6e2-0000-7000-8000-000000000000", [0, 4])],
      weakSupport: false,
    },
    {
      kind: "commitment",
      text: "She'll sign.",
      evidence: [evidence(U2, [19, 28])],
      weakSupport: true,
    },
  ],
  dropped: 2,
  lens: {
    id: "bant",
    fields: [
      { field: "budget", quote: null, evidence: null },
      { field: "authority", quote: null, evidence: null },
      { field: "need", quote: "onboarding took too long", evidence: evidence(U2, [34, 58]) },
      { field: "timeline", quote: "by Friday", evidence: evidence(U2, [19, 28]) },
    ],
  },
};

describe("recapView", () => {
  it("lays out the headline, next steps, and commitments, each with its words", () => {
    const view = recapView(RECAP, wordsFrom(TEXTS));
    if (view.kind !== "created") throw new Error("expected a recap");
    expect(view.headline).toMatchObject({ index: 0, text: "Dana wants two more plants." });
    // The id's case doesn't matter; words that aren't loaded are left out, not invented.
    expect(view.headline?.heard.map((heard) => heard.words)).toEqual([
      "Dana Lee wants two more plants",
    ]);
    expect(view.nextSteps.map((line) => line.heard.map((heard) => heard.words))).toEqual([
      ["owe Dana a quote"],
    ]);
    expect(view.commitments[0]).toMatchObject({ weakSupport: true, index: 2 });
    expect(view.dropped).toBe(droppedLine(2));
    expect(view.lens?.summary).toBe("BANT: 2 of 4 mentioned");
    expect(view.lens?.fields.map((field) => [field.label, field.words])).toEqual([
      ["Budget", null],
      ["Authority", null],
      ["Need", "onboarding took too long"],
      ["Timeline", "by Friday"],
    ]);
  });

  it("says why there's no recap, one line for each reason", () => {
    const reasons: RecapReason[] = [
      "no_key",
      "no_speech",
      "invalid_output",
      "rate_limited",
      "provider_error",
      "timeout",
    ];
    for (const reason of reasons) {
      const outcome = reason === "no_key" || reason === "no_speech" ? "skipped" : "failed";
      const view = recapView(
        { ...RECAP, outcome, reason, sentences: [], dropped: 0, lens: null },
        wordsFrom(TEXTS),
      );
      expect(view).toEqual({ kind: "none", line: NO_RECAP_COPY[reason] });
      expect(NO_RECAP_COPY[reason]).toMatch(/^No recap: /);
    }
  });

  it("names the words to load: every utterance its sentences and lens quote, once each", () => {
    expect(recapUtteranceIds(RECAP).sort()).toEqual(
      [U1.toLowerCase(), U2, "01a1c6e2-0000-7000-8000-000000000000"].sort(),
    );
  });

  it("writes the lens's line and the dropped line in plain words", () => {
    expect(lensSummary("MEDDIC", 2, 6)).toBe("MEDDIC: 2 of 6 mentioned");
    expect(droppedLine(1)).toBe(
      "1 sentence was left out: the words it quoted aren't in your transcript.",
    );
    expect(droppedLine(3)).toContain("3 sentences were left out");
  });
});

describe("the recap lens setting", () => {
  function storage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      values,
    };
  }

  it("is none until the device picks one, and reads only the three lenses", () => {
    expect(readRecapLens(storage())).toBeNull();
    expect(readRecapLens(storage({ [RECAP_LENS_KEY]: "spiced" }))).toBe("spiced");
    expect(readRecapLens(storage({ [RECAP_LENS_KEY]: "challenger" }))).toBeNull();
    expect(readRecapLens(null)).toBeNull();
  });

  it("records the choice, clears it for none, and tells the tab", () => {
    const store = storage();
    const events = new EventTarget();
    let told = 0;
    events.addEventListener("earshot:recap-lens", () => told++);
    writeRecapLens("meddic", { storage: store, events });
    expect(store.values.get(RECAP_LENS_KEY)).toBe("meddic");
    writeRecapLens(null, { storage: store, events });
    expect(store.values.has(RECAP_LENS_KEY)).toBe(false);
    expect(told).toBe(2);
  });
});
