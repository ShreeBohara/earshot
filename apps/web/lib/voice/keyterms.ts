// Keyterms (spec WP3 step 4): the CRM names a session primes its speech-to-text provider with, so
// "Okafor" isn't heard as "okay for". Also the order the session's entities come in. Pure: the
// route loads the workspace's CRM rows inside withTenant and passes them in.
import { containsKeyShape, type EntityKind } from "@earshot/core";
import type { SessionKeyterms } from "./types";

/** One `crm_entities` row, as the session routes read it. */
export type CrmEntity = {
  id: string;
  kind: EntityKind;
  name: string;
  aliases: readonly string[];
  /** The CRM connection the row came from: null for the demo CRM and rows typed in by hand. */
  connectionId: string | null;
  /** The record's id in its source: `external_id`, without the demo CRM's `demo:` prefix. */
  sourceId: string;
  /** For contacts and deals, the source id of their company (`properties.companyId`). */
  companyId: string | null;
  updatedAt: Date;
};

export type RankedEntities = {
  /** The selected account, when it's a company among the rows: the session's open account. */
  account: CrmEntity | null;
  /**
   * Where keyterms come from, best first: the selected account, its contacts, its deals, then
   * the other companies, most recently updated first. Calendar attendees and recent mentions
   * join in Phase 7.
   */
  keytermSources: readonly CrmEntity[];
  /**
   * What the session may mention, best first: the keyterm sources, then the other contacts and
   * then the other deals, most recently updated first. Extraction links proposals only to these,
   * and the transcript underlines only these.
   */
  all: readonly CrmEntity[];
};

/**
 * Orders a workspace's CRM rows for a session. A contact or deal belongs to the selected account
 * when it comes from the same connection and its `companyId` is the account's source id. A
 * `selectedAccountId` that isn't a company among the rows is ignored, so a stale selection never
 * stops a session from starting. Ties go to the name, then the id, so the order is stable.
 */
export function rankEntities(
  rows: readonly CrmEntity[],
  selectedAccountId?: string | null,
): RankedEntities {
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  const account = selectedAccountId
    ? unique.find((row) => row.id === selectedAccountId && row.kind === "company")
    : undefined;
  const belongsToAccount = (row: CrmEntity) =>
    account !== undefined &&
    row.connectionId === account.connectionId &&
    row.companyId === account.sourceId;
  const ofKind = (kind: EntityKind, include: (row: CrmEntity) => boolean) =>
    unique.filter((row) => row.kind === kind && include(row)).sort(byRecency);

  const keytermSources = [
    ...(account ? [account] : []),
    ...ofKind("contact", belongsToAccount),
    ...ofKind("deal", belongsToAccount),
    ...ofKind("company", (row) => row !== account),
  ];
  const ranked = new Set(keytermSources);
  const all = [
    ...keytermSources,
    ...ofKind("contact", (row) => !ranked.has(row)),
    ...ofKind("deal", (row) => !ranked.has(row)),
  ];
  return { account: account ?? null, keytermSources, all };
}

function byRecency(a: CrmEntity, b: CrmEntity): number {
  return (
    b.updatedAt.getTime() - a.updatedAt.getTime() || compare(a.name, b.name) || compare(a.id, b.id)
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Each provider's keyterm limits. */
export const KEYTERM_LIMITS = {
  /** `keyterms_prompt`: at most 100 terms of at most 50 characters each. */
  assemblyai: { maxTerms: 100, maxTermChars: 50 },
  /**
   * `keyterm`: 500 tokens in all, and "up to 100" terms, though Deepgram's docs advise 20 to 50.
   * How Deepgram counts tokens isn't documented, so each term is charged a conservative estimate
   * (`estimateKeytermTokens`) against the 500. The 50-character cap is Earshot's, not
   * Deepgram's: a longer term is a phrase rather than a name, and would spend a fifth of the
   * budget on its own.
   */
  deepgram: { maxTerms: 50, maxTermChars: 50, maxTokens: 500 },
} as const;

/** Shorter terms (in code points) bias recognition without helping it. */
export const MIN_KEYTERM_CHARS = 2;

/**
 * A conservative guess at what one keyterm costs Deepgram: a token per two bytes of UTF-8, plus
 * one for the boundary. Tokenizers average three to four characters a token on English text, and
 * names tokenize worse, so this overestimates on purpose. Settle the real rule in WP1.
 */
export function estimateKeytermTokens(term: string): number {
  return Math.ceil(new TextEncoder().encode(term).byteLength / 2) + 1;
}

/**
 * The keyterms for each provider, from sources in rank order, cleaned and deduplicated ignoring
 * case, then trimmed to the provider's limits. A term that doesn't fit (over 50 characters, or
 * over Deepgram's remaining token budget) is skipped, and later, smaller terms can still fill the
 * list.
 *
 * The order is fair to every company (Phase 4 WP8). The selected account's family comes first,
 * each record's name and then its aliases, as before. Then every other company's name, and only
 * then their aliases. Before, each company brought its aliases along, so with no account open
 * the demo CRM's 60 companies and their 68 aliases ran past AssemblyAI's 100 terms at "Summit
 * Ridge Capital": every company after it, alphabetically, was never boosted at all, "Willowbrook
 * Pharma" among them. Now all 60 names fit, and the first 40 aliases. `familyCount` says how many
 * sources are the account's family: the account, its contacts, and its deals; none without one.
 */
export function sessionKeyterms(
  sources: readonly Pick<CrmEntity, "name" | "aliases">[],
  familyCount = 0,
): SessionKeyterms {
  const terms = candidateTerms(sources, familyCount);
  const { assemblyai: aai, deepgram: dg } = KEYTERM_LIMITS;
  const assemblyai = terms.filter((term) => term.length <= aai.maxTermChars).slice(0, aai.maxTerms);
  const deepgram: string[] = [];
  let tokens = 0;
  for (const term of terms) {
    if (deepgram.length === dg.maxTerms) break;
    const cost = estimateKeytermTokens(term);
    if (term.length > dg.maxTermChars || tokens + cost > dg.maxTokens) continue;
    deepgram.push(term);
    tokens += cost;
  }
  return { assemblyai, deepgram };
}

/**
 * Every term in order: the first `familyCount` sources' names and aliases together, then the rest's
 * names, then the rest's aliases.
 */
function candidateTerms(
  sources: readonly Pick<CrmEntity, "name" | "aliases">[],
  familyCount: number,
): string[] {
  const family = sources.slice(0, familyCount);
  const rest = sources.slice(familyCount);
  const ordered = [
    ...family.flatMap(({ name, aliases }) => [name, ...aliases]),
    ...rest.map(({ name }) => name),
    ...rest.flatMap(({ aliases }) => aliases),
  ];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of ordered) {
    const term = cleanTerm(raw);
    if (term === undefined) continue;
    const folded = term.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    terms.push(term);
  }
  return terms;
}

/** How many of `keytermSources` are the selected account's family: it, its contacts, its deals. */
export function accountFamilyCount(ranked: RankedEntities): number {
  if (!ranked.account) return 0;
  const { account } = ranked;
  return ranked.keytermSources.filter(
    (row) =>
      row === account ||
      (row.kind !== "company" &&
        row.connectionId === account.connectionId &&
        row.companyId === account.sourceId),
  ).length;
}

/** A name as a keyterm: NFC, single spaces, trimmed; or undefined if it can't be one. */
function cleanTerm(raw: string): string | undefined {
  const term = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if ([...term].length < MIN_KEYTERM_CHARS) return undefined;
  if (hasControlCharacter(term) || containsKeyShape(term)) return undefined;
  return term;
}

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
