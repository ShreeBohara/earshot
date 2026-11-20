// `pilot:analyze` (Phase 5 spec WP7 step 3, gates G1b and G2b): the analysis
// docs/pilot/pre-registration.md fixes, run as is on the participants' results files, as markdown.
//
// - **Review time (primary).** Each participant's median `handlingMs` over their single-mode
//   decisions (approvals, edits, and rejections, not reopens), then the median of those medians,
//   with their minimum and maximum. Under 4,000 ms meets G1b. A participant with fewer than 30
//   decisions (cards whose final state is a decision) is reported but left out of the medians.
// - **Secondary.** The pooled 90th percentile of `handlingMs` (nearest rank) for loud cards and
//   for the rest, by the tier each review says the card showed (`seen.tier`), over every
//   participant: the pre-registration leaves short sessions out of the medians only. The share of
//   decided cards whose decision came from "accept all", and the time per batch, each batch
//   counted once by its `batchId`, from its approvals; a batch's undo writes zero-time reopens
//   under the same id, which never count.
// - **Catch rate (G2b).** Final decisions count: a flagged error is caught when it ends "New" (an
//   approval with a null record) or rejected; a silent one when it ends with the right record or
//   rejected. Anything else, an undecided card included, is a miss. Pooled as x of 8 per
//   participant (40 for five), with a two-sided 95% Clopper–Pearson interval; at least 90% as a
//   point estimate meets G2b. Also each participant's count, flagged and silent separately,
//   errors caught only after an accept that missed them ("caught after accepting"), and the
//   flag-follower bound: 4 of 8.
// - **Checks.** A file for another set, or that isn't a results file, is left out and said so; an
//   order other than the manifest's for that participant, practice reviews (ignored), and reviews
//   of cards outside the set are reported as deviations.
import type { ProposalReviewedV2 } from "@earshot/core";
import {
  orderKey,
  PILOT_FLAGGED,
  PILOT_SILENT,
  type PilotManifest,
  PilotResults,
  type SeededError,
} from "./set";
import { clopperPearson, median, nearestRank } from "./stats";

/** The pre-registered thresholds. */
export const MEDIAN_THRESHOLD_MS = 4_000;
export const CATCH_THRESHOLD = 0.9;
/** Fewer decisions than this, and a participant is left out of the medians. */
export const MIN_DECISIONS = 30;
/** The pooled percentile reported for loud cards and the rest. */
export const POOLED_QUANTILE = 0.9;

export interface ResultsFile {
  readonly name: string;
  readonly text: string;
}

export interface Catch {
  readonly error: SeededError;
  readonly caught: boolean;
  /** Caught at the end, after an approval or edit that would have missed it. */
  readonly afterAccepting: boolean;
}

export interface ParticipantAnalysis {
  readonly file: string;
  readonly participant: string;
  /** The order the file says it ran, and whether it's the manifest's for this participant. */
  readonly order: readonly string[];
  readonly orderMatches: boolean;
  /** Cards whose final state is a decision (approved, edited, or rejected). */
  readonly decisions: number;
  /** `handlingMs` of each single-mode decision, in order. */
  readonly single: readonly number[];
  readonly median: number | null;
  readonly included: boolean;
  /** Each single decision's time, by the tier the card showed. */
  readonly loud: readonly number[];
  readonly rest: readonly number[];
  /** Cards whose final decision came from "accept all". */
  readonly batchDecided: number;
  /** Each batch once: its size (its approvals) and its own time. */
  readonly batches: readonly {
    readonly batchId: string;
    readonly size: number;
    readonly ms: number;
  }[];
  readonly catches: readonly Catch[];
  readonly practice: number;
  /** Reviews of proposals the set doesn't hold: ignored, and reported. */
  readonly strays: number;
}

export interface PilotAnalysis {
  readonly set: string;
  readonly sha256: string;
  readonly participants: readonly ParticipantAnalysis[];
  /** Files left out, with why. */
  readonly rejected: readonly { readonly file: string; readonly reason: string }[];
}

/** Reads one results file, or says why it isn't one for this set. */
export function readResultsFile(
  file: ResultsFile,
  manifest: PilotManifest,
): { ok: true; results: PilotResults } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(file.text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  const parsed = PilotResults.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `not a pilot results file (${issue?.path.join(".") || "the file"}: ${issue?.message ?? "invalid"})`,
    };
  }
  if (parsed.data.setSha256 !== manifest.sha256) {
    return { ok: false, reason: `from another set (SHA-256 ${parsed.data.setSha256})` };
  }
  return { ok: true, results: parsed.data };
}

const decides = (review: ProposalReviewedV2) =>
  review.decision === "approved" || review.decision === "edited";

/** Whether a final review catches a seeded error. */
function catches(error: SeededError, review: ProposalReviewedV2 | undefined): boolean {
  if (!review) return false;
  if (review.decision === "rejected") return true;
  if (!decides(review)) return false;
  // A linked card accepted as it stands keeps its record; a question needs one chosen.
  const chosen =
    review.target === null
      ? error.kind === "silent"
        ? error.shown
        : undefined
      : review.target.entityId;
  return chosen === error.right.entityId;
}

