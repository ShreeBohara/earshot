// What the debrief scripts cover, computed from the data. Two tables of minimums:
//
// - `COVERAGE_MINIMUMS`, eval harness v0's (Phase 3 spec, WP11 step 1), over the 30 hand-written
//   scripts: the spec's numbers, raised where one example would be too thin to notice a
//   regression;
// - `COVERAGE_MINIMUMS_V1`, eval harness v1's (Phase 4 spec, WP10 step 3; targets), over all 200:
//   the hand-written 30 and the generated d031–d200.
//
// The coverage tests fail if a script edit, or a change to the generator, drops below either.
import {
  ProposalType as ProposalTypesV1,
  ProposalTypeV2 as ProposalTypesV2,
  type ProposalTypeV2,
} from "@earshot/core";
import { confusables } from "@earshot/demo-crm";
import { normalizeName } from "@earshot/understanding/names";
import { type DebriefScript, type ExpectedProposal, expectedFields, namedOf } from "./schema";
import { DEMO_SESSION_ENTITIES, demoCompanyOf } from "./session";
import { NUMBER_PATTERN, resolveDatePhrase } from "./verify";

export const COVERAGE_MINIMUMS = {
  scripts: 30,
  /** Turns that expect at least one proposal (the spec's 90). */
  turnsWithProposals: 90,
  /** Proposals of each Phase 3 type. */
  perType: 5,
  /** Scripts that name a member of a confusable group and target it (or its deal). */
  confusableScripts: 10,
  /** Turns with an amount, or a number in an expected quote. */
  numberTurns: 10,
  /** Turns with a date field that a relative phrase resolves ("by Friday", "tomorrow"). */
  relativeDateTurns: 10,
  negationTurns: 5,
  selfCorrectionTurns: 2,
  /** Distinct Kokoro voices. */
  voices: 12,
} as const;

/** Eval harness v1's minimums over all 200 scripts (spec WP10 step 3; targets). */
export const COVERAGE_MINIMUMS_V1 = {
  scripts: 200,
  /** Turns that expect at least one proposal. */
  turnsWithProposals: 600,
  /** Proposals of each type, `meeting` included. */
  perType: 40,
  /** Explicit mentions (a named target, or a contact's name) of a confusable-group member. */
  confusableMentions: 300,
  /** Date fields a relative phrase resolves ("by Friday", "in two weeks"). */
  relativeDates: 80,
  /** Amount fields. */
  amounts: 80,
  negationTurns: 40,
  selfCorrectionTurns: 30,
  /** Turns tagged `disfluency`: fillers, repetitions, replacements, restarts. */
  disfluentTurns: 150,
  /** Proposals that expect a `witness_conflict`: a mishearing only the second witness catches. */
  witnessConflicts: 25,
  /** Distinct Kokoro voices. */
  voices: 20,
} as const;

export interface Coverage {
  readonly scripts: number;
  readonly turns: number;
  readonly turnsWithProposals: number;
  readonly proposals: number;
  readonly perType: Readonly<Record<ProposalTypeV2, number>>;
  readonly confusableScripts: readonly string[];
  readonly confusableMentions: number;
  readonly numberTurns: number;
  readonly relativeDateTurns: number;
  readonly relativeDates: number;
  readonly amounts: number;
  readonly negationTurns: number;
  readonly selfCorrectionTurns: number;
  readonly disfluentTurns: number;
  readonly witnessConflicts: number;
  readonly impliedTargets: number;
  readonly newContacts: number;
  readonly voices: number;
  readonly words: number;
}

/** Each confusable group member's id, and the name a rep would say. */
const CONFUSABLE_NAMES: ReadonlyMap<string, string> = new Map(
  confusables.flatMap((group) =>
    group.memberIds.map((id) => {
      const entity = DEMO_SESSION_ENTITIES.find((candidate) => candidate.id === id);
      if (!entity) throw new RangeError(`confusable member ${id} isn't in the demo CRM`);
      return [id, entity.name] as const;
    }),
  ),
);

/** Whether a record is a confusable group member, or a deal of one. */
export function inConfusableGroup(id: string): boolean {
  if (CONFUSABLE_NAMES.has(id)) return true;
  if (!id.startsWith("deal_")) return false;
  return CONFUSABLE_NAMES.has(demoCompanyOf(id) ?? "");
}

