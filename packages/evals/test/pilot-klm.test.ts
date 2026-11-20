// The scripted reviewer's pure parts (Phase 5 spec WP8, gates G1a and G2a; ADR-0039): words as
// `countWords` reads them, the KLM estimate and how the fake clock spends it, the gate against the
// baseline (10% a card, and the median's target or, while the set misses it, its baseline), the
// committed baseline itself, the oracle from the manifest, the key budgets, the flag-follower
// bound, and the report.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkKlm,
  countWords,
  flagFollowerBound,
  KEY_BUDGET,
  KLM,
  KLM_KEY_MS,
  KlmBaseline,
  type KlmCard,
  keyDistribution,
  klmBaseline,
  klmBaselineText,
  klmMedianMs,
  klmMs,
  klmSeconds,
  klmSteps,
  overBudget,
  PilotManifest,
  pilotOracle,
  reviewerMarkdown,
} from "../src/pilot";

const manifest = PilotManifest.parse(
  JSON.parse(readFileSync(new URL("../pilot/pilot.v1/manifest.json", import.meta.url), "utf8")),
);
const committed = KlmBaseline.parse(
  JSON.parse(readFileSync(new URL("../baselines/pilot-klm.json", import.meta.url), "utf8")),
);
const tiers = new Map(manifest.tiers.proposals.map((tier) => [tier.proposalId, tier]));

/** The 40 cards, each with `words` words, accepted with one key unless loud (then 1 digit). */
function cards(words: (index: number) => number): KlmCard[] {
  return manifest.sessions.flatMap((session) =>
    session.proposals.map((proposalId): KlmCard => {
      const tier = tiers.get(proposalId);
      const loud = tier?.tier === "loud";
      const index = manifest.sessions.flatMap((s) => s.proposals).indexOf(proposalId);
      const count = words(index);
      return {
        session: session.id as KlmCard["session"],
        proposalId,
        heading: `Card ${index + 1}`,
        tier: tier?.tier ?? "none",
        seeded: tier?.seeded ?? null,
        decision: loud ? "question" : "accept",
        keys: [loud ? "1" : "a"],
        words: count,
        ms: klmMs({ loud, words: count, keys: 1 }),
      };
    }),
  );
}

describe("words, as a card shows them", () => {
  it("counts runs between whitespace that hold a letter or a digit", () => {
    expect(countWords("Note · Summit Ridge Medical")).toBe(4);
    expect(countWords("“ they want to add the analytics module ”")).toBe(7);
    expect(
      countWords("Amount $112,000 at 2:30 pm, kathryn.moore@blue-harbor-analytics.example"),
    ).toBe(6);
    expect(countWords("Bay Harbor Associates 96% A new record 34%")).toBe(8);
    expect(countWords("They don't need it.")).toBe(4);
    expect(countWords("Zoë Ångström, São Paulo")).toBe(4);
  });

  it("counts no word for punctuation alone, empty text, or whitespace of any kind", () => {
    expect(countWords("")).toBe(0);
    expect(countWords(" \t\n ")).toBe(0);
    expect(countWords("· → — “ ” , ?")).toBe(0);
    expect(countWords("a b\tc\nd")).toBe(4);
  });

  it("reads a long text in one pass", () => {
    expect(countWords("word ".repeat(200_000))).toBe(200_000);
    expect(countWords(`${" ".repeat(100_000)}x`)).toBe(1);
  });
});