/** One participant's file, analyzed against the manifest. */
export function analyzeParticipant(
  file: string,
  results: PilotResults,
  manifest: PilotManifest,
): ParticipantAnalysis {
  const inSet = new Set(manifest.sessions.flatMap((session) => session.proposals));
  const tierOf = new Map(manifest.tiers.proposals.map((p) => [p.proposalId, p.tier]));
  const final = new Map<string, ProposalReviewedV2>();
  const everAccepted = new Map<string, ProposalReviewedV2[]>();
  const single: number[] = [];
  const loud: number[] = [];
  const rest: number[] = [];
  const batches = new Map<string, { batchId: string; size: number; ms: number }>();
  let strays = 0;
  for (const review of results.reviews) {
    if (!inSet.has(review.proposalId)) {
      strays++;
      continue;
    }
    if (review.decision === "reopened") {
      final.delete(review.proposalId);
      continue;
    }
    final.set(review.proposalId, review);
    if (decides(review)) {
      everAccepted.set(review.proposalId, [...(everAccepted.get(review.proposalId) ?? []), review]);
    }
    if (review.mode === "single") {
      const ms = review.timing.handlingMs;
      single.push(ms);
      const tier = review.seen?.tier ?? tierOf.get(review.proposalId) ?? "none";
      (tier === "loud" ? loud : rest).push(ms);
    } else if (review.mode === "batch" && review.decision === "approved" && review.batchId) {
      const batch = batches.get(review.batchId);
      if (batch) batch.size++;
      else
        batches.set(review.batchId, {
          batchId: review.batchId,
          size: 1,
          ms: review.timing.handlingMs,
        });
    }
  }
  const decisions = final.size;
  const key = orderKey(results.participant);
  const assigned = key ? manifest.orders[key] : null;
  const caught = manifest.seeded.map((error): Catch => {
    const end = final.get(error.proposalId);
    const ok = catches(error, end);
    const missedBefore = (everAccepted.get(error.proposalId) ?? []).some(
      (review) => review !== end && !catches(error, review),
    );
    return { error, caught: ok, afterAccepting: ok && missedBefore };
  });
  return {
    file,
    participant: results.participant,
    order: results.order,
    orderMatches: assigned !== null && assigned.join(" ") === results.order.join(" "),
    decisions,
    single,
    median: median(single),
    included: decisions >= MIN_DECISIONS,
    loud,
    rest,
    batchDecided: [...final.values()].filter((review) => review.mode === "batch").length,
    batches: [...batches.values()],
    catches: caught,
    practice: results.practice.length,
    strays,
  };
}

/** The whole analysis: every file read, the ones for this set analyzed, the rest said why. */
export function analyzePilot(
  files: readonly ResultsFile[],
  manifest: PilotManifest,
): PilotAnalysis {
  const participants: ParticipantAnalysis[] = [];
  const rejected: { file: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const read = readResultsFile(file, manifest);
    if (!read.ok) {
      rejected.push({ file: file.name, reason: read.reason });
      continue;
    }
    if (seen.has(read.results.participant)) {
      rejected.push({ file: file.name, reason: `a second file for ${read.results.participant}` });
      continue;
    }
    seen.add(read.results.participant);
    participants.push(analyzeParticipant(file.name, read.results, manifest));
  }
  participants.sort((a, b) => a.participant.localeCompare(b.participant));
  return { set: manifest.set, sha256: manifest.sha256, participants, rejected };
}

// ─── Markdown ──────────────────────────────────────────────────────────────────────────────────

function ms(value: number | null): string {
  return value === null ? "—" : `${Math.round(value).toLocaleString("en-US")} ms`;
}

function pct(value: number): string {
  return `${(100 * value).toFixed(1)}%`;
}

function rate(k: number, n: number): string {
  if (n === 0) return "none to count";
  const { lower, upper } = clopperPearson(k, n);
  return `${k} of ${n} (${pct(k / n)}; 95% Clopper–Pearson ${pct(lower)}–${pct(upper)})`;
}

function count(catches: readonly Catch[], kind?: SeededError["kind"]): number {
  return catches.filter((c) => c.caught && (kind === undefined || c.error.kind === kind)).length;
}

