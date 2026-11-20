// The understanding eval (Phase 4 WP10 steps 5 to 7): the committed cassettes and their seeded
// errors are what the generator makes, the run over all 200 debriefs passes the gate against the
// committed baseline, and the metrics' and gate's arithmetic holds on hand-built runs.
import { readFileSync } from "node:fs";
import { SCENARIO_API_KEY } from "@earshot/agent/testing";
import { containsKeyShape, type ProposalCreatedV2 } from "@earshot/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cassetteFileUrl,
  ERRORS_FILE,
  errorsSha256,
  readBaseline,
  readErrorLabels,
  readUnderstandingCassettes,
  scriptsSha256,
} from "../scripts/understanding-io";
import { EVAL_PROVIDERS } from "../src/generate";
import type { DebriefScript } from "../src/schema";
import {
  ALL_DEBRIEFS,
  applyFlagged,
  ERROR_RATES,
  type ErrorLabels,
  generateUnderstandingCassettes,
  KEY_METRICS,
  LOUD_SHARE_INTERIM_CEILING,
  LOUD_SHARE_TARGET,
  matchTurn,
  runScript,
  type ScriptRun,
  seedErrors,
  serializeCassetteFile,
  serializeErrorLabels,
  summarize,
  targetMatches,
  type UnderstandingMetrics,
  understandingGateFailures,
  understandingMarkdown,
  understandingMetrics,
} from "../src/understanding";

