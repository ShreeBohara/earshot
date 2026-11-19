// The session a script runs in. Its cassettes are keyed on exactly this, because the extraction
// request carries it: each turn's transcript, the entity list (kind, name, and aliases, in
// order), and the call time to the minute in the rep's time zone. Utterance ids, word timings,
// and confidences never reach the request, so they don't matter.
//
// An e2e run must therefore start each session with `DEMO_SESSION_ENTITIES` and the script's call
// time, or its requests miss the cassettes (`CassetteMissError` names the cause).
import type { EntityKind, EntityRef } from "@earshot/core";
import { companies, contacts, deals } from "@earshot/demo-crm";
import type { DebriefScript, DebriefTurn } from "./schema";

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byName(a: EntityRef, b: EntityRef): number {
  return compare(a.name, b.name) || compare(a.id, b.id);
}

/** Aliases as the session socket takes them: trimmed, distinct ignoring case, not the name. */
function sendableAliases(name: string, aliases: readonly string[]): string[] {
  const seen = new Set([name.toLowerCase()]);
  const out: string[] = [];
  for (const raw of aliases) {
    const alias = raw.trim();
    if (alias === "" || seen.has(alias.toLowerCase())) continue;
    seen.add(alias.toLowerCase());
    out.push(alias);
  }
  return out;
}

function ref(id: string, kind: EntityKind, name: string, aliases: readonly string[]): EntityRef {
  return { id, kind, name: name.trim(), aliases: sendableAliases(name.trim(), aliases) };
}

/**
 * The whole demo CRM as a session's entities, with the demo CRM's own ids: companies, then
 * contacts, then deals, each by name. That's the order `POST /api/sessions` gives a workspace that
 * loaded the demo CRM (one insert, so every row has the same `updated_at`) and picked no account
 * (`rankEntities` and `sessionEntities` in apps/web/lib/voice). All 250 fit `start`'s limits.
 */
export const DEMO_SESSION_ENTITIES: readonly EntityRef[] = [
  ...companies.map((row) => ref(row.id, "company", row.name, row.aliases)).sort(byName),
  ...contacts
    .map((row) => ref(row.id, "contact", `${row.firstName} ${row.lastName}`, []))
    .sort(byName),
  ...deals.map((row) => ref(row.id, "deal", row.name, [])).sort(byName),
];

const ENTITIES_BY_ID: ReadonlyMap<string, EntityRef> = new Map(
  DEMO_SESSION_ENTITIES.map((entity) => [entity.id, entity]),
);

/** A demo CRM record by id, as the session holds it; throws for an id the demo CRM lacks. */
export function demoEntity(id: string): EntityRef {
  const entity = ENTITIES_BY_ID.get(id);
  if (!entity) throw new RangeError(`no demo CRM record ${id}`);
  return entity;
}

/** The company a demo contact or deal belongs to, or the company itself. */
export function demoCompanyOf(id: string): string | undefined {
  if (id.startsWith("co_")) return ENTITIES_BY_ID.has(id) ? id : undefined;
  if (id.startsWith("ct_")) return contacts.find((row) => row.id === id)?.companyId;
  return deals.find((row) => row.id === id)?.companyId;
}

export interface SessionContext {
  readonly entities: readonly EntityRef[];
  /** ISO 8601. The extraction prompt shows it to the minute, in `timeZone`. */
  readonly callTime: string;
  readonly timeZone: string;
}

/** What a script's session must start with for its cassettes to answer. */
export function sessionContext(script: DebriefScript): SessionContext {
  return { entities: DEMO_SESSION_ENTITIES, callTime: script.callTime, timeZone: script.timeZone };
}

/**
 * A turn's transcript as the fake speech-to-text adapter's final carries it, when every word was
 * heard: the text with runs of whitespace as single spaces (`toUtterances` in @earshot/voice).
 */
export function turnTranscript(turn: Pick<DebriefTurn, "text">): string {
  return turn.text.replace(/\s+/g, " ").trim();
}
