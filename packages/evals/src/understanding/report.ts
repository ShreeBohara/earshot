// The understanding report as Markdown (Phase 4 WP10 step 6): the headline metrics per provider,
// proposals by type, the flags, the seeded errors the normalizers caught, the likely-edit tiers
// (Phase 5 WP4), and the gate's verdict.
import { ProposalTypeV2 as ProposalTypes, type ProposalTypeV2 } from "@earshot/core";
import {
  LOUD_ORDER,
  type LoudReasonKind,
  QUIET_ORDER,
  type QuietReasonKind,
} from "@earshot/understanding/tiers";
import { ERROR_KINDS, type ErrorKind } from "./cassettes";
import type { Ratio, UnderstandingMetrics } from "./metrics";
import {
  LOUD_SHARE_INTERIM_CEILING,
  LOUD_SHARE_TARGET,
  MARKED_SHARE_BUDGET,
  SURFACING_RECALL_BUDGET,
} from "./tiers";

const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
const of = (r: Ratio) => `${pct(r.rate)} (${r.n}/${r.of})`;

const ERROR_LABELS: Readonly<Record<ErrorKind, string>> = {
  wrong_date: "Wrong dates, replaced by their words' reading and flagged `value_mismatch`",
  wrong_amount: "Wrong amounts, replaced by their words' reading and flagged `value_mismatch`",
  paraphrased_target: "Paraphrased target quotes, left unlinked and flagged `unsupported`",
};

const LOUD_LABELS: Readonly<Record<LoudReasonKind, string>> = {
  witness_conflict: "The two witnesses heard the words differently",
  ask: "The linker asked which record",
  unsupported: "The words aren't in what was said",
  new_sound_alike: "A new record, with a sound-alike in the CRM",
  ambiguous_value: "The words have two readings",
  value_mismatch: "A value that disagrees with its words, not fixed",
};

const QUIET_LABELS: Readonly<Record<QuietReasonKind, string>> = {
  implied_target: "Open account assumed",
  new_entity: "A new record, nothing like it in the CRM",
  value_corrected: "Corrected from the model's value",
  negation: "Said in a negation",
  low_confidence: "Low transcription confidence",
  weak_support: "Loosely backed by its words",
  date: "Phase 3's date flag",
  number: "Phase 3's number flag",
};

const TYPE_LABELS: Readonly<Record<ProposalTypeV2, string>> = {
  note: "Note",
  task: "Task",
  contact: "Contact",
  deal_update: "Deal update",
  commitment: "Commitment",
  meeting: "Meeting",
};

export interface ReportOptions {
  /** Each provider's gate failures; null when the gate wasn't run. */
  readonly failures?: Readonly<Record<string, readonly string[]>> | null;
  readonly title?: string;
  /** What ran, after the counts: the offline cassettes unless a caller says otherwise (WP11). */
  readonly ran?: string;
  /** Whether to show the seeded errors' catches: a live model's runs have none (WP11). */
  readonly seeded?: boolean;
  /** The gate evidence coverage answers to: G2b here, G2c on a live run (WP11). */
  readonly evidenceGate?: string;
}

const OFFLINE =
  "through each LLM adapter's offline cassettes, linker v1, the normalizers, and the second witness. $0: no model or provider is called.";

