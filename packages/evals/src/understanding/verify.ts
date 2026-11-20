// Eval harness v1's checks on the ground truth itself (Phase 4 WP10 step 4), extending
// src/verify.ts's: every quote is a substring of what the production stream heard, every date,
// time, and amount is re-derived from its words with the evals' own resolvers, and every target
// of a generated script resolves by construction, under the confusable set's oracle, with the
// context the session had at that point in the debrief.
//
// `groundTruthProblems` returns what's wrong with a script in words; empty when nothing is. The
// generator's test runs it over all 200 scripts.
import { TARGET_KINDS } from "@earshot/agent";
import { fieldKind } from "@earshot/understanding/faithfulness";
import { normalizeName } from "@earshot/understanding/names";
import { showsDisfluency } from "../grammar/disfluency";
import { linkedCompanyOf, nextRecent } from "../grammar/mentions";
import { hasLinkingEntity, linkingEntity } from "../linking/entities";
import { resolve } from "../linking/oracle";
import {
  type DebriefScript,
  type DebriefTurn,
  type ExpectedProposal,
  expectedFields,
  namedOf,
} from "../schema";
import {
  CORRECTION_MARKER,
  NEGATION_PATTERN,
  parseUsd,
  resolveDatePhrase,
  resolveTimePhrase,
} from "../verify";

const DATE_FIELDS = new Set(["dueDate", "closeDate", "date"]);
/** The flags a target's label implies: each decision but "linked" by words has its own. */
const TARGET_FLAGS: ReadonlySet<string> = new Set([
  "new_entity",
  "ambiguous_target",
  "witness_conflict",
  "implied_target",
]);

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text.charAt(i) !== " ") continue;
    if (i > start) out.push({ text: text.slice(start, i), start, end: i });
    start = i + 1;
  }
  return out;
}

/** Index pairs of a longest common subsequence of two token lists (exact token equality). */
function lcsPairs(a: readonly Token[], b: readonly Token[]): [number, number][] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Array<number>(rows * cols).fill(0);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i]?.text === b[j]?.text
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]?.text === b[j]?.text) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) i++;
    else j++;
  }
  return pairs;
}

/**
 * What the second witness heard where the production stream heard `quote`: the unbiased words
 * between the nearest words both transcripts share on either side of it. The two transcripts of a
 * generated turn differ only at names and amounts, so the shared words are anchors. Null when
 * the quote isn't in the biased text, or nothing was heard there.
 */
export function unbiasedReadingOf(biased: string, unbiased: string, quote: string): string | null {
  const start = biased.indexOf(quote);
  if (start < 0) return null;
  const end = start + quote.length;
  const b = tokens(biased);
  const u = tokens(unbiased);
  const first = b.findIndex((token) => token.end > start);
  let last = first;
  while (last + 1 < b.length && (b[last + 1] as Token).start < end) last++;
  if (first < 0) return null;
  let from = 0;
  let to = u.length;
  for (const [bi, ui] of lcsPairs(b, u)) {
    if (bi < first) from = ui + 1;
    else if (bi > last && to === u.length) to = ui;
  }
  if (to <= from) return null;
  let reading = u
    .slice(from, to)
    .map((token) => token.text)
    .join(" ");
  // The quote may stop inside its last word ("Nair" of "Nair's"); drop the same tail here.
  const lastToken = b[last] as Token;
  const tail = biased.slice(end, lastToken.end);
  if (tail !== "" && reading.endsWith(tail)) reading = reading.slice(0, -tail.length);
  const firstToken = b[first] as Token;
  const head = biased.slice(firstToken.start, start);
  if (head !== "" && reading.startsWith(head)) reading = reading.slice(head.length);
  return reading === "" ? null : reading;
}

/** The kind of record a proposal's words name: what the generator said, or the record's. */
function mentionKind(proposal: ExpectedProposal) {
  if (proposal.type === "contact") return "contact" as const;
  const named = namedOf(proposal);
  if (named?.kind) return named.kind;
  return proposal.target.id === null ? null : linkingEntity(proposal.target.id).kind;
}