describe("the KLM estimate per card (spec §4.8)", () => {
  it("is M + words ÷ rate + K × keys, scanning an unmarked or quiet card and reading a loud one", () => {
    expect(klmSeconds({ loud: false, words: 33, keys: 1 })).toBeCloseTo(1.35 + 33 / 7.93 + 0.28, 9);
    expect(klmSeconds({ loud: true, words: 68, keys: 1 })).toBeCloseTo(1.35 + 68 / 3.97 + 0.28, 9);
    expect(klmSeconds({ loud: false, words: 65, keys: 2 })).toBeCloseTo(1.35 + 65 / 7.93 + 0.56, 9);
    expect(KLM).toEqual({ mentalS: 1.35, keyS: 0.28, readWps: 3.97, scanWps: 7.93 });
    expect(KLM_KEY_MS).toBe(280);
  });

  it("is the same in whole milliseconds, to within rounding", () => {
    for (const loud of [false, true]) {
      for (let words = 0; words <= 120; words++) {
        for (const keys of [1, 2, 3]) {
          const ms = klmMs({ loud, words, keys });
          expect(Number.isInteger(ms)).toBe(true);
          expect(Math.abs(ms - 1000 * klmSeconds({ loud, words, keys }))).toBeLessThanOrEqual(0.5);
        }
      }
    }
  });

  it("is spent on the fake clock key by key, the reading before each key and then K, adding up to the estimate", () => {
    expect(klmSteps(false, [33])).toEqual([klmMs({ loud: false, words: 33, keys: 1 })]);
    // A silent error's fix: the card, then the correction panel's words once c opens it.
    const steps = klmSteps(false, [35, 65]);
    expect(steps[0]).toBe(Math.round(1000 * (1.35 + 35 / 7.93)) + 280);
    expect(steps.reduce((sum, step) => sum + step, 0)).toBe(
      klmMs({ loud: false, words: 65, keys: 2 }),
    );
    expect(klmSteps(true, [52, 52, 60]).reduce((a, b) => a + b, 0)).toBe(
      klmMs({ loud: true, words: 60, keys: 3 }),
    );
    expect(() => klmSteps(false, [40, 30])).toThrow(/may only grow/);
  });
});

describe("the KLM gate (spec WP8, G1a)", () => {
  const short = cards(() => 10); // every card well under 4.0 s
  const run = cards((index) => 20 + (index % 7));
  const baseline = klmBaseline(run, manifest, "2026-11-20");

  it("passes the run its baseline was recorded from", () => {
    const check = checkKlm(run, baseline, manifest);
    expect(check.problems).toEqual([]);
    expect(check.medianMs).toBe(klmMedianMs(run));
    expect(check.against.get(run[0]?.proposalId ?? "")).toBe(run[0]?.ms);
    expect(check.max?.ms).toBe(Math.max(...run.map((card) => card.ms)));
  });

  it("fails a card more than 10% above its baseline, and lets one at 10% through", () => {
    // A loud card, slower than the median already, so the median stays where it was.
    const at = run.findIndex((card) => card.tier === "loud");
    const card = run[at] as KlmCard;
    const swap = (changed: KlmCard) => run.map((each, index) => (index === at ? changed : each));
    const atTen = swap({ ...card, ms: Math.floor(card.ms * 1.1) });
    expect(checkKlm(atTen, baseline, manifest).problems).toEqual([]);
    const over = swap({ ...card, words: card.words + 9, ms: Math.floor(card.ms * 1.1) + 2 });
    const problems = checkKlm(over, baseline, manifest).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/more than 10% above its baseline/);
    expect(problems[0]).toMatch(new RegExp(`words ${card.words} → ${card.words + 9}`));
  });

  it("holds the median to 4.0 s, or to the baseline's while the set misses that", () => {
    // Under the target: passes whatever the baseline's median.
    const fast = klmBaseline(short, manifest, "2026-11-20");
    expect(checkKlm(short, fast, manifest)).toMatchObject({ targetMet: true, problems: [] });
    expect(checkKlm(short, fast, manifest).ceilingMs).toBe(4_000);
    // Over it: the baseline's median holds, and a slower median fails even with every card
    // within its 10%.
    const slow = cards(() => 30);
    const slowBaseline = klmBaseline(slow, manifest, "2026-11-20");
    const check = checkKlm(slow, slowBaseline, manifest);
    expect(check).toMatchObject({ targetMet: false, problems: [] });
    expect(check.ceilingMs).toBe(slowBaseline.medianMs);
    const slower = slow.map((card) => ({ ...card, ms: card.ms + 50 }));
    expect(checkKlm(slower, slowBaseline, manifest).problems).toEqual([
      expect.stringMatching(/over its baseline's .* the median may not rise/),
    ]);
    // With no baseline, the target alone.
    expect(checkKlm(slow, null, manifest).problems).toEqual([
      expect.stringMatching(/^No packages\/evals\/baselines\/pilot-klm\.json: record one/),
      expect.stringMatching(/over the 4\.00 s target/),
    ]);
  });

  it("asks for a new baseline when it's from another set or model, or holds other cards", () => {
    // Without a baseline it can use, only the 4.0 s target holds the median, which this run misses.
    const otherSet = { ...baseline, setSha256: "0".repeat(64) };
    expect(checkKlm(run, otherSet, manifest).problems).toEqual([
      expect.stringMatching(/recorded on another set: re-record it on purpose/),
      expect.stringMatching(/over the 4\.00 s target/),
    ]);
    const otherModel = { ...baseline, model: { ...baseline.model, scanWps: 8 } };
    expect(checkKlm(run, otherModel, manifest).problems).toEqual([
      expect.stringMatching(/recorded with another model/),
      expect.stringMatching(/over the 4\.00 s target/),
    ]);
    const [first, ...rest] = run;
    if (!first) throw new Error("no cards");
    const stranger = { ...first, proposalId: "01a1c6e9-0000-7000-8000-000000000000" };
    expect(checkKlm([stranger, ...rest], baseline, manifest).problems).toEqual([
      expect.stringMatching(/not in packages\/evals\/baselines\/pilot-klm\.json/),
      expect.stringMatching(new RegExp(`${first.proposalId}: in .*, but not reviewed`)),
    ]);
    const quieter = [
      { ...first, tier: first.tier === "loud" ? "none" : "loud" } as KlmCard,
      ...rest,
    ];
    expect(checkKlm(quieter, baseline, manifest).problems).toEqual([
      expect.stringMatching(/in its baseline; re-record it/),
    ]);
  });

  it("writes the baseline as two-space JSON that reads back the same", () => {
    const text = klmBaselineText(baseline);
    expect(text.endsWith("}\n")).toBe(true);
    expect(KlmBaseline.parse(JSON.parse(text))).toEqual(baseline);
  });
});