/** The report for one or more providers' metrics, side by side. */
export function understandingMarkdown(
  byProvider: Readonly<Record<string, UnderstandingMetrics>>,
  options: ReportOptions = {},
): string {
  const providers = Object.keys(byProvider);
  const first = byProvider[providers[0] ?? ""];
  if (!first) throw new Error("no metrics to report");
  const head = `| Metric | ${providers.join(" | ")} |`;
  const rule = `|---|${providers.map(() => "---").join("|")}|`;
  const row = (label: string, cell: (m: UnderstandingMetrics) => string) =>
    `| ${label} | ${providers.map((provider) => cell(byProvider[provider] as UnderstandingMetrics)).join(" | ")} |`;
  const lines = [
    `## ${options.title ?? "Understanding eval"}`,
    "",
    `${first.scripts} debriefs, ${first.turns} turns, ${first.proposals.expected} expected proposals, ${options.ran ?? OFFLINE}`,
    "",
    head,
    rule,
    row("Key-field accuracy", (m) => of(m.keyFields)),
    row(
      "Proposal precision",
      (m) => `${pct(m.proposals.precision)} (${m.proposals.matched}/${m.proposals.actual})`,
    ),
    row(
      "Proposal recall",
      (m) => `${pct(m.proposals.recall)} (${m.proposals.matched}/${m.proposals.expected})`,
    ),
    row("Proposal F1", (m) => pct(m.proposals.f1)),
    row("Joint action accuracy (turns)", (m) => of(m.jointActions)),
    row("Target accuracy", (m) => of(m.targets)),
    row(
      "End-to-end wrong-account rate",
      (m) => `${of(m.wrongAccount)}, bound ${pct(m.wrongAccount.bound)}`,
    ),
    row(
      "Wrong-account rate, witness off",
      (m) => `${of(m.wrongAccountBiasedOnly)}, bound ${pct(m.wrongAccountBiasedOnly.bound)}`,
    ),
    row("Date accuracy", (m) => of(m.dates)),
    row("Amount accuracy", (m) => of(m.amounts)),
    row("Negation accuracy (turns)", (m) => of(m.negation)),
    row(
      `Evidence coverage (${options.evidenceGate ?? "G2b"})`,
      (m) =>
        `${of(m.evidence)}${m.evidence.unquotedLinked > 0 ? `, ${m.evidence.unquotedLinked} unquoted targets linked` : ""}`,
    ),
    row(
      "Conflict precision",
      (m) => `${pct(m.conflicts.precision)} (${m.conflicts.caught}/${m.conflicts.raised})`,
    ),
    row(
      "Conflict recall",
      (m) => `${pct(m.conflicts.recall)} (${m.conflicts.caught}/${m.conflicts.expected})`,
    ),
    row("Flag share (any flag; the 35% budget is the marked share's)", (m) => of(m.flags)),
    "",
    "### Proposals by type",
    "",
    `| Type | ${providers.map((p) => `${p}: precision, recall`).join(" | ")} |`,
    `|---|${providers.map(() => "---").join("|")}|`,
    ...ProposalTypes.options.map(
      (type) =>
        `| ${TYPE_LABELS[type]} | ${providers
          .map((provider) => {
            const counts = (byProvider[provider] as UnderstandingMetrics).perType[type];
            return `${pct(counts.precision)}, ${pct(counts.recall)} (${counts.matched} of ${counts.expected} expected, ${counts.actual} made)`;
          })
          .join(" | ")} |`,
    ),
    ...(options.seeded === false
      ? []
      : [
          "",
          "### Seeded model-like errors the pipeline caught",
          "",
          `| Error | ${providers.join(" | ")} |`,
          `|---|${providers.map(() => "---").join("|")}|`,
          ...ERROR_KINDS.map((kind) => row(ERROR_LABELS[kind], (m) => of(m.seeded[kind]))),
        ]),
    "",
    "### Likely-edit tiers",
    "",
    "Each final proposal's tier from `tierOf` (`@earshot/understanding/tiers`). Precision is the share the ground truth says needs a choice, an edit, or a rejection.",
    "",
    head,
    rule,
    row(
      `Loud share (budget ${pct(LOUD_SHARE_TARGET)}; gated at the interim ceiling, ${pct(LOUD_SHARE_INTERIM_CEILING)})`,
      (m) => of(m.tiers.loud),
    ),
    row("Loud floor: asks, conflicts, unsupported values", (m) => of(m.tiers.loudFloor)),
    row(`Marked share, loud or a card note (budget ${pct(MARKED_SHARE_BUDGET)})`, (m) =>
      of(m.tiers.marked),
    ),
    row("Name-note share, the name note alone", (m) => of(m.tiers.nameNoteOnly)),
    row(`Surfacing recall, seeded errors marked (budget ${pct(SURFACING_RECALL_BUDGET)})`, (m) =>
      of(m.tiers.surfacing),
    ),
    row("Precision, loud (aim 50%)", (m) => of(m.tiers.precision.loud)),
    row("Precision, quiet card notes", (m) => of(m.tiers.precision.quiet)),
    row("Precision, the name note alone", (m) => of(m.tiers.precision.nameNote)),
    row("Wrong accounts with no marker", (m) => String(m.tiers.hiddenWrongAccounts)),
    "",
    `#### By reason (${providers[0]})`,
    "",
    "| Tier | Reason | Proposals | Share | Precision |",
    "|---|---|---|---|---|",
    ...LOUD_ORDER.flatMap((kind) => {
      const entry = first.tiers.loudKinds[kind];
      return entry
        ? [
            `| Loud | ${LOUD_LABELS[kind]} (\`${kind}\`) | ${entry.of} | ${pct(entry.of / first.tiers.proposals)} | ${of(entry)} |`,
          ]
        : [];
    }),
    ...QUIET_ORDER.flatMap((kind) => {
      const count = first.tiers.quietKinds[kind];
      return count === undefined
        ? []
        : [
            `| Quiet | ${QUIET_LABELS[kind]} (\`${kind}\`) | ${count} | ${pct(count / first.tiers.proposals)} | |`,
          ];
    }),
    "",
    `### Flags (${providers[0]})`,
    "",
    "Proposals carrying each kind, after the second witness; and for the kinds the scripts expect, how many of the expected ones came.",
    "",
    "| Flag | Proposals | Expected, raised |",
    "|---|---|---|",
    ...Object.entries(first.flags.byKind).map(
      ([kind, count]) =>
        `| \`${kind}\` | ${count} | ${(() => {
          const expected = first.expectedFlags[kind as keyof typeof first.expectedFlags];
          return expected ? of(expected) : "";
        })()} |`,
    ),
  ];
  for (const [kind, expected] of Object.entries(first.expectedFlags)) {
    if (first.flags.byKind[kind as keyof typeof first.flags.byKind] === undefined) {
      lines.push(`| \`${kind}\` | 0 | ${of(expected)} |`);
    }
  }
  if (options.failures) {
    const all = Object.entries(options.failures).flatMap(([, failures]) => failures);
    lines.push("", "### Gate", "");
    if (all.length === 0) {
      lines.push(
        `Passes: evidence coverage 100%, the end-to-end wrong-account rate at most 2%, no key metric or expected flag's catch rate more than 3 points below \`baselines/understanding.json\`, loud on at most ${pct(LOUD_SHARE_INTERIM_CEILING)} of proposals (the interim ceiling; the budget is ${pct(LOUD_SHARE_TARGET)}), a card marker on at most ${pct(MARKED_SHARE_BUDGET)}, and at least ${pct(SURFACING_RECALL_BUDGET)} of the seeded errors marked.`,
      );
    } else lines.push(...all.map((failure) => `- **${failure}**`));
  }
  return lines.join("\n");
}
