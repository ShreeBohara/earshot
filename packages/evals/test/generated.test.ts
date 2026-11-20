// The generated debriefs, d031–d200 (Phase 4 WP10 steps 1 to 4): the generator reproduces the
// committed files, the 200 meet eval harness v1's coverage minimums, and the ground truth holds:
// every quote is a substring of what the stream heard, every date, time, and amount is re-derived,
// and every generated target resolves by construction. Also the conformance test of decision 13
// over all 200, and the generator's parts.
import { readdirSync, readFileSync } from "node:fs";
import { ProposalTypeV2 } from "@earshot/core";
import { checkField, fieldKind } from "@earshot/understanding/faithfulness";
import { parseAmount, resolveDate, resolveTime } from "@earshot/understanding/normalize";
import { describe, expect, it } from "vitest";
import {
  CORRECTION_MARKER,
  COVERAGE_MINIMUMS_V1,
  coverageOf,
  coverageShortfallsV0,
  coverageShortfallsV1,
  DEBRIEFS,
  DebriefScriptFile,
  expectedFields,
  localDate,
  NEGATION_PATTERN,
} from "../src";
import { createRng } from "../src/channel/rng";
import {
  addDisfluency,
  GENERATED_IDS,
  generateDebriefScripts,
  generatedIndexSource,
  lexicon,
  parseTemplate,
  serializeScript,
  showsDisfluency,
  TEMPLATES,
  templateFields,
} from "../src/grammar";
import { lit, render, type Seg } from "../src/grammar/segments";
import {
  ALL_DEBRIEFS,
  GENERATED_DEBRIEFS,
  GENERATED_FILES,
  groundTruthProblems,
  unbiasedReadingOf,
} from "../src/understanding";

const GENERATED_DIR = new URL("../debriefs/generated/", import.meta.url);
const INDEX = new URL("../src/understanding/generated.ts", import.meta.url);

