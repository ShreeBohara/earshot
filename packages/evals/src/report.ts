// The fake-microphone eval's results, report, and baselines (spec WP11 step 6, gate G1a).
//
// Each script's run becomes an `EvalScriptResult`; a Playwright run (one shard) writes them as an
// `EvalReport`, and CI merges the shards' reports into one, for the job summary and an artifact.
// Latency comes from `turn.measured`, which SessionDO writes from the client's marks: end of
// speech (the release) to the last final, to the first proposal, to its card's paint.
//
// `baselines/ci.json` is written on purpose, never by CI itself: `pnpm --filter @earshot/evals
// baseline:update <report.json>` takes a whole, passing run on Kokoro WAVs and refuses anything
// else. Its numbers come from `next dev` with fakes and cassettes, so they track the pipeline's
// own overhead, not the latency a rep feels: that's the live run's (G1b).
import { TurnOutcome } from "@earshot/core";
import { z } from "zod";

export const EVAL_REPORT_VERSION = 1;
export const BASELINE_VERSION = 1;

/** `turn.measured`'s stages, the gate's number first. */
export const LATENCY_STAGES = [
  "totalMs",
  "speechEndToFinalMs",
  "finalToProposalMs",
  "proposalToPaintMs",
] as const;
export type LatencyStage = (typeof LATENCY_STAGES)[number];

export const STAGE_LABELS: Readonly<Record<LatencyStage, string>> = {
  totalMs: "End of speech → card painted",
  speechEndToFinalMs: "End of speech → last final",
  finalToProposalMs: "Last final → proposal",
  proposalToPaintMs: "Proposal → card painted",
};

const Ms = z.number().nonnegative();

export const TurnLatencySchema = z.strictObject({
  totalMs: Ms,
  speechEndToFinalMs: Ms,
  finalToProposalMs: Ms,
  proposalToPaintMs: Ms,
});

export const EvalTurnResult = z.strictObject({
  index: z.int().nonnegative(),
  /** Proposals the script expects. */
  expected: z.int().nonnegative(),
  /** Null when the turn never completed. */
  outcome: TurnOutcome.nullable(),
  proposals: z.int().nonnegative(),
  transcript: z.string().nullable(),
  /** How long after its scheduled time the press went down: the engine wasn't ready, say. */
  pressLateMs: z.number(),
  latency: TurnLatencySchema.nullable(),
  problems: z.array(z.string()),
});
export type EvalTurnResult = z.infer<typeof EvalTurnResult>;

const AudioProcessing = z.strictObject({
  echoCancellation: z.boolean().nullable(),
  noiseSuppression: z.boolean().nullable(),
  autoGainControl: z.boolean().nullable(),
});

export const EvalScriptResult = z.strictObject({
  script: z.string().regex(/^d\d{3}$/),
  /** `ci`: the fake speech-to-text adapter and cassettes. `live`: real providers. */
  mode: z.enum(["ci", "live"]),
  /** `provider/model`. */
  stt: z.string().min(1),
  llm: z.string().min(1),
  /** What the fake microphone played: Kokoro speech, or `--stub` tones (not an evaluation). */
  wavs: z.enum(["kokoro", "stub"]),
  wav: z.string().regex(/^[0-9a-f]{32}$/),
  durationMs: z.int().positive(),
  /** The captured track's settings: Chromium advises audio processing off for injected files. */
  audioProcessing: AudioProcessing.nullable(),
  /**
   * When the first turn's speech reached the page (an AnalyserNode on the captured track), in ms
   * after timing.json says it starts, counting from getUserMedia. Null if it was never heard.
   */
  onsetMs: z.number().nullable(),
  /** The loudest RMS the AnalyserNode saw. */
  peakRms: z.number().nonnegative().nullable(),
  retry: z.int().nonnegative(),
  turns: z.array(EvalTurnResult),
  /** Problems with the run as a whole (the page, the audio), apart from any turn's. */
  problems: z.array(z.string()),
});
export type EvalScriptResult = z.infer<typeof EvalScriptResult>;

export const EvalReport = z.strictObject({
  version: z.literal(EVAL_REPORT_VERSION),
  createdAt: z.iso.datetime(),
  results: z.array(EvalScriptResult),
});
export type EvalReport = z.infer<typeof EvalReport>;

export function scriptPassed(result: EvalScriptResult): boolean {
  return result.problems.length === 0 && result.turns.every((turn) => turn.problems.length === 0);
}