/** The company said beside the target: a contact proposal's company field, or `named.company`. */
function companyQuoteOf(proposal: ExpectedProposal): string | null {
  if (proposal.type === "contact") return proposal.fields.company?.quote ?? null;
  return namedOf(proposal)?.company ?? null;
}

function checkFields(
  script: DebriefScript,
  turn: DebriefTurn,
  proposal: ExpectedProposal,
  where: string,
): string[] {
  const problems: string[] = [];
  const heard = turn.heard.biased;
  for (const [name, field] of expectedFields(proposal)) {
    const at = `${where} ${name}`;
    if (field.quote !== field.quote.trim())
      problems.push(`${at}: the quote has spaces at its ends`);
    if (!heard.includes(field.quote)) {
      problems.push(`${at}: "${field.quote}" isn't in what the stream heard`);
      continue;
    }
    if (DATE_FIELDS.has(name)) {
      const resolved = resolveDatePhrase(field.quote, script.callTime, script.timeZone);
      if (resolved?.date !== field.value) {
        problems.push(
          `${at}: "${field.quote}" resolves to ${resolved?.date ?? "nothing"}, not ${field.value}`,
        );
      }
    } else if (name === "amount") {
      if (parseUsd(field.quote) !== field.value)
        problems.push(`${at}: "${field.quote}" isn't ${field.value}`);
    } else if (name === "time") {
      if (resolveTimePhrase(field.quote) !== field.value)
        problems.push(`${at}: "${field.quote}" isn't ${field.value}`);
    } else {
      const kind = fieldKind(proposal.type, name);
      if (kind === "name" && normalizeName(String(field.value)) !== normalizeName(field.quote)) {
        problems.push(`${at}: the name "${field.value}" isn't written as heard ("${field.quote}")`);
      }
      if (
        (kind === "verbatim" || kind === "email" || kind === "phone") &&
        !field.quote.includes(String(field.value))
      ) {
        problems.push(`${at}: "${field.value}" isn't word for word in "${field.quote}"`);
      }
    }
  }
  const named = namedOf(proposal);
  if (named) {
    if (!heard.includes(named.quote))
      problems.push(`${where}: the target's words "${named.quote}" aren't heard`);
    if (named.company !== undefined && !heard.includes(named.company)) {
      problems.push(`${where}: the company "${named.company}" isn't heard`);
    }
  }
  return problems;
}

function checkTarget(proposal: ExpectedProposal, where: string): string[] {
  const { id, decision } = proposal.target;
  const problems: string[] = [];
  if (id !== null) {
    if (!hasLinkingEntity(id)) return [`${where}: ${id} isn't in the demo CRM`];
    if (!TARGET_KINDS[proposal.type].includes(linkingEntity(id).kind)) {
      problems.push(
        `${where}: a ${proposal.type} can't target the ${linkingEntity(id).kind} ${id}`,
      );
    }
  }
  const named = namedOf(proposal);
  if (proposal.type !== "contact" && named !== null && id === null && named.kind === undefined) {
    problems.push(`${where}: a record the CRM doesn't hold needs its kind said`);
  }
  if (decision === "new" && proposal.type === "deal_update")
    problems.push(`${where}: a deal is never new`);
  return problems;
}

function checkTags(turn: DebriefTurn, where: string): string[] {
  const problems: string[] = [];
  if (turn.tags?.includes("negation") && !NEGATION_PATTERN.test(turn.text)) {
    problems.push(`${where}: tagged negation, with no negation word`);
  }
  if (turn.tags?.includes("self_correction")) {
    const marker = CORRECTION_MARKER.exec(turn.heard.biased);
    const after = turn.expect
      .flatMap(expectedFields)
      .some(
        ([, field]) =>
          turn.heard.biased.indexOf(field.quote) > (marker?.index ?? Number.POSITIVE_INFINITY),
      );
    if (!marker || !after)
      problems.push(`${where}: tagged self_correction, with no correction before a quote`);
  }
  if (turn.tags?.includes("disfluency") && !showsDisfluency(turn.text)) {
    problems.push(`${where}: tagged disfluency, with no filler, repetition, or restart`);
  }
  return problems;
}

