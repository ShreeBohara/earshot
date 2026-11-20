import { readdirSync, readFileSync } from "node:fs";
import { matchEntity, TARGET_KINDS } from "@earshot/agent";
import { DEMO_CALL_TIME } from "@earshot/agent/testing";
import { ProposalType, ProposalTypeV2 } from "@earshot/core";
import { contacts } from "@earshot/demo-crm";
import { fieldKind } from "@earshot/understanding/faithfulness";
import { normalizeName } from "@earshot/understanding/names";
import { describe, expect, it } from "vitest";
import {
  CORRECTION_MARKER,
  COVERAGE_MINIMUMS,
  coverageOf,
  DEBRIEF_FILES,
  DEBRIEFS,
  DEMO_SESSION_ENTITIES,
  DebriefScript,
  DebriefScriptV1,
  debriefAt,
  demoEntity,
  ExpectedProposal,
  ExpectedProposalV1,
  expectedDecision,
  expectedFields,
  KEY_FIELDS,
  localDate,
  MAX_SNR_DB,
  MIN_SNR_DB,
  NEGATION_PATTERN,
  NOISE_KINDS,
  namedOf,
  parseUsd,
  resolveDatePhrase,
  upgradeDebriefScript,
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

  it("each have their own call time, which the e2e edge Worker picks a script's cassette by", () => {
    const times = DEBRIEFS.map((script) => Date.parse(script.callTime));
    expect(new Set(times).size).toBe(DEBRIEFS.length);
    // Not the demo session's either, whose cassettes answer when no script matches.
    expect(times).not.toContain(Date.parse(DEMO_CALL_TIME));
    for (const script of DEBRIEFS) expect(debriefAt(script.callTime)?.id).toBe(script.id);
    const first = DEBRIEFS[0] as DebriefScript;
    // The same instant written another way is the same call.
    expect(debriefAt(new Date(first.callTime).toISOString().replace("Z", "+00:00"))?.id).toBe(
      first.id,
    );
    expect(debriefAt(DEMO_CALL_TIME)).toBeUndefined();
    expect(debriefAt("not a time")).toBeUndefined();
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

  it("checks each proposal type's fields, target ids, dates, and amounts (format v1)", () => {
    const note = { type: "note", target: "co_011", fields: { body: { value: "x", quote: "x" } } };
    expect(ExpectedProposalV1.safeParse(note).success).toBe(true);
    const bad = (value: unknown) => expect(ExpectedProposalV1.safeParse(value).success).toBe(false);
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

  it("checks each format v2 target as a record and a decision that agree", () => {
    const note = (target: unknown) => ({
      type: "note",
      target,
      fields: { body: { value: "x", quote: "x" } },
    });
    const ok = (value: unknown) => expect(ExpectedProposal.safeParse(value).success).toBe(true);
    const bad = (value: unknown) => expect(ExpectedProposal.safeParse(value).success).toBe(false);
    ok(note({ id: "co_011", decision: "linked" }));
    ok(note({ id: "co_011", decision: "ask" }));
    ok(note({ id: null, decision: "ask" }));
    ok(note({ id: null, decision: "new" }));
    ok(note({ id: null, decision: "none" }));
    bad(note({ id: null, decision: "linked" }));
    bad(note({ id: "co_011", decision: "new" }));
    bad(note({ id: "co_011", decision: "none" }));
    bad(note("co_011"));
    ok({ ...note({ id: "co_011", decision: "linked" }), expectFlags: ["link_uncertain"] });
    bad({ ...note({ id: "co_011", decision: "linked" }), expectFlags: ["sarcasm"] });
    bad({ ...note({ id: "co_011", decision: "linked" }), expectFlags: ["negation", "negation"] });
    ok({
      type: "meeting",
      target: { id: "ct_045", decision: "linked" },
      fields: { title: { value: "x", quote: "x" }, time: { value: "14:00", quote: "at 2 pm" } },
    });
    bad({
      type: "meeting",
      target: { id: "ct_045", decision: "linked" },
      fields: { title: { value: "x", quote: "x" }, time: { value: "2pm", quote: "at 2 pm" } },
    });
  });

  it("covers every proposal type, and keys only fields each type has", () => {
    const typesV1 = ExpectedProposalV1.options.map((option) => option.shape.type.value);
    expect(typesV1.sort()).toEqual([...ProposalType.options].sort());
    const types = ExpectedProposal.options.map((option) => option.shape.type.value);
    expect(types.sort()).toEqual([...ProposalTypeV2.options].sort());
    expect(Object.keys(KEY_FIELDS).sort()).toEqual([...ProposalTypeV2.options].sort());
    for (const option of ExpectedProposal.options) {
      const type = option.shape.type.value;
      const fields = Object.keys(option.shape.fields.shape);
      for (const key of KEY_FIELDS[type]) expect(fields).toContain(key);
    }
  });
});

describe("format v2 and the v1 upgrade", () => {
  it("upgrades each v1 file in code: its targets become { id, decision }, and both witnesses heard its text", () => {
    for (const id of EXPECTED_IDS) {
      const raw = JSON.parse(readFileSync(new URL(`${id}.json`, DIRECTORY), "utf8"));
      expect(raw.version, id).toBe(1);
      const script = DebriefScript.parse(raw);
      expect(script.version, id).toBe(2);
      script.turns.forEach((turn, index) => {
        expect(turn.heard, id).toEqual({ biased: turn.text, unbiased: turn.text });
        turn.expect.forEach((proposal, n) => {
          const before = raw.turns[index].expect[n];
          const decision =
            before.decision ??
            (before.target !== null ? "linked" : before.type === "contact" ? "new" : "none");
          expect(proposal.target, `${id} turn ${index + 1}`).toEqual({
            id: before.target,
            decision,
          });
          expect(proposal, `${id} turn ${index + 1}`).not.toHaveProperty("decision");
        });
      });
      // An upgraded script is a valid v2 script, and parsing it again changes nothing.
      expect(DebriefScript.parse(script)).toEqual(script);
      expect(upgradeDebriefScript(DebriefScriptV1.parse(raw))).toEqual(script);
    }
  });

  it("reads what each witness heard, the flags to expect, meetings, and noise", () => {
    const base = { ...(DEBRIEFS[0] as DebriefScript) };
    const turn = {
      pauseBeforeMs: 1_500,
      text: "Book a demo with Acme Dynamics on Friday at 2 pm.",
      heard: { biased: "Book a demo with Akme Dynamics on Friday at 2 pm." },
      expect: [
        {
          type: "meeting",
          target: { id: "co_011", decision: "linked" },
          named: { quote: "Akme Dynamics", kind: "company" },
          expectFlags: ["link_uncertain"],
          fields: {
            title: { value: "Demo with Akme Dynamics", quote: "a demo" },
            date: { value: "2026-11-20", quote: "on Friday" },
            time: { value: "14:00", quote: "at 2 pm" },
          },
        },
      ],
    };
    const script = DebriefScript.parse({
      ...base,
      noise: { kind: "cafe", snrDb: 12 },
      turns: [turn, { ...turn, heard: undefined }],
    });
    expect(script.noise).toEqual({ kind: "cafe", snrDb: 12 });
    expect(script.turns[0]?.heard).toEqual({ biased: turn.heard.biased, unbiased: turn.text });
    expect(script.turns[1]?.heard).toEqual({ biased: turn.text, unbiased: turn.text });
    const rejects = (value: unknown) => expect(DebriefScript.safeParse(value).success).toBe(false);
    rejects({ ...base, noise: { kind: "rain", snrDb: 12 } });
    rejects({ ...base, noise: { kind: "car", snrDb: MAX_SNR_DB + 1 } });
    rejects({ ...base, noise: { kind: "car", snrDb: MIN_SNR_DB - 1 } });
    rejects({ ...base, noise: { kind: "car" } });
    rejects({ ...base, turns: [{ ...turn, heard: { biased: "Two  spaces." } }, turn] });
    rejects({ ...base, turns: [{ ...turn, heard: { other: "x" } }, turn] });
    rejects({ ...base, turns: [{ ...turn, tags: ["disfluency", "disfluency"] }, turn] });
    // A v1 file can't use v2's fields.
    rejects({
      ...JSON.parse(readFileSync(new URL("d001.json", DIRECTORY), "utf8")),
      noise: { kind: "car", snrDb: 5 },
    });
  });

  it("holds noise to what lab/scripts/debrief_noise.py mixes", () => {
    const python = readFileSync(
      new URL("../../../lab/scripts/debrief_noise.py", import.meta.url),
      "utf8",
    );
    expect(python).toContain(`MIN_SNR_DB = ${MIN_SNR_DB.toFixed(1)}\n`);
    expect(python).toContain(`MAX_SNR_DB = ${MAX_SNR_DB.toFixed(1)}\n`);
    const kinds = NOISE_KINDS.filter((kind) => kind !== "none").map((kind) => `"${kind}"`);
    expect(python).toContain(`NOISE_KINDS: tuple[NoiseKind, ...] = (${kinds.join(", ")})\n`);
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
      if (proposal.target.id === null) continue;
      const entity = demoEntity(proposal.target.id);
      expect(TARGET_KINDS[proposal.type], label(entry)).toContain(entity.kind);
      expect(
        matchEntity(entity.name, DEMO_SESSION_ENTITIES, TARGET_KINDS[proposal.type])?.id,
        label(entry),
      ).toBe(proposal.target.id);
    }
  });

  it("quotes how the rep named each record from its own turn, and never for a contact", () => {
    for (const entry of PROPOSALS) {
      const named = namedOf(entry.proposal);
      if (entry.proposal.type === "contact") {
        expect(named, label(entry)).toBeNull();
        continue;
      }
      if (named === null) continue;
      expect(entry.turn.text, label(entry)).toContain(named.quote);
      if (named.company !== undefined)
        expect(entry.turn.text, label(entry)).toContain(named.company);
      // A record the CRM doesn't hold needs its kind said.
      if (entry.proposal.target.id === null) expect(named.kind, label(entry)).toBeDefined();
    }
  });

  it("asks only about a record the script names, and opens only demo companies", () => {
    for (const entry of PROPOSALS) {
      if (expectedDecision(entry.proposal) === "ask") {
        expect(entry.proposal.target.id, label(entry)).not.toBeNull();
      }
    }
    for (const script of DEBRIEFS) {
      if (script.focusEntityId === undefined) continue;
      expect(demoEntity(script.focusEntityId).kind, script.id).toBe("company");
    }
  });

  it("writes names as the rep said them, since the extractor no longer sees the CRM list", () => {
    for (const entry of PROPOSALS) {
      for (const [name, field] of expectedFields(entry.proposal)) {
        if (fieldKind(entry.proposal.type, name) !== "name") continue;
        expect(normalizeName(String(field.value)), `${label(entry)} ${name}`).toBe(
          normalizeName(field.quote),
        );
      }
    }
  });

  it("gives new contacts names no demo contact has, and contact updates the contact's name", () => {
    const names = new Set(contacts.map((c) => `${c.firstName} ${c.lastName}`.toLowerCase()));
    for (const entry of PROPOSALS) {
      const { proposal } = entry;
      if (proposal.type !== "contact") continue;
      if (proposal.target.id === null) {
        expect(names.has(proposal.fields.name.value.toLowerCase()), label(entry)).toBe(false);
      } else {
        expect(proposal.fields.name.value, label(entry)).toBe(demoEntity(proposal.target.id).name);
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