/**
 * The nearest-rank percentile: the smallest value with at least p% of the values at or below
 * it. No interpolation, so it's always a value that was measured. Null for no values.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!(p > 0 && p <= 100)) throw new RangeError(`a percentile is in (0, 100], not ${p}`);
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

export interface StageStats {
  readonly turns: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

export type LatencyStats = Readonly<Record<LatencyStage, StageStats>>;

/** p50, p95, and max of each stage, over every turn that has a measurement. */
export function latencyStats(results: readonly EvalScriptResult[]): LatencyStats {
  const latencies = results.flatMap((result) =>
    result.turns.flatMap((turn) => (turn.latency ? [turn.latency] : [])),
  );
  const stats = {} as Record<LatencyStage, StageStats>;
  for (const stage of LATENCY_STAGES) {
    const values = latencies.map((latency) => latency[stage]);
    stats[stage] = {
      turns: values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: values.length > 0 ? Math.max(...values) : null,
    };
  }
  return stats;
}

/** A provider pair, as results and baselines name it. */
export const pairOf = (result: Pick<EvalScriptResult, "stt" | "llm">) =>
  `${result.stt} + ${result.llm}`;

/** One report from many (CI's shards). A script run twice for the same pair is a mistake. */
export function mergeReports(reports: readonly EvalReport[], createdAt: string): EvalReport {
  const seen = new Set<string>();
  const results: EvalScriptResult[] = [];
  for (const report of reports) {
    for (const result of report.results) {
      const key = `${result.script} ${pairOf(result)}`;
      if (seen.has(key)) throw new Error(`${key} is in more than one report`);
      seen.add(key);
      results.push(result);
    }
  }
  results.sort((a, b) => a.script.localeCompare(b.script) || pairOf(a).localeCompare(pairOf(b)));
  return { version: EVAL_REPORT_VERSION, createdAt, results };
}

const StageBaseline = z.strictObject({
  turns: z.int().nonnegative(),
  p50: Ms,
  p95: Ms,
  max: Ms,
});

const PairBaseline = z.strictObject({
  stt: z.string().min(1),
  llm: z.string().min(1),
  scripts: z.int().positive(),
  scriptsPassed: z.int().nonnegative(),
  turnsMeasured: z.int().nonnegative(),
  stages: z.strictObject({
    totalMs: StageBaseline,
    speechEndToFinalMs: StageBaseline,
    finalToProposalMs: StageBaseline,
    proposalToPaintMs: StageBaseline,
  }),
});

/** `baselines/ci.json` (one pair: the fakes) or `baselines/live-<date>.json` (one per pair). */
export const EvalBaseline = z.strictObject({
  version: z.literal(BASELINE_VERSION),
  kind: z.enum(["ci", "live"]),
  recordedAt: z.iso.datetime(),
  /** The commit the run was on, and the run itself, when known. */
  commit: z.string().nullable(),
  run: z.string().nullable(),
  pairs: z.array(PairBaseline).min(1),
});
export type EvalBaseline = z.infer<typeof EvalBaseline>;

export interface BaselineSource {
  readonly recordedAt: string;
  readonly commit: string | null;
  readonly run: string | null;
}

/**
 * A baseline from a report. A CI baseline must come from a whole run: every script in
 * `allScripts`, all passing, on Kokoro WAVs. A live baseline records whatever the run measured,
 * passes and failures alike, but never from stub WAVs either.
 */
export function baselineFrom(
  report: EvalReport,
  kind: "ci" | "live",
  allScripts: readonly string[],
  source: BaselineSource,
): EvalBaseline {
  const refuse = (why: string) => {
    throw new Error(`refusing to write a ${kind} baseline: ${why}`);
  };
  if (report.results.length === 0) refuse("the report has no results");
  if (report.results.some((result) => result.wavs !== "kokoro")) {
    refuse("it has results from --stub WAVs, which are tones, not speech");
  }
  if (report.results.some((result) => result.mode !== kind)) {
    refuse(`it has results from a run that wasn't ${kind}`);
  }
  const groups = new Map<string, EvalScriptResult[]>();
  for (const result of report.results) {
    const group = groups.get(pairOf(result)) ?? [];
    group.push(result);
    groups.set(pairOf(result), group);
  }
  if (kind === "ci") {
    if (groups.size !== 1) refuse(`a CI run has one provider pair, not ${groups.size}`);
    const ran = new Set(report.results.map((result) => result.script));
    const missing = allScripts.filter((script) => !ran.has(script));
    if (missing.length > 0) refuse(`it lacks ${missing.join(", ")}`);
    const failed = report.results.filter((result) => !scriptPassed(result));
    if (failed.length > 0) refuse(`${failed.map((result) => result.script).join(", ")} failed`);
  }
  const pairs = [...groups.values()].map((results) => {
    const first = results[0] as EvalScriptResult;
    const stats = latencyStats(results);
    const stages = {} as Record<LatencyStage, z.infer<typeof StageBaseline>>;
    for (const stage of LATENCY_STAGES) {
      const { turns, p50, p95, max } = stats[stage];
      if (p50 === null || p95 === null || max === null) {
        refuse(`${pairOf(first)} measured no turns`);
      }
      stages[stage] = { turns, p50: p50 ?? 0, p95: p95 ?? 0, max: max ?? 0 };
    }
    return {
      stt: first.stt,
      llm: first.llm,
      scripts: results.length,
      scriptsPassed: results.filter(scriptPassed).length,
      turnsMeasured: stats.totalMs.turns,
      stages,
    };
  });
  return EvalBaseline.parse({ version: BASELINE_VERSION, kind, ...source, pairs });
}