/**
 * The labels of a generated script's targets against the oracle, walking the debrief in order as
 * the session would, with its earlier links (`nextRecent`) and the company said with each target
 * as context. The 30 hand-written scripts were labelled by hand and by linker v1's decisions
 * (WP8), not by the oracle, so this check is for format v2's generated files.
 */
function checkConstruction(script: DebriefScript): string[] {
  const problems: string[] = [];
  let recent: string[] = [];
  script.turns.forEach((turn, turnIndex) => {
    turn.expect.forEach((proposal, n) => {
      const where = `${script.id} turn ${turnIndex + 1} #${n + 1} (${proposal.type})`;
      const flags = proposal.expectFlags ?? [];
      const companyText = companyQuoteOf(proposal);
      const linkedCompany =
        companyText === null
          ? null
          : linkedCompanyOf(companyText, script.focusEntityId ?? null, recent);
      const quote =
        proposal.type === "contact" ? proposal.fields.name.quote : namedOf(proposal)?.quote;
      const { id, decision } = proposal.target;
      if (quote === undefined) {
        // No record named: the open account stands in.
        const focus = script.focusEntityId ?? null;
        const ok =
          flags.includes("implied_target") &&
          decision === "linked" &&
          focus !== null &&
          (id === focus || (id !== null && linkingEntity(id).parentId === focus));
        if (!ok) problems.push(`${where}: names no record, but isn't the open account, implied`);
        recent = nextRecent(recent, linkedCompany, null);
        return;
      }
      const kind = mentionKind(proposal);
      if (kind === null) {
        problems.push(`${where}: no kind for "${quote}"`);
        return;
      }
      const observe = (mention: string) =>
        resolve({
          type: proposal.type === "meeting" ? "note" : proposal.type,
          kind,
          mention,
          company: kind === "contact" ? companyText : null,
          focusEntityId: script.focusEntityId ?? null,
          recent,
        });
      const reading = observe(quote);
      let ok: boolean;
      const targetFlags = flags.filter((flag) => TARGET_FLAGS.has(flag));
      if (decision === "linked") {
        ok = reading.decision === "link" && reading.entityId === id && targetFlags.length === 0;
      } else if (decision === "new")
        ok = reading.decision === "new" && flags.includes("new_entity");
      else if (decision === "ask" && id !== null) {
        ok =
          reading.decision === "ask" &&
          reading.matches.includes(id) &&
          flags.includes("ambiguous_target");
      } else if (decision === "ask") {
        const unbiased = unbiasedReadingOf(turn.heard.biased, turn.heard.unbiased, quote);
        ok =
          flags.includes("witness_conflict") &&
          reading.decision === "link" &&
          unbiased !== null &&
          observe(unbiased).decision === "new";
      } else ok = false;
      if (!ok) {
        problems.push(
          `${where}: labelled ${decision} ${id ?? ""}, but the oracle reads "${quote}" as ${reading.decision} ${reading.entityId ?? ""} (${reading.matches.join(", ")})`,
        );
      }
      recent = nextRecent(recent, linkedCompany, proposal.target);
    });
  });
  return problems;
}

/** What's wrong with a script's ground truth, in words; empty when it holds. */
export function groundTruthProblems(
  script: DebriefScript,
  options: { construction: boolean },
): string[] {
  const problems: string[] = [];
  script.turns.forEach((turn, turnIndex) => {
    const where = `${script.id} turn ${turnIndex + 1}`;
    problems.push(...checkTags(turn, where));
    turn.expect.forEach((proposal, n) => {
      const at = `${where} #${n + 1} (${proposal.type})`;
      problems.push(...checkFields(script, turn, proposal, at), ...checkTarget(proposal, at));
    });
  });
  if (options.construction) problems.push(...checkConstruction(script));
  return problems;
}
