// The live smoke eval's 30 scripts (Phase 4 WP11 step 1; ADR-0031): `smoke.json`, chosen from
// the 200 debriefs by a seeded greedy pick, so the set is reproducible and its strata are met by
// construction. A test re-runs the pick and compares it with the committed file, as the
// generator's test does for d031–d200, and checks every minimum below.
//
// The strata are the spec's: proposal types, confusable names, numbers, dates, negations, and
// witness conflicts. Four more serve the gate:
//
// - names the production stream misheard (not snapped onto another record: those are the
//   conflicts). A model that "corrects" one quotes words the transcript doesn't hold, and the
//   pipeline refuses to link them, which is how the test PR that drops "quote names exactly"
//   (spec §6, G3b) shows up: as target and key-field accuracy;
// - self-corrections and disfluencies, the debriefs' hardest phrasing;
// - implied targets (no name said, the open account stands in);
// - some of the 30 hand-written scripts, whose phrasing no template wrote.
//
// Two scripts are left out on purpose (`SMOKE_EXCLUDED`): with every draft right, linker v1 still
// links one snapped name in each to the record it was snapped onto (ADR-0031's two wrong accounts,
// the linker's known gap). The $0 gate tracks those. Here, with about 95 targets decided, each one
// would be a point of wrong-account rate against a 2% gate, so the live run couldn't pass on main.
//
// The pick. Scripts are shuffled with the seed; then, 30 times, the script that most reduces the
// strata's remaining shortfalls (each stratum's share of its minimum) is taken, ties going to
// fewer turns and then to the shuffled order. Once every minimum is met, the rest follow the
// shuffled order. The turns stay within `SMOKE_MAX_TURNS`, so a run makes about 120 requests.
import { ProposalTypeV2 as ProposalTypes, type ProposalTypeV2 } from "@earshot/core";
import { z } from "zod";
import { createRng } from "../channel/rng";
import { coverageOf } from "../coverage";
import { type DebriefScript, type ExpectedProposal, namedOf } from "../schema";

export const SMOKE_SET_VERSION = 1;
/** The pick's seed: SHA-256's eighth initial hash word (the fifth to seventh seed the other sets). */
export const SMOKE_SEED = 0x5be0cd19;
export const SMOKE_SIZE = 30;
/** At most this many turns in all: one request each, about 120 a run. */
export const SMOKE_MAX_TURNS = 125;

/** Scripts the pick never takes, and why. */
export const SMOKE_EXCLUDED: Readonly<Record<string, string>> = {
  d037: "linker v1 links the snapped new contact to the CRM record even from perfect drafts (ADR-0031)",
  d193: "linker v1 links the snapped new company to the CRM record even from perfect drafts (ADR-0031)",
};

/** What a set of scripts holds, by stratum. */
export interface SmokeStrata {
  readonly scripts: number;
  readonly turns: number;
  readonly proposals: number;
  readonly perType: Readonly<Record<ProposalTypeV2, number>>;
  /** Explicit mentions of a confusable-group member (a named target, or a contact's name). */
  readonly confusableMentions: number;
  /** Named records whose words the production stream misheard, not counting snapped names. */
  readonly misheardNames: number;
  /** Proposals that expect `witness_conflict`: a new name snapped onto a CRM spelling. */
  readonly witnessConflicts: number;
  /** Turns with an amount, or a number in an expected quote. */
  readonly numberTurns: number;
  readonly amounts: number;
  /** Date fields a relative phrase resolves ("by Friday", "in two weeks"). */
  readonly relativeDates: number;
  readonly negationTurns: number;
  readonly selfCorrectionTurns: number;
  readonly disfluentTurns: number;
  readonly impliedTargets: number;
  /** Scripts from the 30 hand-written ones (d001–d030). */
  readonly handWritten: number;
}

/** The minimum of each stratum the 30 scripts must hold (targets, a few times the noise of one). */
export const SMOKE_MINIMUMS = {
  note: 10,
  task: 10,
  contact: 10,
  deal_update: 10,
  commitment: 10,
  meeting: 10,
  confusableMentions: 45,
  misheardNames: 30,
  witnessConflicts: 10,
  numberTurns: 15,
  amounts: 12,
  relativeDates: 25,
  negationTurns: 12,
  selfCorrectionTurns: 6,
  disfluentTurns: 20,
  impliedTargets: 4,
  handWritten: 6,
} as const;
export type SmokeStratum = keyof typeof SMOKE_MINIMUMS;

/** Whether a proposal's named words differ from what was said, other than by a snap. */
function misheard(proposal: ExpectedProposal, said: string): boolean {
  if (proposal.expectFlags?.includes("witness_conflict")) return false;
  const quote = proposal.type === "contact" ? proposal.fields.name.quote : namedOf(proposal)?.quote;
  return quote !== undefined && !said.includes(quote);
}

/** The strata a set of scripts holds. */
export function smokeStrata(scripts: readonly DebriefScript[]): SmokeStrata {
  const coverage = coverageOf(scripts);
  let misheardNames = 0;
  for (const script of scripts) {
    for (const turn of script.turns) {
      for (const proposal of turn.expect) if (misheard(proposal, turn.text)) misheardNames++;
    }
  }
  return {
    scripts: coverage.scripts,
    turns: coverage.turns,
    proposals: coverage.proposals,
    perType: { ...coverage.perType },
    confusableMentions: coverage.confusableMentions,
    misheardNames,
    witnessConflicts: coverage.witnessConflicts,
    numberTurns: coverage.numberTurns,
    amounts: coverage.amounts,
    relativeDates: coverage.relativeDates,
    negationTurns: coverage.negationTurns,
    selfCorrectionTurns: coverage.selfCorrectionTurns,
    disfluentTurns: coverage.disfluentTurns,
    impliedTargets: coverage.impliedTargets,
    handWritten: scripts.filter((script) => Number(script.id.slice(1)) <= 30).length,
  };
}