const fmtMs = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? "–" : `${Math.round(ms)}`;

function delta(now: number | null, then: number | undefined): string {
  if (now === null || then === undefined) return "";
  const diff = Math.round(now - then);
  return ` (${diff >= 0 ? "+" : ""}${diff})`;
}

function cell(text: string): string {
  // Backslashes first, so an escaped pipe can't be undone by a backslash already in the text.
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

export interface ReportMarkdownOptions {
  readonly title: string;
  /** Compared stage by stage, when there's one for the same pair. */
  readonly baseline?: EvalBaseline | null;
}

/** The report as Markdown, for a GitHub job summary. */
export function reportMarkdown(report: EvalReport, options: ReportMarkdownOptions): string {
  const { results } = report;
  const passed = results.filter(scriptPassed).length;
  const lines = [`### ${options.title}: ${passed} of ${results.length} scripts as scripted`, ""];
  if (results.length === 0) return [...lines, "No results.", ""].join("\n");

  const turns = results.flatMap((result) => result.turns);
  const okTurns = turns.filter((turn) => turn.problems.length === 0).length;
  const stub = results.some((result) => result.wavs === "stub");
  lines.push(
    `${okTurns} of ${turns.length} turns as scripted. WAVs: ${
      stub ? "**`--stub` tones, not speech: not an evaluation**" : "Kokoro"
    }.`,
    "",
  );

  const groups = new Map<string, EvalScriptResult[]>();
  for (const result of results) {
    groups.set(pairOf(result), [...(groups.get(pairOf(result)) ?? []), result]);
  }
  for (const [pair, group] of groups) {
    const stats = latencyStats(group);
    const base = options.baseline?.pairs.find((entry) => `${entry.stt} + ${entry.llm}` === pair);
    lines.push(
      `**${pair}**${base ? " (deltas against the baseline)" : ""}`,
      "",
      "| Stage, ms | Turns | p50 | p95 | Max |",
      "|---|---|---|---|---|",
    );
    for (const stage of LATENCY_STAGES) {
      const { turns: n, p50, p95, max } = stats[stage];
      const then = base?.stages[stage];
      lines.push(
        `| ${STAGE_LABELS[stage]} | ${n} | ${fmtMs(p50)}${delta(p50, then?.p50)} | ${fmtMs(p95)}${delta(p95, then?.p95)} | ${fmtMs(max)} |`,
      );
    }
    lines.push("");
  }
  if (!options.baseline) lines.push("No baseline to compare with yet.", "");

  const processing = results.filter((result) => {
    const settings = result.audioProcessing;
    return settings?.echoCancellation || settings?.noiseSuppression || settings?.autoGainControl;
  }).length;
  const onsets = results.flatMap((result) => (result.onsetMs === null ? [] : [result.onsetMs]));
  lines.push(
    `The browser's audio processing (echo cancellation, noise suppression, or auto gain) was on in ${processing} of ${results.length} runs.`,
    onsets.length > 0
      ? `The first turn's speech reached the page a median ${fmtMs(percentile(onsets, 50))} ms after timing.json's start (counting from getUserMedia; ${onsets.length} runs).`
      : "The first turn's speech was never heard on the page.",
    "",
    "| Script | Pair | Turns as scripted | Max end of speech → card, ms | Latest press, ms | Problems |",
    "|---|---|---|---|---|---|",
  );
  for (const result of results) {
    const ok = result.turns.filter((turn) => turn.problems.length === 0).length;
    const totals = result.turns.flatMap((turn) => (turn.latency ? [turn.latency.totalMs] : []));
    const late = Math.max(0, ...result.turns.map((turn) => turn.pressLateMs));
    const problems = [
      ...result.problems,
      ...result.turns.flatMap((turn) =>
        turn.problems.map((problem) => `turn ${turn.index + 1} ${problem}`),
      ),
    ];
    lines.push(
      `| ${result.script} | ${cell(pairOf(result))} | ${ok} of ${result.turns.length} | ${fmtMs(
        totals.length > 0 ? Math.max(...totals) : null,
      )} | ${fmtMs(late)} | ${cell(problems.slice(0, 3).join("; ") || "–")}${
        problems.length > 3 ? ` (+${problems.length - 3} more)` : ""
      } |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
