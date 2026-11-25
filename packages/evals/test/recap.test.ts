// The recap eval (Phase 5 WP10 steps 5 and 6): the committed recap cassettes and their labels are
// what the generator makes, the seeded errors are exactly the spec's share and really absent from
// each transcript, the run over all 200 debriefs passes the gate against the committed baseline,
// and the gate's arithmetic bites on hand-built runs.
import { readFileSync } from "node:fs";
import { locateQuote } from "@earshot/agent";
import { SCENARIO_API_KEY } from "@earshot/agent/testing";
import { containsKeyShape, type RecapCreatedV1 } from "@earshot/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  RECAP_LABELS_FILE,
  readRecapBaseline,
  readRecapCassettes,
  readRecapLabels,
  recapCassetteUrl,
  recapLabelsSha256,
} from "../scripts/recap-io";
import { scriptsSha256 } from "../scripts/understanding-io";
import { EVAL_PROVIDERS } from "../src/generate";
import {
  generateRecapCassettes,
  groundTruthLens,
  groundTruthSentences,
  RECAP_ERROR_RATES,
  type RecapLabels,
  type RecapMetrics,
  type RecapRun,
  recapCassetteInput,
  recapGateFailures,
  recapLensOf,
  recapMetrics,
  recapScriptUtterances,
  runRecapScript,
  seedRecapErrors,
  serializeRecapLabels,
  summarizeRecap,
} from "../src/recap";
import { ALL_DEBRIEFS, anyDebrief, serializeCassetteFile } from "../src/understanding";

describe("the recap cassettes", () => {
  it("are what scripts/gen-recap-cassettes.ts generates today, seeded errors included (run `pnpm --filter @earshot/evals recap:gen` after changing a script, the generator, or @earshot/agent's recap requests)", async () => {
    const labels = seedRecapErrors(ALL_DEBRIEFS);
    expect(serializeRecapLabels(labels)).toBe(readFileSync(RECAP_LABELS_FILE, "utf8"));
    const files = await generateRecapCassettes(ALL_DEBRIEFS, labels);
    for (const provider of EVAL_PROVIDERS) {
      expect(serializeCassetteFile(files[provider]), provider).toBe(
        readFileSync(recapCassetteUrl(provider), "utf8"),
      );
    }
  }, 120_000); // about a second here; CI's runners under turbo are far slower

  it("seed exactly the spec's share of bad sentences and invented lens quotes, none of them in its transcript", () => {
    const labels = readRecapLabels();
    expect(labels.sentences).toHaveLength(
      Math.round(RECAP_ERROR_RATES.bad_sentence * labels.eligible.bad_sentence),
    );
    expect(labels.lens).toHaveLength(
      Math.round(RECAP_ERROR_RATES.bad_lens_quote * labels.eligible.bad_lens_quote),
    );
    expect(labels.sentences.length).toBeGreaterThan(40);
    expect(new Set(labels.sentences.map((item) => item.error))).toEqual(
      new Set(["paraphrased", "invented"]),
    );
    for (const item of labels.sentences) {
      const utterances = recapScriptUtterances(anyDebrief(item.script));
      for (const quote of item.quotes) {
        expect(locateQuote(quote, utterances), `${item.script}: ${quote}`).toBeNull();
      }
      // The cassette's model writes it where the label says.
      const input = recapCassetteInput(anyDebrief(item.script), labels);
      expect(input.sentences[item.index]).toEqual({
        kind: item.kind,
        text: item.text,
        quotes: item.quotes,
      });
    }
    for (const item of labels.lens) {
      const utterances = recapScriptUtterances(anyDebrief(item.script));
      expect(locateQuote(item.quote, utterances), `${item.script}: ${item.quote}`).toBeNull();
      expect(recapLensOf(anyDebrief(item.script))).toBe(item.lens);
    }
  });

  it("quote only words each transcript holds in the ground truth, and fit the tool's limits", () => {
    for (const script of ALL_DEBRIEFS) {
      const utterances = recapScriptUtterances(script);
      const sentences = groundTruthSentences(script);
      expect(sentences[0]?.kind, script.id).toBe("headline");
      expect(
        sentences.filter((s) => s.kind === "headline"),
        script.id,
      ).toHaveLength(1);
      expect(sentences.length, script.id).toBeLessThanOrEqual(12);
      for (const sentence of sentences) {
        expect(sentence.quotes.length, script.id).toBeGreaterThan(0);
        expect(sentence.quotes.length, script.id).toBeLessThanOrEqual(4);
        for (const quote of sentence.quotes) {
          expect(locateQuote(quote, utterances), `${script.id}: ${quote}`).not.toBeNull();
          expect(quote.length).toBeLessThanOrEqual(200);
        }
      }
      for (const answer of groundTruthLens(script) ?? []) {
        if (answer.quote !== null) {
          expect(locateQuote(answer.quote, utterances), `${script.id}`).not.toBeNull();
        }
      }
    }
  });

  it("rotate the lens: none, MEDDIC, SPICED, BANT", () => {
    expect(["d001", "d002", "d003", "d004", "d005"].map((id) => recapLensOf({ id }))).toEqual([
      null,
      "meddic",
      "spiced",
      "bant",
      null,
    ]);
  });

  it("never hold a key or anything shaped like one", () => {
    const files = readRecapCassettes();
    for (const provider of EVAL_PROVIDERS) {
      const text = JSON.stringify(files[provider]);
      expect(text).not.toContain(SCENARIO_API_KEY);
      expect(containsKeyShape(text)).toBe(false);
      expect(Object.keys(files[provider].cassettes)).toEqual(
        ALL_DEBRIEFS.map((script) => script.id),
      );
    }
  });
});