/**
 * The confusable group members a script both names in a turn and targets, directly or through
 * one of their deals. Empty when the script uses no confusable name, or never targets one.
 */
export function confusableTargets(script: DebriefScript): string[] {
  const named = new Set<string>();
  for (const turn of script.turns) {
    for (const [id, name] of CONFUSABLE_NAMES) if (turn.text.includes(name)) named.add(id);
  }
  const targeted = new Set<string>();
  for (const turn of script.turns) {
    for (const proposal of turn.expect) {
      const id = proposal.target.id;
      if (id === null) continue;
      targeted.add(id);
      if (id.startsWith("deal_")) {
        const company = demoCompanyOf(id);
        if (company) targeted.add(company);
      }
    }
  }
  return [...named].filter((id) => targeted.has(id)).sort();
}

const DATE_FIELDS = new Set(["dueDate", "closeDate", "date"]);

/** Every confusable member's name and aliases, normalized for matching; built on first use. */
let memberSpellings: ReadonlySet<string> | undefined;
function isMemberSpelling(quote: string): boolean {
  memberSpellings ??= new Set(
    DEMO_SESSION_ENTITIES.filter((entity) => CONFUSABLE_NAMES.has(entity.id)).flatMap((entity) =>
      [entity.name, ...entity.aliases].map(normalizeName),
    ),
  );
  return memberSpellings.has(normalizeName(quote));
}

/**
 * Whether a proposal names a confusable group member explicitly: its named target, or a contact
 * proposal's person, is a member (or a member's deal); or, for a record the CRM doesn't hold, the
 * words as heard are a member's spelling (a new name the biased stream snapped onto one).
 */
export function namesConfusable(proposal: ExpectedProposal): boolean {
  const named = namedOf(proposal);
  const quote = proposal.type === "contact" ? proposal.fields.name.quote : named?.quote;
  if (quote === undefined) return false;
  if (proposal.target.id !== null) return inConfusableGroup(proposal.target.id);
  return isMemberSpelling(quote);
}

export function coverageOf(scripts: readonly DebriefScript[]): Coverage {
  const perType = Object.fromEntries(ProposalTypesV2.options.map((type) => [type, 0])) as Record<
    ProposalTypeV2,
    number
  >;
  let turns = 0;
  let turnsWithProposals = 0;
  let proposals = 0;
  let confusableMentions = 0;
  let numberTurns = 0;
  let relativeDateTurns = 0;
  let relativeDates = 0;
  let amounts = 0;
  let negationTurns = 0;
  let selfCorrectionTurns = 0;
  let disfluentTurns = 0;
  let witnessConflicts = 0;
  let impliedTargets = 0;
  let newContacts = 0;
  let words = 0;
  for (const script of scripts) {
    for (const turn of script.turns) {
      turns++;
      words += turn.text.split(" ").length;
      if (turn.expect.length > 0) turnsWithProposals++;
      if (turn.tags?.includes("negation")) negationTurns++;
      if (turn.tags?.includes("self_correction")) selfCorrectionTurns++;
      if (turn.tags?.includes("disfluency")) disfluentTurns++;
      let hasNumber = false;
      let hasRelativeDate = false;
      for (const proposal of turn.expect) {
        proposals++;
        perType[proposal.type]++;
        if (proposal.type === "contact" && proposal.target.decision === "new") newContacts++;
        if (proposal.expectFlags?.includes("witness_conflict")) witnessConflicts++;
        if (proposal.expectFlags?.includes("implied_target")) impliedTargets++;
        if (namesConfusable(proposal)) confusableMentions++;
        for (const [name, field] of expectedFields(proposal)) {
          if (DATE_FIELDS.has(name)) {
            // A date's digits aren't a number to check, as in @earshot/agent's risk flags.
            if (resolveDatePhrase(field.quote, script.callTime, script.timeZone)?.relative) {
              hasRelativeDate = true;
              relativeDates++;
            }
          } else if (name !== "time") {
            // Nor are a time's.
            if (typeof field.value === "number" || NUMBER_PATTERN.test(field.quote)) {
              hasNumber = true;
            }
          }
          if (name === "amount") amounts++;
        }
      }
      if (hasNumber) numberTurns++;
      if (hasRelativeDate) relativeDateTurns++;
    }
  }
  return {
    scripts: scripts.length,
    turns,
    turnsWithProposals,
    proposals,
    perType,
    confusableScripts: scripts
      .filter((script) => confusableTargets(script).length > 0)
      .map((script) => script.id),
    confusableMentions,
    numberTurns,
    relativeDateTurns,
    relativeDates,
    amounts,
    negationTurns,
    selfCorrectionTurns,
    disfluentTurns,
    witnessConflicts,
    impliedTargets,
    newContacts,
    voices: new Set(scripts.map((script) => script.voice)).size,
    words,
  };
}

