// The recap eval's report: per provider, the gate's checks, then what's reported without a
// threshold (the drop rate, weak support, the lens, and the cost per recap). Numbers only: never
// a sentence, a quote, or a transcript.
import type { RecapMetrics } from "./eval";

const pct = (rate: number | null) => (rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`);
const frac = (count: { n: number; of: number; rate: number | null }) =>
  `${count.n} of ${count.of} (${pct(count.rate)})`;

export interface RecapReportOptions {
  /** The gate's failures, per provider. */
  readonly failures: Readonly<Record<string, readonly string[]>>;
}

export function recapMarkdown(
  metrics: Readonly<Record<string, RecapMetrics>>,
  options: RecapReportOptions,
): string {
  const providers = Object.keys(metrics);
  const row = (label: string, value: (m: RecapMetrics) => string) =>
    `| ${label} | ${providers.map((provider) => value(metrics[provider] as RecapMetrics)).join(" | ")} |`;
  const failures = providers.flatMap((provider) => options.failures[provider] ?? []);
  const lines = [
    "### Recap eval (all 200 debriefs, offline cassettes)",
    "",
    failures.length === 0
      ? "**Pass.** Every kept sentence carries evidence, every seeded bad sentence was dropped, and every recap has a headline."
      : `**Fail.** ${failures.length} ${failures.length === 1 ? "check failed" : "checks failed"}:`,
    ...failures.map((failure) => `- ${failure}`),
    "",
    `| | ${providers.join(" | ")} |`,
    `|---|${providers.map(() => "---").join("|")}|`,
    row("Recaps created", (m) => `${m.created} of ${m.recaps}`),
    row("Kept sentences with evidence (gate: 100%)", (m) => frac(m.evidence)),
    row("Seeded bad sentences dropped (gate: all)", (m) => frac(m.badDropped)),
    row("Recaps with a headline (gate: all)", (m) => frac(m.headlines)),
    row("Ground-truth sentences kept (gate: all)", (m) => frac(m.goodKept)),
    row("Invented lens quotes not mentioned (gate: all)", (m) => frac(m.badLensUnmentioned)),
    row("Sentences written", (m) => String(m.written)),
    row("Dropped (no located quote)", (m) => frac(m.dropped)),
    row("Extra headlines left out", (m) => String(m.extraHeadlines)),
    row("Weak support among kept", (m) => frac(m.weakSupport)),
    row("Lens fields mentioned", (m) => frac(m.lensMentioned)),
    row("Cost per recap (cassette usage)", (m) => `$${m.usage.costPerRecapUsd.toFixed(6)}`),
    row("Cassette misses", (m) => String(m.misses)),
  ];
  return lines.join("\n");
}
