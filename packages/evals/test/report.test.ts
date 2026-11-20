import { describe, expect, it } from "vitest";
import {
  baselineFrom,
  DEBRIEFS,
  EvalBaseline,
  type EvalReport,
  type EvalScriptResult,
  latencyStats,
  mergeReports,
  percentile,
  reportMarkdown,
  scriptPassed,
} from "../src";

const ALL = DEBRIEFS.map((script) => script.id);
const AT = "2026-12-01T12:00:00.000Z";
const SOURCE = { recordedAt: AT, commit: "abc123", run: null };

function result(script: string, totals: number[], overrides: Partial<EvalScriptResult> = {}) {
  return {
    script,
    mode: "ci",
    stt: "fake/fake",
    llm: "anthropic/claude-haiku-5-5",
    wavs: "kokoro",
    wav: "0".repeat(32),
    durationMs: 20_000,
    audioProcessing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    onsetMs: 25,
    peakRms: 0.4,
    retry: 0,
    turns: totals.map((totalMs, index) => ({
      index,
      expected: 1,
      outcome: "proposals",
      proposals: 1,
      transcript: "x",
      pressLateMs: 0,
      latency: {
        totalMs,
        speechEndToFinalMs: totalMs / 4,
        finalToProposalMs: totalMs / 2,
        proposalToPaintMs: totalMs / 4,
      },
      problems: [],
    })),
    problems: [],
    ...overrides,
  } satisfies EvalScriptResult;
}

const report = (results: EvalScriptResult[]): EvalReport => ({
  version: 1,
  createdAt: AT,
  results,
});

describe("percentile (nearest rank)", () => {
  it("takes the smallest value with at least p% of values at or below it", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 100)).toBe(100);
    // Unsorted input, and ranks that round up: ceil(0.95 × 10) = 10th, ceil(0.5 × 10) = 5th.
    const ten = [900, 100, 800, 200, 700, 300, 600, 400, 500, 1000];
    expect(percentile(ten, 95)).toBe(1000);
    expect(percentile(ten, 50)).toBe(500);
    expect(percentile([7, 3], 50)).toBe(3);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 50)).toBeNull();
    // Always a value that was measured, never an interpolation.
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

describe("latencyStats", () => {
  it("pools every measured turn across scripts, per stage", () => {
    const stats = latencyStats([result("d001", [100, 300]), result("d002", [200, 400, 1000])]);
    expect(stats.totalMs).toEqual({ turns: 5, p50: 300, p95: 1000, max: 1000 });
    expect(stats.finalToProposalMs).toEqual({ turns: 5, p50: 150, p95: 500, max: 500 });
  });

  it("skips turns with no measurement, and says so when there are none", () => {
    const quiet = result("d001", [100]);
    const none = { ...quiet, turns: quiet.turns.map((turn) => ({ ...turn, latency: null })) };
    expect(latencyStats([none]).totalMs).toEqual({ turns: 0, p50: null, p95: null, max: null });
  });
});

describe("mergeReports", () => {
  it("joins shards in script order, and refuses a script run twice", () => {
    const merged = mergeReports(
      [report([result("d003", [1])]), report([result("d001", [1]), result("d002", [1])])],
      AT,
    );
    expect(merged.results.map((entry) => entry.script)).toEqual(["d001", "d002", "d003"]);
    expect(() =>
      mergeReports([report([result("d001", [1])]), report([result("d001", [2])])], AT),
    ).toThrow(/d001 fake\/fake \+ anthropic\/claude-haiku-5-5 is in more than one report/);
  });
});

describe("baselineFrom", () => {
  const whole = report(ALL.map((id, n) => result(id, [100 + n, 200 + n])));

  it("records each stage's p50, p95, and max from a whole, passing Kokoro run", () => {
    const baseline = baselineFrom(whole, "ci", ALL, SOURCE);
    expect(EvalBaseline.parse(baseline)).toEqual(baseline);
    expect(baseline).toMatchObject({ kind: "ci", commit: "abc123", recordedAt: AT });
    expect(baseline.pairs).toHaveLength(1);
    expect(baseline.pairs[0]).toMatchObject({
      stt: "fake/fake",
      scripts: 30,
      scriptsPassed: 30,
      turnsMeasured: 60,
    });
    // 60 values: 100..129 and 200..229. p50 is the 30th (129), p95 the 57th (226).
    expect(baseline.pairs[0]?.stages.totalMs).toEqual({ turns: 60, p50: 129, p95: 226, max: 229 });
  });

  it("refuses stub WAVs, a partial run, a failure, or a live run, for CI", () => {
    const stub = report(whole.results.map((entry) => ({ ...entry, wavs: "stub" as const })));
    expect(() => baselineFrom(stub, "ci", ALL, SOURCE)).toThrow(/--stub WAVs/);
    expect(() => baselineFrom(report(whole.results.slice(1)), "ci", ALL, SOURCE)).toThrow(
      /lacks d001/,
    );
    const failed = report(
      whole.results.map((entry, n) => (n === 2 ? { ...entry, problems: ["no audio"] } : entry)),
    );
    expect(() => baselineFrom(failed, "ci", ALL, SOURCE)).toThrow(/d003 failed/);
    expect(() => baselineFrom(whole, "live", ALL, SOURCE)).toThrow(/wasn't live/);
    expect(() => baselineFrom(report([]), "ci", ALL, SOURCE)).toThrow(/no results/);
  });

  it("records a live run per pair, failures included, but never from stub WAVs", () => {
    const live = (llm: string, totals: number[], problems: string[] = []) =>
      result("d001", totals, {
        mode: "live",
        stt: "assemblyai/universal-streaming-english",
        llm,
        problems,
      });
    const baseline = baselineFrom(
      report([
        live("groq/openai/gpt-oss-20b", [900, 1100]),
        live("anthropic/claude-haiku-5-5", [1500], ["x"]),
      ]),
      "live",
      ALL,
      SOURCE,
    );
    expect(
      baseline.pairs.map((pair) => [pair.llm, pair.scriptsPassed, pair.stages.totalMs.p95]),
    ).toEqual([
      ["groq/openai/gpt-oss-20b", 1, 1100],
      ["anthropic/claude-haiku-5-5", 0, 1500],
    ]);
  });
});

describe("reportMarkdown", () => {
  it("leads with the verdict, flags stub WAVs, and compares with the baseline", () => {
    const passing = result("d001", [100, 300]);
    const failing = result("d002", [500], {
      turns: [
        { ...passing.turns[0], index: 0, problems: ["made 0 proposals, not 1"] },
      ] as EvalScriptResult["turns"],
    });
    expect(scriptPassed(passing)).toBe(true);
    expect(scriptPassed(failing)).toBe(false);
    const whole = report(ALL.map((id) => result(id, [100])));
    const baseline = baselineFrom(whole, "ci", ALL, SOURCE);
    const markdown = reportMarkdown(report([passing, failing]), {
      title: "Fake-mic eval",
      baseline,
    });
    expect(markdown).toContain("### Fake-mic eval: 1 of 2 scripts as scripted");
    expect(markdown).toContain("2 of 3 turns as scripted. WAVs: Kokoro.");
    expect(markdown).toContain(
      "| End of speech → card painted | 3 | 100 (+0) | 300 (+200) | 300 |",
    );
    expect(markdown).toContain("turn 1 made 0 proposals, not 1");
    expect(markdown).toContain("was on in 2 of 2 runs");
    const stub = reportMarkdown(report([{ ...passing, wavs: "stub" }]), { title: "Eval" });
    expect(stub).toContain("not an evaluation");
    expect(stub).toContain("No baseline to compare with yet.");
  });
});
