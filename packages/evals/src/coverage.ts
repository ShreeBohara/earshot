// What the 30 scripts cover, computed from the data (spec WP11 step 1). The minimums below are
// the spec's, raised where one example would be too thin to notice a regression; the coverage
// test fails if a script edit drops below any of them.
import { type ProposalType, ProposalType as ProposalTypes } from "@earshot/core";
import { confusables } from "@earshot/demo-crm";
import { type DebriefScript, expectedFields } from "./schema";
import { DEMO_SESSION_ENTITIES, demoCompanyOf } from "./session";
import { NUMBER_PATTERN, resolveDatePhrase } from "./verify";

export const COVERAGE_MINIMUMS = {
  scripts: 30,
  /** Turns that expect at least one proposal (the spec's 90). */
  turnsWithProposals: 90,
  /** Proposals of each type. */
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

export interface Coverage {
  readonly scripts: number;
  readonly turns: number;
  readonly turnsWithProposals: number;
  readonly proposals: number;
  readonly perType: Readonly<Record<ProposalType, number>>;
  readonly confusableScripts: readonly string[];
  readonly numberTurns: number;
  readonly relativeDateTurns: number;
  readonly negationTurns: number;
  readonly selfCorrectionTurns: number;
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
      if (proposal.target === null) continue;
      targeted.add(proposal.target);
      if (proposal.target.startsWith("deal_")) {
        const company = demoCompanyOf(proposal.target);
        if (company) targeted.add(company);
      }
    }
  }
  return [...named].filter((id) => targeted.has(id)).sort();
}

export function coverageOf(scripts: readonly DebriefScript[]): Coverage {
  const perType = Object.fromEntries(ProposalTypes.options.map((type) => [type, 0])) as Record<
    ProposalType,
    number
  >;
  let turns = 0;
  let turnsWithProposals = 0;
  let proposals = 0;
  let numberTurns = 0;
  let relativeDateTurns = 0;
  let negationTurns = 0;
  let selfCorrectionTurns = 0;
  let newContacts = 0;
  let words = 0;
  for (const script of scripts) {
    for (const turn of script.turns) {
      turns++;
      words += turn.text.split(" ").length;
      if (turn.expect.length > 0) turnsWithProposals++;
      if (turn.tags?.includes("negation")) negationTurns++;
      if (turn.tags?.includes("self_correction")) selfCorrectionTurns++;
      let hasNumber = false;
      let hasRelativeDate = false;
      for (const proposal of turn.expect) {
        proposals++;
        perType[proposal.type]++;
        if (proposal.type === "contact" && proposal.target === null) newContacts++;
        for (const [name, field] of expectedFields(proposal)) {
          if (name === "dueDate" || name === "closeDate") {
            // A date's digits aren't a number to check, as in @earshot/agent's risk flags.
            if (resolveDatePhrase(field.quote, script.callTime, script.timeZone)?.relative) {
              hasRelativeDate = true;
            }
          } else if (typeof field.value === "number" || NUMBER_PATTERN.test(field.quote)) {
            hasNumber = true;
          }
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
    numberTurns,
    relativeDateTurns,
    negationTurns,
    selfCorrectionTurns,
    newContacts,
    voices: new Set(scripts.map((script) => script.voice)).size,
    words,
  };
}
