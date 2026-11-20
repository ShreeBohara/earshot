// The pilot set in words (Phase 5 spec WP7): what `pilot:gen` prints, for the person reviewing a
// rebuild. Its sessions, its seeded errors with their right answers, its tier mix, and the orders.
import { companies, contacts, deals } from "@earshot/demo-crm";
import type { PilotManifest, TierCounts } from "./set";

const NAMES: ReadonlyMap<string, string> = new Map([
  ...companies.map((row) => [row.id, row.name] as const),
  ...contacts.map((row) => [row.id, `${row.firstName} ${row.lastName}`] as const),
  ...deals.map((row) => [row.id, row.name] as const),
]);

/** A demo CRM record by name and id, or "a new record". */
export function recordWords(entityId: string | null): string {
  if (entityId === null) return "a new record";
  return `${NAMES.get(entityId) ?? "?"} (${entityId})`;
}

function percent(n: number, of: number): string {
  return of === 0 ? "—" : `${((100 * n) / of).toFixed(1)}%`;
}

function tierRow(name: string, counts: TierCounts): string {
  const { proposals, loud, quiet, nameNote, none } = counts;
  const cell = (n: number) => `${n} (${percent(n, proposals)})`;
  return `| ${name} | ${proposals} | ${cell(loud)} | ${cell(quiet)} | ${cell(nameNote)} | ${cell(none)} |`;
}

export function pilotSetMarkdown(manifest: PilotManifest): string {
  const lines = [
    `## ${manifest.set}`,
    "",
    `SHA-256: \`${manifest.sha256}\``,
    "",
    "### Sessions",
    "",
    "| Session | Script | Proposals | Seeded |",
    "|---|---|---|---|",
    ...manifest.sessions.map((session) => {
      const seeded = manifest.seeded
        .filter((error) => error.session === session.id)
        .map((error) => error.kind);
      return `| ${session.id} | ${session.script} | ${session.proposals.length} | ${seeded.join(", ") || "—"} |`;
    }),
    `| practice | ${manifest.practice.script} | ${manifest.practice.proposals.length} | — |`,
    "",
    "### Seeded wrong accounts",
    "",
    "| Session | Kind | Where | Shown | Right answer |",
    "|---|---|---|---|---|",
    ...manifest.seeded.map((error) => {
      const where = `${error.script}, turn ${error.turn + 1}, proposal ${error.index + 1}`;
      const shown =
        error.kind === "flagged"
          ? `a question, ${recordWords(error.snapped)} first`
          : `${recordWords(error.shown)}, by sound, p ${error.p.toFixed(3)}`;
      return `| ${error.session} | ${error.kind} | ${where} | ${shown} | ${recordWords(error.right.entityId)} or a rejection |`;
    }),
    "",
    "### Tier mix, as built (never tuned)",
    "",
    "| Cards | Proposals | Loud | Quiet (card note) | Name note only | None |",
    "|---|---|---|---|---|---|",
    tierRow("All 40", manifest.tiers.all),
    tierRow("Seeded 8", manifest.tiers.seeded),
    tierRow("Other 32", manifest.tiers.other),
    tierRow("Practice", manifest.tiers.practice),
    "",
    "### Orders",
    "",
    "| Participant | Order |",
    "|---|---|",
    ...Object.entries(manifest.orders).map(
      ([participant, order]) =>
        `| ${participant === "ci" ? "ci" : `P${participant}`} | ${order.join(" ")} |`,
    ),
  ];
  return lines.join("\n");
}