/** A stratum's count, by its name in `SMOKE_MINIMUMS`. */
export function stratumCount(strata: SmokeStrata, stratum: SmokeStratum): number {
  return (ProposalTypes.options as readonly string[]).includes(stratum)
    ? strata.perType[stratum as ProposalTypeV2]
    : strata[stratum as Exclude<SmokeStratum, ProposalTypeV2>];
}

/** Where a set falls short of the minimums, in words; empty when it meets them all. */
export function smokeShortfalls(strata: SmokeStrata): string[] {
  const short: string[] = [];
  for (const [stratum, minimum] of Object.entries(SMOKE_MINIMUMS) as [SmokeStratum, number][]) {
    const have = stratumCount(strata, stratum);
    if (have < minimum) short.push(`${stratum}: ${have}, below ${minimum}`);
  }
  if (strata.turns > SMOKE_MAX_TURNS)
    short.push(`turns: ${strata.turns}, above ${SMOKE_MAX_TURNS}`);
  return short;
}

/**
 * The seeded greedy pick (see the top of the file): `SMOKE_SIZE` script ids, in id order. Throws
 * if the minimums can't all be met, so a change to the debriefs that starves a stratum fails here
 * rather than quietly thinning the set.
 */
export function selectSmokeSet(scripts: readonly DebriefScript[], seed = SMOKE_SEED): string[] {
  const order = createRng(seed).shuffle(
    scripts.filter((script) => !Object.hasOwn(SMOKE_EXCLUDED, script.id)),
  );
  const single = new Map(order.map((script) => [script.id, smokeStrata([script])]));
  const chosen: DebriefScript[] = [];
  let have = smokeStrata([]);
  const strata = Object.entries(SMOKE_MINIMUMS) as [SmokeStratum, number][];
  const gain = (candidate: SmokeStrata) =>
    strata.reduce((sum, [stratum, minimum]) => {
      const short = Math.max(0, minimum - stratumCount(have, stratum));
      return sum + Math.min(short, stratumCount(candidate, stratum)) / minimum;
    }, 0);
  while (chosen.length < SMOKE_SIZE) {
    const slotsAfter = SMOKE_SIZE - chosen.length - 1;
    let best: { script: DebriefScript; gain: number; turns: number } | null = null;
    for (const script of order) {
      if (chosen.includes(script)) continue;
      const counts = single.get(script.id) as SmokeStrata;
      // Leave room for the slots still to fill, at the fewest turns a script has.
      if (have.turns + counts.turns + slotsAfter * 2 > SMOKE_MAX_TURNS) continue;
      const score = gain(counts);
      if (
        best === null ||
        score > best.gain + 1e-12 ||
        (Math.abs(score - best.gain) <= 1e-12 && counts.turns < best.turns)
      ) {
        best = { script, gain: score, turns: counts.turns };
      }
    }
    if (best === null) throw new Error("no script fits the smoke set's turn budget");
    chosen.push(best.script);
    have = smokeStrata(chosen);
  }
  const short = smokeShortfalls(have);
  if (short.length > 0) {
    throw new Error(`the smoke set can't meet its minimums: ${short.join("; ")}`);
  }
  return chosen.map((script) => script.id).sort();
}

/** `smoke.json`: the set, and what it holds, for review. A test holds both to the scripts. */
export const SmokeSet = z.strictObject({
  version: z.literal(SMOKE_SET_VERSION),
  seed: z.int(),
  scripts: z
    .array(z.string().regex(/^d\d{3}$/))
    .length(SMOKE_SIZE)
    .refine((ids) => new Set(ids).size === ids.length, "each script once"),
  strata: z.record(z.string(), z.union([z.int(), z.record(z.string(), z.int())])),
});
export type SmokeSet = z.infer<typeof SmokeSet>;

/** The set file's content for these scripts: the pick, and its strata. */
export function buildSmokeSet(scripts: readonly DebriefScript[]): SmokeSet {
  const ids = selectSmokeSet(scripts);
  const byId = new Map(scripts.map((script) => [script.id, script]));
  const strata = smokeStrata(ids.map((id) => byId.get(id) as DebriefScript));
  return { version: SMOKE_SET_VERSION, seed: SMOKE_SEED, scripts: ids, strata: { ...strata } };
}

/** The set file's bytes: two-space JSON, the ids on one line each. */
export function serializeSmokeSet(set: SmokeSet): string {
  return `${JSON.stringify(set, null, 2)}\n`;
}

/** The set's scripts, in its order; throws for an id the debriefs don't have. */
export function smokeScripts(
  set: Pick<SmokeSet, "scripts">,
  scripts: readonly DebriefScript[],
): DebriefScript[] {
  const byId = new Map(scripts.map((script) => [script.id, script]));
  return set.scripts.map((id) => {
    const found = byId.get(id);
    if (!found) throw new RangeError(`smoke.json names ${id}, which isn't a debrief`);
    return found;
  });
}