describe("the understanding cassettes", () => {
  it("are what scripts/gen-cassettes.ts generates today, seeded errors included (run `pnpm --filter @earshot/evals cassettes:gen` after changing a script, the generator, or @earshot/agent's requests)", async () => {
    const labels = seedErrors(ALL_DEBRIEFS);
    expect(serializeErrorLabels(labels)).toBe(readFileSync(ERRORS_FILE, "utf8"));
    const files = await generateUnderstandingCassettes(ALL_DEBRIEFS, labels);
    for (const provider of EVAL_PROVIDERS) {
      expect(serializeCassetteFile(files[provider]), provider).toBe(
        readFileSync(cassetteFileUrl(provider), "utf8"),
      );
    }
  }, 120_000); // well under a second each here; CI's runners under turbo are far slower

  it("seed exactly the spec's share of each error, each one wrong, each paraphrase out of its transcript", () => {
    const labels = readErrorLabels();
    for (const kind of ["wrong_date", "wrong_amount", "paraphrased_target"] as const) {
      const seeded = labels.errors.filter((error) => error.kind === kind);
      expect(seeded.length, kind).toBe(Math.round(ERROR_RATES[kind] * labels.eligible[kind]));
      expect(seeded.length, kind).toBeGreaterThan(0);
    }
    const byId = new Map(ALL_DEBRIEFS.map((script) => [script.id, script]));
    for (const error of labels.errors) {
      expect(error.wrote, JSON.stringify(error)).not.toEqual(error.truth);
      const turn = byId.get(error.script)?.turns[error.turn];
      expect(turn?.expect[error.proposal], JSON.stringify(error)).toBeDefined();
      if (error.kind === "paraphrased_target") {
        expect(turn?.heard.biased.toLowerCase(), JSON.stringify(error)).not.toContain(
          String(error.wrote).toLowerCase(),
        );
      }
    }
  });

  it("never hold a key or anything shaped like one", () => {
    const files = readUnderstandingCassettes();
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

describe("the understanding eval over all 200 debriefs", () => {
  let labels: ErrorLabels;
  const metrics: Partial<Record<string, UnderstandingMetrics>> = {};

  beforeAll(async () => {
    labels = readErrorLabels();
    const cassettes = readUnderstandingCassettes();
    for (const provider of EVAL_PROVIDERS) {
      const runs: ScriptRun[] = [];
      for (const script of ALL_DEBRIEFS) {
        const cassette = cassettes[provider].cassettes[script.id];
        if (!cassette) throw new Error(`no cassette for ${script.id}`);
        runs.push(await runScript(provider, script, cassette, labels));
      }
      metrics[provider] = understandingMetrics(runs, labels);
    }
  }, 120_000);

  it("misses no request, keeps evidence on everything, and stays under 2% wrong accounts", () => {
    for (const provider of EVAL_PROVIDERS) {
      const found = metrics[provider] as UnderstandingMetrics;
      expect(found.misses, provider).toBe(0);
      expect(found.evidence.rate, provider).toBe(1);
      expect(found.evidence.unquotedLinked, provider).toBe(0);
      expect(found.wrongAccount.rate ?? 0, provider).toBeLessThanOrEqual(0.02);
      expect(found.proposals.expected, provider).toBe(
        ALL_DEBRIEFS.reduce(
          (sum, script) => sum + script.turns.reduce((n, turn) => n + turn.expect.length, 0),
          0,
        ),
      );
    }
  });

  it("scores both adapters alike, since their cassettes carry the same drafts", () => {
    expect(summarize(metrics.groq as UnderstandingMetrics)).toEqual(
      summarize(metrics.anthropic as UnderstandingMetrics),
    );
  });

  it("passes the gate against the committed baseline, which was taken on these scripts and errors", () => {
    const baseline = readBaseline();
    expect(baseline).not.toBeNull();
    expect(baseline?.scriptsSha256).toBe(scriptsSha256());
    expect(baseline?.errorsSha256).toBe(errorsSha256());
    for (const provider of EVAL_PROVIDERS) {
      const found = metrics[provider] as UnderstandingMetrics;
      expect(
        understandingGateFailures(
          provider,
          found,
          baseline?.providers[provider as "anthropic" | "groq"] ?? null,
        ),
      ).toEqual([]);
    }
  });

  it("records every expected risk kind's catch rate in the committed baseline", () => {
    const baseline = readBaseline();
    for (const provider of EVAL_PROVIDERS) {
      expect(Object.keys(baseline?.providers[provider].expectedFlags ?? {}).sort()).toEqual(
        Object.keys(metrics[provider]?.expectedFlags ?? {}).sort(),
      );
    }
  });

  it("keeps the tiers in their budgets, with the interim ceiling where the loud floor puts it", () => {
    for (const provider of EVAL_PROVIDERS) {
      const { tiers } = metrics[provider] as UnderstandingMetrics;
      const floor = tiers.loudFloor.rate ?? 0;
      // The interim ceiling stands only while asks, conflicts, and unsupported values alone are
      // over the spec's 15%: their share plus 2 points, rounded up to a whole percent. When a
      // linker or witness change moves the floor, this fails until the ceiling is set again (or
      // dropped for the 15% budget).
      expect(floor, provider).toBeGreaterThan(LOUD_SHARE_TARGET);
      expect(Math.ceil((floor + 0.02) * 100) / 100, provider).toBe(LOUD_SHARE_INTERIM_CEILING);
      expect(tiers.loud.rate ?? 1, provider).toBeLessThanOrEqual(LOUD_SHARE_INTERIM_CEILING);
      expect(tiers.surfacing, provider).toEqual({ n: 40, of: 40, rate: 1 });
      expect(tiers.surfacing.of, provider).toBe(labels.errors.length);
    }
  });

  it("catches the seeded errors it was built to catch", () => {
    const found = metrics.anthropic as UnderstandingMetrics;
    expect(found.seeded.wrong_date.n).toBe(found.seeded.wrong_date.of);
    expect(found.seeded.wrong_amount.n).toBe(found.seeded.wrong_amount.of);
    expect(found.seeded.paraphrased_target.n).toBe(found.seeded.paraphrased_target.of);
    expect(found.seeded.wrong_date.of).toBe(
      labels.errors.filter((e) => e.kind === "wrong_date").length,
    );
  });

  it("reports every metric the spec lists", () => {
    const markdown = understandingMarkdown(metrics as Record<string, UnderstandingMetrics>, {
      failures: { anthropic: [], groq: [] },
    });
    for (const label of [
      "Key-field accuracy",
      "Proposal precision",
      "Proposal recall",
      "Joint action accuracy",
      "Target accuracy",
      "End-to-end wrong-account rate",
      "Date accuracy",
      "Amount accuracy",
      "Negation accuracy",
      "Evidence coverage",
      "Conflict precision",
      "Conflict recall",
      "Flag share",
      "Proposals by type",
      "Seeded model-like errors",
      "Likely-edit tiers",
      "Loud share",
      "Loud floor",
      "Marked share",
      "Name-note share",
      "Surfacing recall",
      "Precision, loud",
      "Precision, quiet card notes",
      "Precision, the name note alone",
      "Wrong accounts with no marker",
      "By reason",
      "Passes",
    ]) {
      expect(markdown).toContain(label);
    }
  });
});

// --- Arithmetic on hand-built runs -------------------------------------------------------------

const ID = (n: number) => `01a1c6e9-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const EVIDENCE = (start: number, end: number) => ({
  utteranceId: ID(900),
  span: [start, end] as [number, number],
  audioMs: [0, 100] as [number, number],
  confidence: 0.95,
});

function proposal(
  id: number,
  type: ProposalCreatedV2["type"],
  target: Partial<ProposalCreatedV2["target"]>,
  fields: ProposalCreatedV2["fields"] = {},
  flags: ProposalCreatedV2["riskFlags"] = [],
): ProposalCreatedV2 {
  return {
    proposalId: ID(id),
    type,
    target: {
      decision: "none",
      entityId: null,
      kind: null,
      basis: null,
      p: null,
      mention: null,
      company: null,
      candidates: [],
      ...target,
    },
    fields,
    riskFlags: flags,
    supersedes: null,
    linker: "linker.v1",
  };
}

const TEXT = "Bump the Acme deal to forty thousand. I owe Dana the quote by Friday.";
const SCRIPT: DebriefScript = {
  version: 2,
  id: "d999",
  title: "Hand-built",
  voice: "af_heart",
  callTime: "2026-11-16T17:00:00.000Z",
  timeZone: "America/Chicago",
  turns: [
    {
      pauseBeforeMs: 1_500,
      text: TEXT,
      heard: { biased: TEXT, unbiased: TEXT },
      tags: ["negation"],
      expect: [
        {
          type: "deal_update",
          target: { id: "deal_028", decision: "linked" },
          fields: { amount: { value: 40_000, quote: "forty thousand" } },
        },
        {
          type: "task",
          target: { id: "ct_045", decision: "linked" },
          expectFlags: ["witness_conflict"],
          fields: {
            title: { value: "Send Dana the quote", quote: "the quote" },
            dueDate: { value: "2026-11-20", quote: "by Friday" },
          },
        },
      ],
    },
  ],
};

function handRun(final: ProposalCreatedV2[], biased = final): ScriptRun {
  return {
    script: SCRIPT,
    provider: "anthropic",
    turns: [
      {
        drafts: [],
        biased,
        final,
        flagged: [],
        utterances: {
          biased: {
            utteranceId: ID(900),
            text: TEXT,
            confidence: 0.95,
            startMs: 0,
            endMs: 100,
            witness: "biased",
          },
          unbiased: {
            utteranceId: ID(901),
            text: TEXT,
            confidence: 0.9,
            startMs: 0,
            endMs: 100,
            witness: "unbiased",
          },
        },
        misses: 0,
      },
    ],
  };
}

const NO_LABELS: ErrorLabels = {
  version: 1,
  seed: 1,
  rates: { wrong_date: 0, wrong_amount: 0, paraphrased_target: 0 },
  eligible: { wrong_date: 0, wrong_amount: 0, paraphrased_target: 0 },
  errors: [],
};

describe("the metrics' arithmetic", () => {
  const deal = proposal(
    1,
    "deal_update",
    { decision: "linked", entityId: "deal_028" },
    {
      amount: { value: 40_000, evidence: EVIDENCE(22, 36) },
    },
  );
  const task = (
    decision: "linked" | "ask",
    entityId: string | null,
    flags: ProposalCreatedV2["riskFlags"] = [],
  ) =>
    proposal(
      2,
      "task",
      { decision, entityId, candidates: [{ entityId: "ct_045", p: 0.6 }] },
      {
        title: { value: "Send Dana the quote", evidence: EVIDENCE(48, 57) },
        dueDate: { value: "2026-11-20", evidence: EVIDENCE(58, 67) },
      },
      flags,
    );

  it("matches each expected proposal to the first actual one of its type, in order", () => {
    const expected = SCRIPT.turns[0]?.expect ?? [];
    expect(matchTurn(expected, [task("linked", "ct_045"), deal])).toEqual([1, 0]);
    expect(matchTurn(expected, [deal])).toEqual([0, -1]);
    expect(targetMatches(expected[1] as never, task("ask", null))).toBe(false);
  });

  it("counts a right turn, a wrong account, a caught conflict, and the flag share", () => {
    const right = understandingMetrics(
      [handRun([deal, task("linked", "ct_045", [{ kind: "witness_conflict", field: "target" }])])],
      NO_LABELS,
    );
    // The key fields: the deal's amount and the task's due date (a title is free text).
    expect(right.keyFields).toEqual({ n: 2, of: 2, rate: 1 });
    expect(right.jointActions.rate).toBe(1);
    expect(right.negation.rate).toBe(1);
    expect(right.targets).toEqual({ n: 2, of: 2, rate: 1 });
    expect(right.conflicts).toMatchObject({
      expected: 1,
      raised: 1,
      caught: 1,
      precision: 1,
      recall: 1,
    });
    expect(right.flags).toMatchObject({ n: 1, of: 2, rate: 0.5 });
    expect(right.wrongAccount).toMatchObject({ n: 0, of: 2, rate: 0 });

    const wrong = understandingMetrics(
      [handRun([deal, task("linked", "ct_046")], [deal, task("linked", "ct_046")])],
      NO_LABELS,
    );
    expect(wrong.targets.rate).toBe(0.5);
    expect(wrong.jointActions.rate).toBe(0);
    expect(wrong.wrongAccount).toMatchObject({ n: 1, of: 2, rate: 0.5 });
    expect(wrong.wrongAccount.bound).toBeCloseTo(0.9747, 3);
    expect(wrong.conflicts).toMatchObject({
      expected: 1,
      raised: 0,
      caught: 0,
      recall: 0,
      precision: null,
    });

    const missing = understandingMetrics([handRun([deal])], NO_LABELS);
    expect(missing.proposals).toMatchObject({
      expected: 2,
      actual: 1,
      matched: 1,
      precision: 1,
      recall: 0.5,
    });
    expect(missing.keyFields).toEqual({ n: 1, of: 2, rate: 0.5 });
    expect(missing.dates).toEqual({ n: 0, of: 1, rate: 0 });
    expect(missing.amounts).toEqual({ n: 1, of: 1, rate: 1 });
  });

  it("folds a witness downgrade into the proposal, keeping the old target first", () => {
    const linked = task("linked", "ct_045");
    const downgraded = applyFlagged(linked, [
      {
        proposalId: linked.proposalId,
        source: "witness",
        flags: [{ kind: "witness_conflict", field: "target" }],
        target: {
          decision: "ask",
          candidates: [
            { entityId: "ct_045", p: 0.6 },
            { entityId: null, p: 0.4 },
          ],
        },
        conflict: null,
      },
    ]);
    expect(downgraded.target).toMatchObject({ decision: "ask", entityId: null });
    expect(downgraded.target.candidates[0]?.entityId).toBe("ct_045");
    expect(downgraded.riskFlags).toEqual([{ kind: "witness_conflict", field: "target" }]);
    expect(applyFlagged(linked, [])).toBe(linked);
  });
});

describe("the gate", () => {
  const base = understandingMetrics(
    [
      handRun([
        proposal(
          1,
          "deal_update",
          { decision: "linked", entityId: "deal_028" },
          {
            amount: { value: 40_000, evidence: EVIDENCE(22, 36) },
          },
        ),
        proposal(
          2,
          "task",
          { decision: "linked", entityId: "ct_045" },
          {
            title: { value: "Send Dana the quote", evidence: EVIDENCE(48, 57) },
            dueDate: { value: "2026-11-20", evidence: EVIDENCE(58, 67) },
          },
        ),
      ]),
    ],
    NO_LABELS,
  );

  it("fails a key metric more than 3 points down, coverage under 100%, over 2% wrong, or a miss", () => {
    const baseline = summarize(base);
    expect(understandingGateFailures("anthropic", base, baseline)).toEqual([
      // Hand-built runs have no drafts, so no evidence item is backed by a quote.
      expect.stringContaining("G2b"),
    ]);
    const covered = { ...base, evidence: { n: 10, of: 10, rate: 1, unquotedLinked: 0 } };
    expect(understandingGateFailures("anthropic", covered, baseline)).toEqual([]);
    const lower = { ...covered, keyFields: { n: 96, of: 100, rate: 0.96 } };
    expect(
      understandingGateFailures("anthropic", lower, { ...baseline, keyFieldAccuracy: 0.99 }),
    ).toEqual([]);
    expect(
      understandingGateFailures("anthropic", lower, { ...baseline, keyFieldAccuracy: 1 }),
    ).toEqual([expect.stringContaining("keyFieldAccuracy")]);
    const wrong = { ...covered, wrongAccount: { n: 3, of: 100, rate: 0.03, bound: 0.08 } };
    expect(understandingGateFailures("anthropic", wrong, null)).toEqual([
      expect.stringContaining("wrong-account"),
    ]);
    expect(understandingGateFailures("anthropic", { ...covered, misses: 2 }, null)).toEqual([
      expect.stringContaining("regenerate"),
    ]);
    expect(Object.keys(baseline)).toEqual(expect.arrayContaining(Object.keys(KEY_METRICS)));
  });

  it("fails when warnings the scripts expect stop coming, though every value and target stays right", () => {
    const covered = { ...base, evidence: { n: 10, of: 10, rate: 1, unquotedLinked: 0 } };
    const flagged = { ...covered, expectedFlags: { negation: { n: 26, of: 26, rate: 1 } } };
    const baseline = summarize(flagged);
    expect(baseline.expectedFlags).toEqual({ negation: 1 });
    expect(understandingGateFailures("anthropic", flagged, baseline)).toEqual([]);
    // One of 26 lost is 3.8 points; all of them lost, or the kind gone from the report, fails too.
    for (const expectedFlags of [
      { negation: { n: 25, of: 26, rate: 25 / 26 } },
      { negation: { n: 0, of: 26, rate: 0 } },
      {},
    ]) {
      expect(
        understandingGateFailures("anthropic", { ...covered, expectedFlags }, baseline),
      ).toEqual([expect.stringContaining("expected `negation` flags raised")]);
    }
    // The accuracy metrics, which read values and targets only, don't move.
    const silent = { ...covered, expectedFlags: { negation: { n: 0, of: 26, rate: 0 } } };
    expect(KEY_METRICS.negationAccuracy(silent)).toBe(KEY_METRICS.negationAccuracy(flagged));
    expect(KEY_METRICS.jointActionAccuracy(silent)).toBe(KEY_METRICS.jointActionAccuracy(flagged));
  });
});