/** Where a coverage falls short of harness v0's minimums, in words; empty when it meets them. */
export function coverageShortfallsV0(coverage: Coverage): string[] {
  const short: string[] = [];
  const at = (label: string, have: number, want: number) => {
    if (have < want) short.push(`${label}: ${have}, below ${want}`);
  };
  at("scripts", coverage.scripts, COVERAGE_MINIMUMS.scripts);
  at("turns with proposals", coverage.turnsWithProposals, COVERAGE_MINIMUMS.turnsWithProposals);
  for (const type of ProposalTypesV1.options) {
    at(`${type} proposals`, coverage.perType[type], COVERAGE_MINIMUMS.perType);
  }
  at("confusable scripts", coverage.confusableScripts.length, COVERAGE_MINIMUMS.confusableScripts);
  at("number turns", coverage.numberTurns, COVERAGE_MINIMUMS.numberTurns);
  at("relative date turns", coverage.relativeDateTurns, COVERAGE_MINIMUMS.relativeDateTurns);
  at("negation turns", coverage.negationTurns, COVERAGE_MINIMUMS.negationTurns);
  at("self-correction turns", coverage.selfCorrectionTurns, COVERAGE_MINIMUMS.selfCorrectionTurns);
  at("voices", coverage.voices, COVERAGE_MINIMUMS.voices);
  return short;
}

/** The v1 table's rows: label, what the scripts have, and the minimum. */
export function coverageRowsV1(coverage: Coverage): [string, number, number][] {
  const min = COVERAGE_MINIMUMS_V1;
  return [
    ["Scripts", coverage.scripts, min.scripts],
    ["Turns expecting a proposal", coverage.turnsWithProposals, min.turnsWithProposals],
    ...ProposalTypesV2.options.map((type): [string, number, number] => [
      `Proposals: ${type.replace("_", " ")}`,
      coverage.perType[type],
      min.perType,
    ]),
    [
      "Explicit mentions of a confusable-group member",
      coverage.confusableMentions,
      min.confusableMentions,
    ],
    ["Relative dates", coverage.relativeDates, min.relativeDates],
    ["Amounts", coverage.amounts, min.amounts],
    ["Negations (turns)", coverage.negationTurns, min.negationTurns],
    ["Self-corrections (turns)", coverage.selfCorrectionTurns, min.selfCorrectionTurns],
    ["Disfluent turns", coverage.disfluentTurns, min.disfluentTurns],
    ["Witness conflicts", coverage.witnessConflicts, min.witnessConflicts],
    ["Distinct voices", coverage.voices, min.voices],
  ];
}

/** Where a coverage falls short of harness v1's minimums, in words; empty when it meets them. */
export function coverageShortfallsV1(coverage: Coverage): string[] {
  return coverageRowsV1(coverage)
    .filter(([, have, want]) => have < want)
    .map(([label, have, want]) => `${label}: ${have}, below ${want}`);
}

/** The v1 coverage table, as Markdown. */
export function coverageMarkdown(coverage: Coverage): string {
  const rows = coverageRowsV1(coverage).map(
    ([label, have, want]) =>
      `| ${label} | ${want} | ${have} | ${have >= want ? "yes" : "**no**"} |`,
  );
  return [
    "| Rule | Minimum (target) | Now | Met |",
    "|---|---|---|---|",
    ...rows,
    "",
    `Also: ${coverage.turns} turns, ${coverage.proposals} proposals, ${coverage.impliedTargets} implied targets, ${coverage.newContacts} new contacts, ${coverage.words.toLocaleString("en-US")} words.`,
  ].join("\n");
}