describe("the committed baseline, baselines/pilot-klm.json", () => {
  it("was recorded on pilot.v1 with today's model, and holds each of the 40 cards once", () => {
    expect(committed.setSha256).toBe(manifest.sha256);
    expect(committed.model).toEqual(KLM);
    expect(committed.cards.map((card) => card.proposalId).sort()).toEqual(
      manifest.sessions.flatMap((session) => session.proposals).sort(),
    );
  });

  it("agrees with itself and the manifest: each estimate from its words and keys, each tier and seeded error as built", () => {
    for (const card of committed.cards) {
      const tier = tiers.get(card.proposalId);
      expect(card.tier).toBe(tier?.tier);
      expect(card.seeded).toBe(tier?.seeded);
      expect(card.ms).toBe(
        klmMs({ loud: card.tier === "loud", words: card.words, keys: card.keys.length }),
      );
    }
    expect(committed.medianMs).toBe(klmMedianMs(committed.cards));
    expect(checkKlm(committed.cards, committed, manifest).problems).toEqual([]);
  });
});

describe("the oracle, from the manifest", () => {
  const oracle = pilotOracle(manifest);

  it("answers each flagged error New, on its digit, and each silent one with c and the right record's", () => {
    expect(oracle.size).toBe(8);
    for (const error of manifest.seeded) {
      const answer = oracle.get(error.proposalId);
      if (error.kind === "flagged") {
        expect(answer).toEqual({
          kind: "flagged",
          decision: "question",
          keys: ["2"],
          choice: 1,
          right: null,
        });
      } else {
        expect(answer).toEqual({
          kind: "silent",
          decision: "another_record",
          keys: ["c", "2"],
          choice: 1,
          right: error.right.entityId,
        });
      }
    }
  });

  it("refuses an answer that no digit reaches", () => {
    const [flagged] = manifest.seeded.filter((error) => error.kind === "flagged");
    if (flagged?.kind !== "flagged") throw new Error("no flagged error");
    const late = {
      ...flagged,
      candidates: [
        { entityId: "co_001", p: 0.9 },
        { entityId: "co_002", p: 0.3 },
        { entityId: "co_003", p: 0.2 },
        { entityId: "co_004", p: 0.1 },
        { entityId: null, p: 0.05 },
      ],
    };
    expect(() => pilotOracle({ seeded: [late] })).toThrow(/isn't on a digit/);
  });
});

describe("keys per decision (spec WP8, G1a)", () => {
  it("allows 2 keys to accept, reject, or choose in a question, and 3 to choose another record", () => {
    expect(KEY_BUDGET).toEqual({ accept: 2, reject: 2, question: 2, another_record: 3 });
    expect(
      overBudget([
        { proposalId: "a", decision: "accept", keys: ["j", "a"] },
        { proposalId: "b", decision: "another_record", keys: ["j", "c", "2"] },
        { proposalId: "c", decision: "question", keys: ["2"] },
      ]),
    ).toEqual([]);
    expect(
      overBudget([
        { proposalId: "a", decision: "accept", keys: ["j", "j", "a"] },
        { proposalId: "b", decision: "another_record", keys: ["j", "c", "Down", "Enter"] },
      ]),
    ).toEqual([
      "a: 3 keys (j j a) to accept, over its 2.",
      "b: 4 keys (j c Down Enter) to another record, over its 3.",
    ]);
  });

  it("counts the decisions of each kind by their keys", () => {
    const distribution = keyDistribution([
      { proposalId: "a", decision: "accept", keys: ["a"] },
      { proposalId: "b", decision: "accept", keys: ["a"] },
      { proposalId: "c", decision: "another_record", keys: ["c", "2"] },
    ]);
    expect(distribution.get("accept")).toEqual(new Map([[1, 2]]));
    expect(distribution.get("another_record")).toEqual(new Map([[2, 1]]));
    expect(distribution.get("reject")).toBeUndefined();
  });
});

describe("the flag-follower bound (spec WP8 step 3)", () => {
  it("is the seeded errors on loud cards: 4 of pilot.v1's 8", () => {
    expect(flagFollowerBound(cards(() => 20))).toEqual({ caught: 4, of: 8 });
    expect(flagFollowerBound(committed.cards)).toEqual({ caught: 4, of: 8 });
  });
});

describe("the report", () => {
  const run = cards((index) => 30 + (index % 5));
  const baseline = klmBaseline(run, manifest, "2026-11-20");

  it("says the median against its target, the keys, the markers, the bound, and every card", () => {
    const text = reviewerMarkdown({
      manifest,
      cards: run,
      klm: checkKlm(run, baseline, manifest),
      recorded: false,
      decisions: run.map((card) => ({
        proposalId: card.proposalId,
        decision: card.decision,
        keys: card.keys,
      })),
      markers: { checked: 43, missing: [] },
      focus: { keys: 45, last: "All caught up" },
      clock: { exact: 40, analyzedMedianMs: baseline.medianMs },
      attempt: 0,
    });
    expect(text).toMatch(/^## The scripted reviewer: pilot\.v1 at \$0/);
    expect(text).toContain("The 4.00 s target: **not met**. Until it is, the median is held at");
    expect(text).toContain(
      "No card more than 10% above `packages/evals/baselines/pilot-klm.json`:** yes",
    );
    expect(text).toContain("| Accept | at most 2 | 31 with 1 key |");
    expect(text).toContain(
      "Every card showed the markers the manifest built it with, in the accessibility tree and on screen (43 cards",
    );
    expect(text).toContain("**4 of 8**");
    expect(text).toContain("on 40 of 40 cards");
    expect(text.match(/^\| \d+ \| s\d\d \|/gm)).toHaveLength(40);
    expect(text).not.toContain("### Problems");
  });

  it("lists what fails, and says when the run recorded the baseline instead", () => {
    const [first, ...rest] = run;
    if (!first) throw new Error("no cards");
    const slower = [{ ...first, ms: first.ms * 2 }, ...rest];
    const failing = reviewerMarkdown({
      manifest,
      cards: slower,
      klm: checkKlm(slower, baseline, manifest),
      recorded: false,
      decisions: [{ proposalId: first.proposalId, decision: "accept", keys: ["j", "j", "a"] }],
      markers: { checked: 43, missing: ["s02 Note · Atlas Freight"] },
      focus: { keys: 3, last: "All caught up" },
      clock: { exact: 39, analyzedMedianMs: null },
      attempt: 1,
    });
    expect(failing).toContain("attempt 2");
    expect(failing).toContain("**1 of 43 cards lost a marker:** s02 Note · Atlas Freight.");
    expect(failing).toContain("### Problems");
    expect(failing).toContain("- s02 Note · Atlas Freight: a marker missing.");
    expect(failing).toMatch(/more than 10% above its baseline/);
    expect(failing).toMatch(/3 keys \(j j a\) to accept, over its 2/);
    const recorded = reviewerMarkdown({
      manifest,
      cards: run,
      klm: checkKlm(run, baseline, manifest),
      recorded: true,
      decisions: [],
      markers: { checked: 43, missing: [] },
      focus: { keys: 0, last: "All caught up" },
      clock: { exact: 40, analyzedMedianMs: null },
      attempt: 0,
    });
    expect(recorded).toContain("recorded by this run to `packages/evals/baselines/pilot-klm.json`");
  });
});