describe("the recap eval over all 200 debriefs", () => {
  let labels: RecapLabels;
  const metrics: Partial<Record<string, RecapMetrics>> = {};

  beforeAll(async () => {
    labels = readRecapLabels();
    const cassettes = readRecapCassettes();
    for (const provider of EVAL_PROVIDERS) {
      const runs: RecapRun[] = [];
      for (const script of ALL_DEBRIEFS) {
        const cassette = cassettes[provider].cassettes[script.id];
        if (!cassette) throw new Error(`no cassette for ${script.id}`);
        runs.push(await runRecapScript(provider, script, cassette));
      }
      metrics[provider] = recapMetrics(runs, ALL_DEBRIEFS, labels);
    }
  }, 120_000);

  it("passes the gate against the committed baseline, recorded on these scripts and labels", () => {
    const baseline = readRecapBaseline();
    expect(baseline?.scriptsSha256).toBe(scriptsSha256());
    expect(baseline?.labelsSha256).toBe(recapLabelsSha256());
    for (const provider of EVAL_PROVIDERS) {
      const found = metrics[provider] as RecapMetrics;
      expect(
        recapGateFailures(provider, found, baseline?.providers[provider] ?? null),
        provider,
      ).toEqual([]);
      expect(found.evidence.rate, provider).toBe(1);
      expect(found.badDropped).toMatchObject({ n: labels.sentences.length, rate: 1 });
      expect(found.headlines).toMatchObject({ n: 200, of: 200 });
      expect(found.dropped.n).toBe(labels.sentences.length);
      expect(summarizeRecap(found)).toEqual(baseline?.providers[provider]);
    }
  });
});

