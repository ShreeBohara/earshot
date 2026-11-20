// The scripted reviewer's pure parts (Phase 5 spec WP8, gates G1a and G2a; ADR-0039): its oracle,
// read from pilot.v1's manifest and never from the page; the keys each kind of decision may take;
// the keys-per-decision distribution; the flag-follower bound; and the report it writes. The
// reviewer itself is apps/web/e2e/pilot/scripted-reviewer.spec.ts, which drives /pilot?p=ci by
// keyboard on a fake clock.
import {
  DecisionKind,
  KLM,
  KLM_BASELINE_PATH,
  KLM_MEDIAN_TARGET_MS,
  type KlmCard,
  type KlmCheck,
} from "./klm";
import type { PilotManifest, SeededError } from "./set";

export const DECISION_KINDS: readonly DecisionKind[] = DecisionKind.options;

/**
 * The most keys each kind of decision may take (spec WP8 step 2, gate G1a; targets): 2 to accept,
 * reject, or choose in a question, and 3 to choose another record for a link. Moving between
 * cards counts, if a decision needs it: focus moves on by itself after each one, so none does.
 */
export const KEY_BUDGET: Readonly<Record<DecisionKind, number>> = {
  accept: 2,
  reject: 2,
  question: 2,
  another_record: 3,
};

/** The digits a card numbers its choices with: 1 to 4 (the inbox's `MAX_CHOICES`). */
export const CHOICE_KEYS = 4;

/** One decision the reviewer made, with every key it pressed for it. */
export interface Decision {
  readonly proposalId: string;
  readonly decision: DecisionKind;
  readonly keys: readonly string[];
}

/**
 * A seeded card's right answer and the keys that give it, from the manifest alone:
 * - **flagged:** "New" in the card's question: its digit is its place among the question's
 *   records, as the manifest lists them;
 * - **silent:** c, then the right record's digit in the correction panel, which numbers the
 *   link's records in the linker's order.
 * `choice` is the 0-based place the page must show the answer at; the reviewer checks it there
 * before pressing its digit.
 */
export type OracleAnswer =
  | {
      readonly kind: "flagged";
      readonly decision: "question";
      readonly keys: readonly [string];
      readonly choice: number;
      readonly right: null;
    }
  | {
      readonly kind: "silent";
      readonly decision: "another_record";
      readonly keys: readonly ["c", string];
      readonly choice: number;
      readonly right: string;
    };

function answerOf(error: SeededError): OracleAnswer {
  if (error.kind === "flagged") {
    const choice = error.candidates.findIndex((candidate) => candidate.entityId === null);
    if (choice < 0 || choice >= CHOICE_KEYS) {
      throw new RangeError(`${error.proposalId}: "New" isn't on a digit (${choice + 1})`);
    }
    return {
      kind: "flagged",
      decision: "question",
      keys: [String(choice + 1)],
      choice,
      right: null,
    };
  }
  const records = error.candidates.filter((candidate) => candidate.entityId !== null);
  const choice = records.findIndex((candidate) => candidate.entityId === error.right.entityId);
  // The panel numbers three records, then "New".
  if (choice < 0 || choice >= CHOICE_KEYS - 1) {
    throw new RangeError(`${error.proposalId}: the right record isn't on a digit (${choice + 1})`);
  }
  return {
    kind: "silent",
    decision: "another_record",
    keys: ["c", String(choice + 1)],
    choice,
    right: error.right.entityId,
  };
}

/** The oracle: every seeded card's answer, by proposal id. Cards it doesn't hold are accepted. */
export function pilotOracle(
  manifest: Pick<PilotManifest, "seeded">,
): ReadonlyMap<string, OracleAnswer> {
  return new Map(manifest.seeded.map((error) => [error.proposalId, answerOf(error)]));
}

/** Decisions that took more keys than their kind may, one line each; empty when none did. */
export function overBudget(decisions: readonly Decision[]): string[] {
  return decisions.flatMap((d) =>
    d.keys.length > KEY_BUDGET[d.decision]
      ? [
          `${d.proposalId}: ${d.keys.length} keys (${d.keys.join(" ")}) to ${d.decision.replace("_", " ")}, over its ${KEY_BUDGET[d.decision]}.`,
        ]
      : [],
  );
}

/** How many decisions of each kind took each number of keys. */
export function keyDistribution(
  decisions: readonly Decision[],
): ReadonlyMap<DecisionKind, ReadonlyMap<number, number>> {
  const by = new Map<DecisionKind, Map<number, number>>();
  for (const d of decisions) {
    const counts = by.get(d.decision) ?? new Map<number, number>();
    counts.set(d.keys.length, (counts.get(d.keys.length) ?? 0) + 1);
    by.set(d.decision, counts);
  }
  return by;
}

/**
 * The flag-follower bound (spec WP8 step 3): a reviewer who accepts everything unmarked or quiet,
 * and stops only at loud cards, catches at most the seeded errors whose cards are loud: 4 of 8 by
 * design, since the silent errors carry only the quiet name note. The gate (G2b) needs people who
 * notice quiet notes, which is what the pilot measures.
 */
export function flagFollowerBound(cards: readonly Pick<KlmCard, "tier" | "seeded">[]): {
  readonly caught: number;
  readonly of: number;
} {
  const seeded = cards.filter((card) => card.seeded !== null);
  return { caught: seeded.filter((card) => card.tier === "loud").length, of: seeded.length };
}

// ─── The report ───────────────────────────────────────────────────────────────────────────────────

