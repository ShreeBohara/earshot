import { readdirSync, readFileSync } from "node:fs";
import { matchEntity, TARGET_KINDS } from "@earshot/agent";
import { ProposalType } from "@earshot/core";
import { contacts } from "@earshot/demo-crm";
import { describe, expect, it } from "vitest";
import {
  CORRECTION_MARKER,
  COVERAGE_MINIMUMS,
  coverageOf,
  DEBRIEF_FILES,
  DEBRIEFS,
  DEMO_SESSION_ENTITIES,
  DebriefScript,
  demoEntity,
  ExpectedProposal,
  expectedFields,
  KEY_FIELDS,
  localDate,
  NEGATION_PATTERN,
  parseUsd,
  resolveDatePhrase,
} from "../src";

const DIRECTORY = new URL("../debriefs/", import.meta.url);
const EXPECTED_IDS = Array.from({ length: 30 }, (_, i) => `d${String(i + 1).padStart(3, "0")}`);

/** Every expected proposal, with the script and turn it belongs to. */
const PROPOSALS = DEBRIEFS.flatMap((script) =>
  script.turns.flatMap((turn, turnIndex) =>
    turn.expect.map((proposal) => ({ script, turn, turnIndex, proposal })),
  ),
);
const label = (entry: (typeof PROPOSALS)[number]) =>
  `${entry.script.id} turn ${entry.turnIndex + 1} ${entry.proposal.type}`;

describe("the debrief files", () => {
  it("are d001 to d030, and src/debriefs.ts loads every one", () => {
    const files = readdirSync(DIRECTORY)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
    expect(files).toEqual(EXPECTED_IDS);
    expect([...DEBRIEF_FILES].sort()).toEqual(EXPECTED_IDS);
    expect(DEBRIEFS.map((script) => script.id)).toEqual(EXPECTED_IDS);
  });

  it.each(EXPECTED_IDS)("%s.json is a valid script as it sits on disk", (id) => {
    const raw = JSON.parse(readFileSync(new URL(`${id}.json`, DIRECTORY), "utf8"));
    expect(DebriefScript.parse(raw).id).toBe(id);
  });
});

describe("the script schema", () => {
  const base = DEBRIEFS[0] as DebriefScript;
  const withTurns = (turns: unknown[]) => ({ ...base, turns });
  const turn = (overrides: Record<string, unknown> = {}) => ({
    pauseBeforeMs: 1_500,
    text: "Send Dana Lee the quote.",
    expect: [],
    ...overrides,
  });
  const rejects = (value: unknown) => expect(DebriefScript.safeParse(value).success).toBe(false);

  it("accepts a minimal script", () => {
    expect(DebriefScript.safeParse(withTurns([turn(), turn()])).success).toBe(true);
  });

  it("takes 2 to 5 turns", () => {
    rejects(withTurns([turn()]));
    rejects(withTurns(Array.from({ length: 6 }, () => turn())));
  });

  it("holds pauses to 800–5,000 ms and the lead-in to at least 1,000 ms", () => {
    rejects(withTurns([turn(), turn({ pauseBeforeMs: 799 })]));
    rejects(withTurns([turn(), turn({ pauseBeforeMs: 5_001 })]));
    rejects(withTurns([turn({ pauseBeforeMs: 900 }), turn()]));
  });

  it("wants text as the fake adapter emits it, and a known voice, zone, and tag", () => {
    rejects(withTurns([turn({ text: "Two  spaces." }), turn()]));
    rejects(withTurns([turn({ text: " Leading space." }), turn()]));
    rejects(withTurns([turn({ text: "Line\nbreak." }), turn()]));
    rejects({ ...withTurns([turn(), turn()]), voice: "af_unknown" });
    rejects({ ...withTurns([turn(), turn()]), timeZone: "Mars/Olympus_Mons" });
    rejects(withTurns([turn({ tags: ["sarcasm"] }), turn()]));
    rejects({ ...withTurns([turn(), turn()]), extra: true });
  });

  it("checks each proposal type's fields, target ids, dates, and amounts", () => {
    const note = { type: "note", target: "co_011", fields: { body: { value: "x", quote: "x" } } };
    expect(ExpectedProposal.safeParse(note).success).toBe(true);
    const bad = (value: unknown) => expect(ExpectedProposal.safeParse(value).success).toBe(false);
    bad({ ...note, target: "acme" });
    bad({
      ...note,
      fields: { body: { value: "x", quote: "x" }, extra: { value: "y", quote: "y" } },
    });
    bad({ ...note, fields: { body: { value: "x" } } });
    bad({ type: "deal_update", target: "deal_028", fields: {} });
    bad({
      type: "deal_update",
      target: "deal_028",
      fields: { amount: { value: 1.5, quote: "one and a half" } },
    });
    bad({
      type: "task",
      target: null,
      fields: { title: { value: "x", quote: "x" }, dueDate: { value: "Friday", quote: "Friday" } },
    });
  });

  it("covers every proposal type, and keys only fields each type has", () => {
    const types = ExpectedProposal.options.map((option) => option.shape.type.value);
    expect(types.sort()).toEqual([...ProposalType.options].sort());
    expect(Object.keys(KEY_FIELDS).sort()).toEqual([...ProposalType.options].sort());
    for (const option of ExpectedProposal.options) {
      const type = option.shape.type.value;
      const fields = Object.keys(option.shape.fields.shape);
      for (const key of KEY_FIELDS[type]) expect(fields).toContain(key);
    }
  });
});