describe("the generator", () => {
  it("reproduces the committed d031–d200 and their index byte for byte (run `pnpm --filter @earshot/evals debriefs:gen` after changing it, then cassettes:gen and eval:understanding --write-baseline)", () => {
    const scripts = generateDebriefScripts();
    expect(scripts.map((script) => script.id)).toEqual(GENERATED_IDS);
    const files = readdirSync(GENERATED_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(files).toEqual(GENERATED_IDS.map((id) => `${id}.json`));
    for (const script of scripts) {
      const committed = readFileSync(new URL(`${script.id}.json`, GENERATED_DIR), "utf8");
      expect(serializeScript(script), script.id).toBe(committed);
    }
    expect(generatedIndexSource(GENERATED_IDS)).toBe(readFileSync(INDEX, "utf8"));
  }, 120_000); // well under a second each here; CI's runners under turbo are far slower

  it("writes format v2 files that parse as they sit on disk, and leaves d001–d030 alone", () => {
    expect(GENERATED_FILES).toEqual(GENERATED_IDS);
    expect(GENERATED_DEBRIEFS.map((script) => script.id)).toEqual(GENERATED_IDS);
    for (const id of GENERATED_IDS) {
      const raw = JSON.parse(readFileSync(new URL(`${id}.json`, GENERATED_DIR), "utf8"));
      expect(DebriefScriptFile.parse(raw).id).toBe(id);
    }
    expect(ALL_DEBRIEFS).toHaveLength(200);
    expect(ALL_DEBRIEFS.slice(0, 30)).toEqual(DEBRIEFS);
    expect(ALL_DEBRIEFS.map((script) => script.id)).toEqual(
      Array.from({ length: 200 }, (_, i) => `d${String(i + 1).padStart(3, "0")}`),
    );
  });

  it("has 15 to 25 phrasings per proposal type", () => {
    for (const type of ProposalTypeV2.options) {
      const count = TEMPLATES[type].length;
      expect(count, type).toBeGreaterThanOrEqual(15);
      expect(count, type).toBeLessThanOrEqual(25);
    }
    const ids = Object.values(TEMPLATES).flatMap((templates) => templates.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("writes templates whose fields belong to their type, with a value for every free-text field", () => {
    const FIELDS: Readonly<Record<string, readonly string[]>> = {
      note: ["body"],
      task: ["title", "dueDate"],
      contact: ["name", "title", "company", "email", "phone"],
      deal_update: ["stage", "amount", "closeDate"],
      commitment: ["text", "counterpart", "dueDate"],
      meeting: ["title", "date", "time", "attendees"],
    };
    for (const [type, templates] of Object.entries(TEMPLATES)) {
      for (const template of templates) {
        const fields = templateFields(parseTemplate(template.text));
        expect(fields.length, template.id).toBeGreaterThan(0);
        for (const field of fields) {
          expect(FIELDS[type], `${template.id} ${field}`).toContain(field);
          const free = fieldKind(type, field) === "text";
          if (free && !(type === "contact")) {
            expect(template.values?.[field], `${template.id} ${field}`).toBeDefined();
          }
        }
      }
    }
  });

  it("keeps negations, corrections, fillers, weekdays, months, and digits out of its word lists", () => {
    const plain = [
      ...lexicon.DOCS,
      ...lexicon.TOPICS,
      ...lexicon.FACTS,
      ...lexicon.ROLES,
      ...lexicon.STAGES,
    ];
    const weekdays = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu;
    const months =
      /\b(?:january|february|march|april|june|july|august|september|october|november|december)\b/iu;
    for (const words of plain) {
      expect(NEGATION_PATTERN.test(words), words).toBe(false);
      expect(CORRECTION_MARKER.test(words), words).toBe(false);
      expect(showsDisfluency(words), words).toBe(false);
      expect(weekdays.test(words) || months.test(words) || /\d/u.test(words), words).toBe(false);
    }
    for (const words of [...lexicon.NEGATED_FACTS, ...lexicon.NEGATED_PROMISES]) {
      expect(NEGATION_PATTERN.test(words), words).toBe(true);
      expect(CORRECTION_MARKER.test(words), words).toBe(false);
    }
  });

  it("adds disfluencies only outside fields and names, and can tell them in a text", () => {
    const segs: Seg[] = [
      lit("I need to send "),
      { kind: "var", said: "Dana Lee", biased: "Dana Li", unbiased: "Dana Lee", role: "mention:0" },
      lit(" "),
      { kind: "open", field: "0.title" },
      lit("the order form"),
      { kind: "close", field: "0.title" },
      lit(" "),
      { kind: "open", field: "0.dueDate" },
      lit("by Friday"),
      { kind: "close", field: "0.dueDate" },
      lit("."),
    ];
    const before = render(segs, "biased");
    for (const kind of ["filler", "repetition", "replacement", "restart"] as const) {
      for (let seed = 1; seed <= 20; seed++) {
        const changed = addDisfluency(segs, kind, createRng(seed));
        if (changed === null) continue;
        const after = render(changed, "biased");
        expect(showsDisfluency(after.text), `${kind} ${after.text}`).toBe(true);
        for (const field of ["0.title", "0.dueDate"]) {
          const span = (r: typeof before) =>
            r.text.slice(...(r.fields.get(field) as [number, number]));
          expect(span(after), `${kind} ${after.text}`).toBe(span(before));
        }
        // Never right before the date: its words stay as the normalizers read them.
        expect(after.text, kind).toContain(" by Friday.");
        expect(after.text, kind).not.toMatch(/(?:um|uh|you know), by Friday/u);
      }
    }
    expect(showsDisfluency("I owe Dana Lee the quote.")).toBe(false);
    expect(showsDisfluency("I I owe Dana Lee the quote.")).toBe(true);
    expect(showsDisfluency("Send, um, Dana the quote.")).toBe(true);
    expect(showsDisfluency("Send, you know, Dana the quote.")).toBe(true);
  });
});

describe("the 200 scripts", () => {
  const coverage = coverageOf(ALL_DEBRIEFS);

  it("meet eval harness v1's coverage minimums, and the 30 still meet v0's", () => {
    expect(coverageShortfallsV1(coverage)).toEqual([]);
    expect(coverage.scripts).toBe(COVERAGE_MINIMUMS_V1.scripts);
    expect(coverageShortfallsV0(coverageOf(DEBRIEFS))).toEqual([]);
  });

  it("hold ground truth that checks out: quotes heard, values re-derived, targets resolved by construction", () => {
    for (const script of ALL_DEBRIEFS) {
      const generated = script.version === 2 && Number(script.id.slice(1)) > 30;
      expect(groundTruthProblems(script, { construction: generated }), script.id).toEqual([]);
    }
  }, 120_000); // well under a second each here; CI's runners under turbo are far slower

  it("each have their own call time, on a weekday, in working hours where the rep is", () => {
    const times = ALL_DEBRIEFS.map((script) => Date.parse(script.callTime));
    expect(new Set(times).size).toBe(times.length);
    for (const script of GENERATED_DEBRIEFS) {
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

  it("write what each witness heard only where it differs from what was said", () => {
    for (const id of GENERATED_IDS) {
      const raw = JSON.parse(readFileSync(new URL(`${id}.json`, GENERATED_DIR), "utf8"));
      for (const turn of raw.turns) {
        if (turn.heard?.biased !== undefined) expect(turn.heard.biased, id).not.toBe(turn.text);
        if (turn.heard?.unbiased !== undefined) expect(turn.heard.unbiased, id).not.toBe(turn.text);
      }
    }
  });

  it("agree with the product's normalizers on every date, time, and amount (decision 13), and pass its faithfulness check", () => {
    let fields = 0;
    for (const script of ALL_DEBRIEFS) {
      for (const turn of script.turns) {
        const text = turn.heard.biased;
        for (const proposal of turn.expect) {
          const date = (proposal.fields as Record<string, { value: unknown } | undefined>).date;
          for (const [name, field] of expectedFields(proposal)) {
            fields++;
            const where = `${script.id} ${proposal.type} ${name} "${field.quote}"`;
            const kind = fieldKind(proposal.type, name);
            if (kind === "date") {
              const resolved = resolveDate(field.quote, script.callTime, script.timeZone);
              expect(resolved, where).toMatchObject({ readings: [field.value], certain: true });
            }
            if (kind === "amount") {
              expect(parseAmount(field.quote), where).toMatchObject({
                value: field.value,
                ambiguous: false,
              });
            }
            if (kind === "time")
              expect(resolveTime(field.quote)?.readings, where).toEqual([field.value]);
            const start = text.indexOf(field.quote);
            const result = checkField(
              {
                field: name,
                kind,
                value: field.value,
                utterance: text,
                span: [start, start + field.quote.length],
              },
              {
                turnText: text,
                callTime: script.callTime,
                timeZone: script.timeZone,
                date: typeof date?.value === "string" ? date.value : null,
              },
            );
            expect(result.value, where).toBe(field.value);
            expect(result.verdict, where).toBe("supported");
            // A right value carries no flag but negation, and a generated one carries it exactly
            // where its script expects it.
            const flags = result.flags.map((flag) => flag.kind);
            expect(
              flags.filter((flag) => flag !== "negation"),
              where,
            ).toEqual([]);
            if (Number(script.id.slice(1)) > 30 && flags.includes("negation")) {
              expect(proposal.expectFlags ?? [], where).toContain("negation");
            }
          }
        }
      }
    }
    expect(fields).toBeGreaterThan(1_300);
  });
});

describe("reading the second witness off a generated turn", () => {
  it("finds the unbiased words where the biased quote sits, by the words both share", () => {
    const biased = "Priya Nair's email is priya.nash@quarry-lane-media.example.";
    const unbiased = "Pliya Nash's email is priya.nash@quarry-lane-media.example.";
    expect(unbiasedReadingOf(biased, unbiased, "Priya Nair")).toBe("Pliya Nash");
    expect(
      unbiasedReadingOf(
        "Peer Logistics agreed to a workshop on Wednesday.",
        "Pierce Logiztics agreed to a workshop on Wednesday.",
        "Peer Logistics",
      ),
    ).toBe("Pierce Logiztics");
    expect(
      unbiasedReadingOf("Met Dana Lee from Acme today.", "Met Dana Lee from Akme today.", "Acme"),
    ).toBe("Akme");
    expect(unbiasedReadingOf("Met Dana Lee today.", "Met today.", "Dana Lee")).toBeNull();
    expect(unbiasedReadingOf("Met Dana Lee today.", "Met Dana Lee today.", "Nobody")).toBeNull();
  });
});