/** The analysis as markdown: the report `pilot:analyze` prints. */
export function pilotAnalysisMarkdown(analysis: PilotAnalysis): string {
  const { participants } = analysis;
  const included = participants.filter((p) => p.included);
  const medians = included.flatMap((p) => (p.median === null ? [] : [p.median]));
  const overall = median(medians);
  const lines: string[] = [
    `# Pilot results: ${analysis.set}`,
    "",
    `Set \`${analysis.set}\`, SHA-256 \`${analysis.sha256}\`. ${participants.length} results ${participants.length === 1 ? "file" : "files"} analyzed with \`pilot:analyze\`, as docs/pilot/pre-registration.md fixes it.`,
    "",
    "## Review time (primary measure, gate G1b)",
    "",
    "| Participant | Decisions | Single-mode decisions | Median `handlingMs` | In the medians |",
    "|---|---|---|---|---|",
    ...participants.map(
      (p) =>
        `| ${p.participant} | ${p.decisions} | ${p.single.length} | ${ms(p.median)} | ${p.included ? "yes" : `no: fewer than ${MIN_DECISIONS} decisions`} |`,
    ),
    "",
  ];
  if (overall === null) {
    lines.push("**No participant's median to take the median of.**");
  } else {
    lines.push(
      `**Median of the participants' medians: ${ms(overall)}** (min ${ms(Math.min(...medians))}, max ${ms(Math.max(...medians))}; n = ${medians.length}). Under ${MEDIAN_THRESHOLD_MS.toLocaleString("en-US")} ms: **${overall < MEDIAN_THRESHOLD_MS ? "yes" : "no"}**.`,
    );
    if (medians.length === 5) {
      lines.push(
        "",
        "For five independent participants, [min, max] covers the population median with probability 93.75%.",
      );
    }
  }

  const loud = participants.flatMap((p) => p.loud);
  const rest = participants.flatMap((p) => p.rest);
  const decided = participants.reduce((sum, p) => sum + p.decisions, 0);
  const batchDecided = participants.reduce((sum, p) => sum + p.batchDecided, 0);
  const batchTimes = participants.flatMap((p) => p.batches.map((batch) => batch.ms));
  lines.push(
    "",
    "## Secondary measures",
    "",
    `- **Pooled 90th percentile of \`handlingMs\`** (nearest rank, every participant's single-mode decisions, by the tier each card showed): loud cards ${ms(nearestRank(loud, POOLED_QUANTILE))} (n = ${loud.length}); the rest ${ms(nearestRank(rest, POOLED_QUANTILE))} (n = ${rest.length}).`,
    `- **Decided in a batch:** ${batchDecided} of ${decided} decided cards (${decided === 0 ? "—" : pct(batchDecided / decided)}) ended with an "accept all" approval, in ${batchTimes.length} ${batchTimes.length === 1 ? "batch" : "batches"}. Time per batch, each batch once by its \`batchId\`: ${batchTimes.length === 0 ? "—" : `median ${ms(median(batchTimes))} (min ${ms(Math.min(...batchTimes))}, max ${ms(Math.max(...batchTimes))})`}.`,
  );

  const allCatches = participants.flatMap((p) => p.catches);
  const n = allCatches.length;
  const caught = count(allCatches);
  const flaggedN = allCatches.filter((c) => c.error.kind === "flagged").length;
  const silentN = n - flaggedN;
  const after = allCatches.filter((c) => c.afterAccepting).length;
  lines.push(
    "",
    "## Catch rate (gate G2b)",
    "",
    n === 0
      ? "**No seeded errors to count.**"
      : `**Caught: ${rate(caught, n)}.** At least ${pct(CATCH_THRESHOLD)} as a point estimate: **${caught / n >= CATCH_THRESHOLD ? "yes" : "no"}**.`,
    "",
    `- Flagged: ${rate(count(allCatches, "flagged"), flaggedN)}.`,
    `- Silent: ${rate(count(allCatches, "silent"), silentN)}.`,
    `- Caught after accepting: ${after} (counted as caught: final decisions count).`,
    `- The flag-follower bound: a reviewer who accepts everything unmarked or quiet catches only the flagged errors, ${PILOT_FLAGGED} of ${PILOT_FLAGGED + PILOT_SILENT} per participant${participants.length > 0 ? `, ${PILOT_FLAGGED * participants.length} of ${n} pooled` : ""}.`,
    "- With 40 seeded errors the interval's lower end clears 90% only with no misses at all (40 of 40 gives 91.2–100%), so at the threshold the result is a point estimate, not a bound.",
    "",
    "| Participant | Caught | Flagged | Silent | Caught after accepting |",
    "|---|---|---|---|---|",
    ...participants.map(
      (p) =>
        `| ${p.participant} | ${count(p.catches)} of ${p.catches.length} | ${count(p.catches, "flagged")} of ${PILOT_FLAGGED} | ${count(p.catches, "silent")} of ${PILOT_SILENT} | ${p.catches.filter((c) => c.afterAccepting).length} |`,
    ),
  );

  const deviations: string[] = [];
  for (const p of participants) {
    if (!p.orderMatches) {
      deviations.push(
        `${p.participant} ran the sessions in an order other than the manifest's for them: ${p.order.join(" ")}.`,
      );
    }
    if (p.strays > 0)
      deviations.push(
        `${p.participant}'s file holds ${p.strays} reviews of cards outside the set (ignored).`,
      );
  }
  for (const r of analysis.rejected) deviations.push(`Left out \`${r.file}\`: ${r.reason}.`);
  const practice = participants.map((p) => `${p.participant} ${p.practice}`).join(", ");
  lines.push(
    "",
    "## Checks and deviations",
    "",
    ...(deviations.length > 0 ? deviations.map((d) => `- ${d}`) : ["- None found in the files."]),
    `- Practice reviews, kept apart and not analyzed: ${practice || "none"}.`,
  );
  return lines.join("\n");
}