describe("the ground truth", () => {
  it("quotes every field from its own turn, word for word", () => {
    for (const entry of PROPOSALS) {
      for (const [name, field] of expectedFields(entry.proposal)) {
        expect(entry.turn.text, `${label(entry)} ${name}`).toContain(field.quote);
        expect(field.quote, `${label(entry)} ${name}`).toBe(field.quote.trim());
      }
    }
  });

  it("targets demo CRM records of a kind the proposal type allows, by their exact names", () => {
    for (const entry of PROPOSALS) {
      const { proposal } = entry;
      if (proposal.target === null) continue;
      const entity = demoEntity(proposal.target);
      expect(TARGET_KINDS[proposal.type], label(entry)).toContain(entity.kind);
      expect(
        matchEntity(entity.name, DEMO_SESSION_ENTITIES, TARGET_KINDS[proposal.type])?.id,
        label(entry),
      ).toBe(proposal.target);
    }
  });

  it("gives new contacts names no demo contact has, and contact updates the contact's name", () => {
    const names = new Set(contacts.map((c) => `${c.firstName} ${c.lastName}`.toLowerCase()));
    for (const entry of PROPOSALS) {
      const { proposal } = entry;
      if (proposal.type !== "contact") continue;
      if (proposal.target === null) {
        expect(names.has(proposal.fields.name.value.toLowerCase()), label(entry)).toBe(false);
      } else {
        expect(proposal.fields.name.value, label(entry)).toBe(demoEntity(proposal.target).name);
      }
    }
  });

  it("resolves every date from its quote and the script's call time", () => {
    for (const entry of PROPOSALS) {
      for (const [name, field] of expectedFields(entry.proposal)) {
        if (name !== "dueDate" && name !== "closeDate") continue;
        const resolved = resolveDatePhrase(
          field.quote,
          entry.script.callTime,
          entry.script.timeZone,
        );
        expect(resolved?.date, `${label(entry)} ${name} "${field.quote}"`).toBe(field.value);
      }
    }
  });

  it("reads every amount from its quote", () => {
    for (const entry of PROPOSALS) {
      for (const [name, field] of expectedFields(entry.proposal)) {
        if (name !== "amount") continue;
        expect(parseUsd(field.quote), `${label(entry)} "${field.quote}"`).toBe(field.value);
      }
    }
  });

  it("backs every tag with the text: a negation word, or a correction before a quote", () => {
    for (const script of DEBRIEFS) {
      script.turns.forEach((turn, index) => {
        const where = `${script.id} turn ${index + 1}`;
        if (turn.tags?.includes("negation")) {
          expect(NEGATION_PATTERN.test(turn.text), where).toBe(true);
        }
        if (turn.tags?.includes("self_correction")) {
          const marker = CORRECTION_MARKER.exec(turn.text);
          expect(marker, where).not.toBeNull();
          // The corrected value is the quote's first occurrence, which is where evidence lands.
          const after = turn.expect.flatMap(expectedFields).filter(([, field]) => {
            return turn.text.indexOf(field.quote) > (marker?.index ?? Number.POSITIVE_INFINITY);
          });
          expect(after.length, where).toBeGreaterThan(0);
        }
        expect(new Set(turn.tags ?? []).size, where).toBe((turn.tags ?? []).length);
      });
    }
  });

  it("places every call on a weekday, during working hours where the rep is", () => {
    for (const script of DEBRIEFS) {
      const weekday = new Date(`${localDate(script.callTime, script.timeZone)}T00:00:00Z`);
      expect([1, 2, 3, 4, 5], script.id).toContain(weekday.getUTCDay());
      const hour = Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: script.timeZone,
          hour: "2-digit",
          hourCycle: "h23",
        }).format(new Date(script.callTime)),
      );
      expect(hour, script.id).toBeGreaterThanOrEqual(8);
      expect(hour, script.id).toBeLessThan(20);
    }
  });
});

describe("coverage", () => {
  const coverage = coverageOf(DEBRIEFS);

  it("meets every minimum", () => {
    expect(coverage.scripts).toBe(COVERAGE_MINIMUMS.scripts);
    expect(coverage.turnsWithProposals).toBeGreaterThanOrEqual(
      COVERAGE_MINIMUMS.turnsWithProposals,
    );
    for (const type of ProposalType.options) {
      expect(coverage.perType[type], type).toBeGreaterThanOrEqual(COVERAGE_MINIMUMS.perType);
    }
    expect(coverage.confusableScripts.length).toBeGreaterThanOrEqual(
      COVERAGE_MINIMUMS.confusableScripts,
    );
    expect(coverage.numberTurns).toBeGreaterThanOrEqual(COVERAGE_MINIMUMS.numberTurns);
    expect(coverage.relativeDateTurns).toBeGreaterThanOrEqual(COVERAGE_MINIMUMS.relativeDateTurns);
    expect(coverage.negationTurns).toBeGreaterThanOrEqual(COVERAGE_MINIMUMS.negationTurns);
    expect(coverage.selfCorrectionTurns).toBeGreaterThanOrEqual(
      COVERAGE_MINIMUMS.selfCorrectionTurns,
    );
    expect(coverage.voices).toBeGreaterThanOrEqual(COVERAGE_MINIMUMS.voices);
  });

  it("mixes American and British voices, female and male", () => {
    const prefixes = new Set(DEBRIEFS.map((script) => script.voice.slice(0, 2)));
    expect([...prefixes].sort()).toEqual(["af", "am", "bf", "bm"]);
  });

  it("keeps each fixture near the spec's 30 seconds of speech", () => {
    for (const script of DEBRIEFS) {
      const words = script.turns.reduce((sum, turn) => sum + turn.text.split(" ").length, 0);
      // About 2.5 words a second, so 25–160 words is roughly 10–65 seconds.
      expect(words, script.id).toBeGreaterThanOrEqual(25);
      expect(words, script.id).toBeLessThanOrEqual(160);
    }
  });
});
