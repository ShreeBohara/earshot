// The linking eval's report as Markdown, for the terminal and a GitHub job summary: the headline
// metrics with the witness on and off, then one row per class (spec WP3 step 4).
import type { LinkingMetrics, LinkingReport } from "./metrics";
import { CLASS_EXPECT, CLASS_LABELS, ITEM_CLASSES } from "./schema";

const pct = (value: number | null, digits = 1) =>
  value === null ? "n/a" : `${(value * 100).toFixed(digits)}%`;
const num = (value: number | null) => (value === null ? "n/a" : value.toFixed(3));
const of = (count: number, total: number) => `${count}/${total}`;

function headline(metrics: LinkingMetrics, witness: boolean): string[] {
  return [
    `${pct(metrics.coverage)} (${of(metrics.decided, metrics.items)})`,
    `${pct(metrics.wrongAccountRate)} (${of(metrics.wrongLinks, metrics.decided)})`,
    pct(metrics.bound),
    `${pct(metrics.newWhenExistingRate)} (${of(metrics.newWhenExisting, metrics.decided)})`,
    `${pct(metrics.accuracyOnDecided)} (${of(metrics.correct, metrics.decided)})`,
    num(metrics.aurc),
    num(metrics.ece),
    witness ? pct(metrics.divergenceRecall) : "n/a (no witness)",
    `${pct(metrics.hiddenErrorRate)} (${of(metrics.hiddenErrors, metrics.decided)})`,
  ];
}

const ROWS = [
  "Coverage",
  "Wrong-account rate",
  "Wrong-account bound (95%, one-sided)",
  "New-when-existing",
  "Accuracy on decided",
  "AURC (wrong-account risk)",
  "ECE (links, 10 equal-mass bins)",
  "Divergence recall",
  "Hidden error rate",
];

export interface LinkingMarkdownOptions {
  /** G1's failures, when the gate applies to this linker; null when it doesn't. */
  readonly gate?: readonly string[] | null;
  /** Regression failures against the baseline, or null when there's no baseline. */
  readonly regressions?: readonly string[] | null;
}

export function linkingMarkdown(
  report: LinkingReport,
  options: LinkingMarkdownOptions = {},
): string {
  const lines: string[] = [];
  lines.push(
    `### Linking eval: ${report.linker} on ${report.set}, ${report.split} split (${report.final.items} items)`,
    "",
    "| Metric | Final | Biased only |",
    "|---|---|---|",
  );
  const final = headline(report.final, report.witness);
  const biased = headline(report.biasedOnly, false);
  ROWS.forEach((row, index) => {
    lines.push(`| ${row} | ${final[index]} | ${biased[index]} |`);
  });
  lines.push(
    "",
    "| Class | What it is | Items | Best | Decided | Coverage | Wrong links | New when existing | Accuracy on decided | As expected |",
    "|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const itemClass of ITEM_CLASSES) {
    const metrics = report.perClass[itemClass];
    if (metrics.items === 0) continue;
    lines.push(
      `| ${itemClass} | ${CLASS_LABELS[itemClass]} | ${metrics.items} | ${CLASS_EXPECT[itemClass]} | ${metrics.decided} | ${pct(metrics.coverage)} | ${metrics.wrongLinks} | ${metrics.newWhenExisting} | ${pct(metrics.accuracyOnDecided)} | ${pct(metrics.asExpected / metrics.items)} |`,
    );
  }
  const curve = report.riskCoverage.filter((point) => point.threshold > 0 && point.threshold < 1);
  if (report.reliability.length > 0 || curve.some((point) => point.coverage > 0)) {
    lines.push(
      "",
      `Risk–coverage (final, links admitted at p ≥ τ): ${curve
        .map((point) => `τ ${point.threshold}: ${pct(point.coverage)} at ${pct(point.risk)}`)
        .join("; ")}.`,
    );
  }
  if (report.reliability.length > 0) {
    lines.push("", "| Bin | Links | p range | Mean p | Accuracy |", "|---|---|---|---|---|");
    report.reliability.forEach((bin, index) => {
      lines.push(
        `| ${index + 1} | ${bin.count} | ${bin.pMin.toFixed(3)}–${bin.pMax.toFixed(3)} | ${bin.meanP.toFixed(3)} | ${pct(bin.accuracy)} |`,
      );
    });
  }
  if (options.gate !== undefined) {
    lines.push("");
    if (options.gate === null)
      lines.push("G1 doesn't apply to this linker (a reference baseline).");
    else if (options.gate.length === 0) lines.push("G1: pass.");
    else lines.push(...options.gate.map((failure) => `- ${failure}`));
  }
  if (options.regressions !== undefined) {
    lines.push("");
    if (options.regressions === null) lines.push("No baseline to compare with.");
    else if (options.regressions.length === 0) lines.push("No regression against the baseline.");
    else lines.push(...options.regressions.map((failure) => `- ${failure}`));
  }
  return lines.join("\n");
}
