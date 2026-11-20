// Prompt v2 (Phase 4 spec, WP8 step 2): no CRM list, one line for the open account, and the rules
// that make the model quote names as said and leave an unnamed record to the linker.
import type { UtteranceFinalV2 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { buildPrompt, describeCallTime } from "../src/prompt";
import { DEMO_CALL_TIME, DEMO_ENTITIES, DEMO_TIME_ZONE, DEMO_UTTERANCES } from "../src/testing";

const base = {
  utterances: DEMO_UTTERANCES.slice(0, 2),
  callTime: DEMO_CALL_TIME,
  timeZone: DEMO_TIME_ZONE,
};

describe("buildPrompt", () => {
  it("sends no CRM list, whatever records the session holds", () => {
    const { instructions } = buildPrompt({ ...base, openAccount: "Acme Corp" });
    for (const entity of DEMO_ENTITIES.filter((entity) => entity.name !== "Acme Corp")) {
      expect(instructions).not.toContain(entity.name);
    }
    expect(instructions).not.toMatch(/CRM records/);
  });

  it("names the open account on one line, and nothing when none is open", () => {
    expect(buildPrompt({ ...base, openAccount: "Acme Corp" }).instructions).toMatch(
      /\n\nOpen account: Acme Corp$/,
    );
    for (const openAccount of [undefined, null, "", "   "]) {
      expect(buildPrompt({ ...base, openAccount }).instructions).not.toContain("Open account");
    }
    // A line break in a CRM name can't add a line to the prompt.
    expect(buildPrompt({ ...base, openAccount: "Acme\n  Corp" }).instructions).toMatch(
      /Open account: Acme Corp$/,
    );
  });

  it("asks for names exactly as transcribed, and a null target when none was named", () => {
    const { instructions } = buildPrompt(base);
    expect(instructions).toContain("Quote names exactly as transcribed; never correct a spelling");
    expect(instructions).toContain(
      "If the rep doesn't name the record in this turn, set target to null.",
    );
    // Phase 3's rules stay: this turn only, negations kept, dates against the call time.
    expect(instructions).toContain("Use only this turn's transcript.");
    expect(instructions).toContain("Keep negations.");
    expect(instructions).toContain(
      `Call time: ${describeCallTime(DEMO_CALL_TIME, DEMO_TIME_ZONE)}`,
    );
  });

  it("puts one utterance on each line, line breaks inside one joined with a space", () => {
    const broken: UtteranceFinalV2 = {
      ...(DEMO_UTTERANCES[0] as UtteranceFinalV2),
      text: "Met Dana Lee  \n\r\n  at Acme Corp.\nShe runs   operations.",
    };
    const { transcript } = buildPrompt({ ...base, utterances: [broken] });
    expect(transcript).toContain("\nMet Dana Lee at Acme Corp. She runs   operations.\n");
    // A long run of spaces is cheap to read: no quadratic backtracking.
    const spaces: UtteranceFinalV2 = { ...broken, text: `a${" ".repeat(50_000)}b` };
    const started = performance.now();
    buildPrompt({ ...base, utterances: [spaces] });
    expect(performance.now() - started).toBeLessThan(200);
  });
});