describe("the recap gate", () => {
  const labels: RecapLabels = {
    version: 1,
    seed: 1,
    rates: { bad_sentence: 0.1, bad_lens_quote: 0.1 },
    eligible: { bad_sentence: 2, bad_lens_quote: 1 },
    sentences: [
      {
        script: "d001",
        index: 1,
        error: "invented",
        kind: "headline",
        after: 0,
        text: "Set up a board demo.",
        quotes: ["set up a board demo"],
      },
    ],
    lens: [],
  };
  const evidence = {
    utteranceId: "01a1c6e5-0000-7000-8000-300001000001",
    span: [0, 4] as [number, number],
    audioMs: [0, 400] as [number, number],
    confidence: 0.9,
  };
  const sentence = (kind: "headline" | "next_step", weakSupport = false) => ({
    kind,
    text: "A sentence.",
    evidence: [evidence],
    weakSupport,
  });
  const run = (recap: Partial<RecapCreatedV1>, trace: RecapRun["result"]["trace"]): RecapRun => ({
    script: "d001",
    result: {
      recap: {
        recapId: "01a1c6e7-0000-7000-8000-000000000001",
        outcome: "created",
        reason: null,
        llm: { provider: "anthropic", model: "claude-haiku-5-5" },
        sentences: [sentence("headline"), sentence("next_step")],
        dropped: 1,
        lens: null,
        ...recap,
      },
      usage: null,
      failure: null,
      trace,
      attempts: 1,
      latencyMs: 0,
    },
    misses: 0,
    unplayed: 0,
  });
  const fate = (index: number, kind: "headline" | "next_step", value: "kept" | "no_quote") => ({
    index,
    kind,
    fate: value,
    located: value === "kept" ? 1 : 0,
    quotes: 1,
    weakSupport: false,
  });
  // d001's ground truth has two sentences: a headline (its note) and a next step (its task).
  const scripts = [anyDebrief("d001")];
  const good = [
    fate(0, "headline", "kept"),
    fate(1, "headline", "no_quote"),
    fate(2, "next_step", "kept"),
  ];

  it("passes a run that dropped the seeded sentence and kept the ground truth", () => {
    expect(groundTruthSentences(anyDebrief("d001"))).toHaveLength(2);
    const metrics = recapMetrics(
      [run({ sentences: [sentence("headline"), sentence("next_step")] }, good)],
      scripts,
      labels,
    );
    expect(recapGateFailures("anthropic", metrics, null)).toEqual([]);
  });

  it("fails a kept seeded sentence, a dropped ground-truth one, a missing headline, and a sentence without evidence", () => {
    const leaked = recapMetrics(
      [
        run({}, [
          fate(0, "headline", "kept"),
          fate(1, "headline", "kept"),
          fate(2, "next_step", "kept"),
        ]),
      ],
      scripts,
      labels,
    );
    expect(recapGateFailures("anthropic", leaked, null).join()).toContain(
      "1 of 1 seeded bad sentences were kept",
    );
    const lost = recapMetrics(
      [
        run({}, [
          fate(0, "headline", "kept"),
          fate(1, "headline", "no_quote"),
          fate(2, "next_step", "no_quote"),
        ]),
      ],
      scripts,
      labels,
    );
    expect(recapGateFailures("anthropic", lost, null).join()).toContain(
      "1 of 2 ground-truth sentences were dropped",
    );
    const headless = recapMetrics(
      [run({ sentences: [sentence("next_step")] }, good)],
      scripts,
      labels,
    );
    expect(recapGateFailures("anthropic", headless, null).join()).toContain(
      "1 of 1 recaps have no headline",
    );
    const bare = recapMetrics(
      [
        run(
          { sentences: [sentence("headline"), { ...sentence("next_step"), evidence: [] }] },
          good,
        ),
      ],
      scripts,
      labels,
    );
    expect(recapGateFailures("anthropic", bare, null).join()).toContain(
      "1 of 2 kept sentences carry no evidence",
    );
  });

  it("fails a weak-support share more than 3 points above the baseline's, and a cassette miss", () => {
    const metrics = recapMetrics(
      [run({ sentences: [sentence("headline", true), sentence("next_step")] }, good)],
      scripts,
      labels,
    );
    const baseline = { ...summarizeRecap(metrics), weakSupportShare: 0.2 };
    expect(recapGateFailures("groq", metrics, baseline).join()).toContain("regression");
    expect(recapGateFailures("groq", metrics, { ...baseline, weakSupportShare: 0.48 })).toEqual([]);
    const missed = recapMetrics([{ ...run({}, good), misses: 1 }], scripts, labels);
    expect(recapGateFailures("groq", missed, null).join()).toContain("stale");
  });
});