export interface ReviewerReport {
  readonly manifest: Pick<PilotManifest, "set" | "sha256">;
  /** The 40 cards, in the order they were decided. */
  readonly cards: readonly KlmCard[];
  readonly klm: KlmCheck;
  /** Whether this run recorded the baseline instead of checking against it. */
  readonly recorded: boolean;
  /** Every decision, the practice's included. */
  readonly decisions: readonly Decision[];
  /** The keys pressed in all, and what held focus after the last one. */
  readonly focus: { readonly keys: number; readonly last: string };
  /**
   * The page's own review clock: on how many of the 40 its `handlingMs` was the card's estimate,
   * and `pilot:analyze`'s median over the run's results file.
   */
  readonly clock: { readonly exact: number; readonly analyzedMedianMs: number | null };
  /** Which Playwright attempt wrote this (a retry writes again). */
  readonly attempt: number;
}

function s(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

const KIND_WORDS: Readonly<Record<DecisionKind, string>> = {
  accept: "Accept",
  reject: "Reject",
  question: "Choose in a question",
  another_record: "Choose another record for a link",
};

/** The scripted reviewer's report, as markdown: for the run's output and CI's step summary. */
export function reviewerMarkdown(report: ReviewerReport): string {
  const { cards, klm, manifest } = report;
  const bound = flagFollowerBound(cards);
  const distribution = keyDistribution(report.decisions);
  const budget = overBudget(report.decisions);
  const counts = (kind: DecisionKind) =>
    [...(distribution.get(kind) ?? new Map<number, number>()).entries()]
      .sort(([a], [b]) => a - b)
      .map(([keys, n]) => `${n} with ${keys} ${keys === 1 ? "key" : "keys"}`)
      .join(", ") || "none";
  const seededFlagged = cards.filter((card) => card.seeded === "flagged");
  const seededSilent = cards.filter((card) => card.seeded === "silent");
  const lines = [
    `## The scripted reviewer: ${manifest.set} at $0 (gates G1a and G2a)`,
    "",
    `\`/pilot?p=ci\` by keyboard on a fake clock, with the manifest's right answers (set SHA-256 \`${manifest.sha256.slice(0, 12)}…\`)${report.attempt > 0 ? `; attempt ${report.attempt + 1}` : ""}.`,
    "",
    "### The KLM estimate per card (G1a)",
    "",
    `M ${KLM.mentalS} s + words ÷ ${KLM.readWps} a second on a loud card, or ÷ ${KLM.scanWps} on any other, + ${KLM.keyS} s a key; words are the card's visible words when its deciding key is pressed, not counting its buttons or key labels.`,
    "",
    `- **Median: ${s(klm.medianMs)}.** The ${s(KLM_MEDIAN_TARGET_MS)} target: **${klm.targetMet ? "met" : "not met"}**.${klm.targetMet ? "" : ` Until it is, the median is held at the baseline's ${s(klm.ceilingMs)}.`}`,
    `- **Slowest card:** ${klm.max ? `${s(klm.max.ms)}, ${klm.max.session}'s ${klm.max.heading} (${klm.max.tier}, ${klm.max.words} words, ${klm.max.keys.length} ${klm.max.keys.length === 1 ? "key" : "keys"})` : "—"}.`,
    report.recorded
      ? `- **Baseline:** recorded by this run to \`${KLM_BASELINE_PATH}\`. Review the diff, then commit it.`
      : `- **No card more than 10% above \`${KLM_BASELINE_PATH}\`:** ${klm.problems.length === 0 ? "yes" : "no"}.`,
    "",
    "### Keys per decision (G1a)",
    "",
    "| Decision | Budget | Keys |",
    "|---|---|---|",
    ...DECISION_KINDS.map(
      (kind) => `| ${KIND_WORDS[kind]} | at most ${KEY_BUDGET[kind]} | ${counts(kind)} |`,
    ),
    "",
    `Every decision within its budget: **${budget.length === 0 ? "yes" : "no"}** (${report.decisions.length} decisions, the practice's ${report.decisions.length - cards.length} included).`,
    "",
    "### Markers and the flag-follower bound (G2a)",
    "",
    `- Every seeded error shows its marker, in the accessibility tree and on screen: ${seededFlagged.length} flagged, each loud ("needs a check" in its description); ${seededSilent.length} silent, each with "matched by sound" in its name.`,
    `- **The flag-follower bound:** a reviewer who accepts everything unmarked or quiet catches only the loud seeded errors: **${bound.caught} of ${bound.of}**. The gate needs people who notice quiet notes; the pilot measures that.`,
    "",
    "### Focus and the review clock",
    "",
    `- Focus never fell to \`<body>\` in ${report.focus.keys} key presses; after the last decision it was on "${report.focus.last}".`,
    `- The page's review clock recorded each card's estimate as its \`handlingMs\` on ${report.clock.exact} of ${cards.length} cards; \`pilot:analyze\` on the run's results file gives a median of ${report.clock.analyzedMedianMs === null ? "—" : `${report.clock.analyzedMedianMs.toLocaleString("en-US")} ms`}.`,
    "",
    "### The 40 cards, as decided",
    "",
    "| # | Session | Card | Tier | Seeded | Keys | Words | Estimate | Baseline |",
    "|---|---|---|---|---|---|---|---|---|",
    ...cards.map((card, index) => {
      const was = klm.against.get(card.proposalId);
      return `| ${index + 1} | ${card.session} | ${card.heading} | ${card.tier} | ${card.seeded ?? "—"} | ${card.keys.join(" ")} | ${card.words} | ${s(card.ms)} | ${was === undefined || was === null ? "—" : s(was)} |`;
    }),
  ];
  const problems = [...klm.problems, ...budget];
  if (problems.length > 0) {
    lines.push("", "### Problems", "", ...problems.map((problem) => `- ${problem}`));
  }
  return lines.join("\n");
}
