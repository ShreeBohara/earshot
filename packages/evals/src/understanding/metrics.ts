// The understanding report's metrics (Phase 4 WP10 step 6; ADR-0031), from runs of the scripts
// through the pipeline. Pure: the same runs give the same numbers. Written for any extractor, so
// WP11's live smoke eval can score a real model's runs the same way.
//
// Matching. Within a turn, each expected proposal takes the first unmatched actual proposal of its
// type, in order. An actual proposal no expected one took is an extra; an expected one no actual
// one matched is a miss.
//
// | Metric | Definition |
// |---|---|
// | Key-field accuracy | `KEY_FIELDS` the matched proposal has exactly right ÷ every expected key field |
// | Proposal precision, recall, F1 | Matched ÷ actual, matched ÷ expected, per type and overall |
// | Joint action accuracy | Turns that expect a proposal whose proposals all match, with the right target and key fields, and nothing extra ÷ those turns |
// | Target accuracy | Matched proposals whose final target is the expected decision (the record, for a link; offered, for an ask) ÷ expected proposals |
// | End-to-end wrong-account rate | Final links to a record other than the expected one ÷ final targets decided ("linked" or "new"), over matched proposals, with its one-sided 95% Clopper–Pearson bound |
// | Date, amount accuracy | Those key fields right ÷ expected |
// | Negation accuracy | Turns tagged `negation` whose proposals are all right, as for joint action accuracy (a turn that expects nothing must propose nothing) ÷ those turns |
// | Evidence coverage | Fields and named targets whose evidence is the words the model quoted, once folded, ÷ all of them; a target whose words aren't in the transcript and is linked anyway counts against it (gate G2b) |
// | Conflict precision, recall | Proposals flagged `witness_conflict` that the script expects to conflict ÷ proposals flagged; ÷ proposals expected to |
// | Flag share | Final proposals with any risk flag ÷ final proposals. Reported: since Phase 5 the guard against a sea of color, 35% or less, is the tiers' marked share (`tiers`, ADR-0031's option 2) |
// | Seeded catches | Labelled cassette errors the pipeline caught: a wrong date or amount replaced by its words' reading and flagged `value_mismatch`; a paraphrased target left unlinked and flagged `unsupported` |
// | Likely-edit tiers | The loud, marked, and name-note shares, the loud floor, surfacing recall, per-tier precision, and hidden wrong accounts (tiers.ts, Phase 5 WP4) |
import { locateQuote, type ToolProposal } from "@earshot/agent";
import {
  ProposalTypeV2 as ProposalTypes,
  type ProposalTypeV2,
  RiskKindV2,
  TARGET_FIELD,
} from "@earshot/core";
import { foldName } from "@earshot/understanding/names";
import { clopperPearsonUpper } from "../linking/metrics";
import { type ExpectedProposal, KEY_FIELDS } from "../schema";
import { ERROR_KINDS, type ErrorKind, type ErrorLabels } from "./cassettes";
import type { FinalProposal, ScriptRun, TurnRun } from "./run";
import { type TierItem, type TierMetrics, tierMetrics } from "./tiers";

export interface Ratio {
  readonly n: number;
  readonly of: number;
  /** n ÷ of, or null when there's nothing to divide by. */
  readonly rate: number | null;
}

function ratio(n: number, of: number): Ratio {
  return { n, of, rate: of === 0 ? null : n / of };
}

export interface TypeCounts {
  readonly expected: number;
  readonly actual: number;
  readonly matched: number;
  readonly precision: number | null;
  readonly recall: number | null;
}

export interface UnderstandingMetrics {
  readonly scripts: number;
  readonly turns: number;
  readonly proposals: TypeCounts & { readonly f1: number | null };
  readonly perType: Readonly<Record<ProposalTypeV2, TypeCounts>>;
  readonly keyFields: Ratio;
  readonly dates: Ratio;
  readonly amounts: Ratio;
  readonly jointActions: Ratio;
  readonly targets: Ratio;
  readonly wrongAccount: Ratio & { readonly bound: number | null };
  readonly wrongAccountBiasedOnly: Ratio & { readonly bound: number | null };
  readonly negation: Ratio;
  readonly evidence: Ratio & { readonly unquotedLinked: number };
  readonly conflicts: {
    readonly expected: number;
    readonly raised: number;
    readonly caught: number;
    readonly precision: number | null;
    readonly recall: number | null;
  };
  readonly flags: Ratio & { readonly byKind: Readonly<Partial<Record<RiskKindV2, number>>> };
  /** For each flag kind the scripts expect: proposals expected to carry it, and how many did. */
  readonly expectedFlags: Readonly<Partial<Record<RiskKindV2, Ratio>>>;
  readonly seeded: Readonly<Record<ErrorKind, Ratio>>;
  /** The likely-edit tiers over the final proposals and the seeded errors (Phase 5 WP4). */
  readonly tiers: TierMetrics;
  /** Requests the cassettes couldn't answer: must be 0. */
  readonly misses: number;
}

const DATE_FIELDS = new Set(["dueDate", "closeDate", "date"]);
const DECIDED = new Set(["linked", "new"]);

/** Each expected proposal's matched actual proposal index, or -1. */
export function matchTurn(
  expected: readonly ExpectedProposal[],
  actual: readonly FinalProposal[],
): number[] {
  const taken = new Set<number>();
  return expected.map((proposal) => {
    const index = actual.findIndex(
      (candidate, at) => !taken.has(at) && candidate.type === proposal.type,
    );
    if (index >= 0) taken.add(index);
    return index;
  });
}

/** Whether a final target is the expected one: the record, for a link; offered, for an ask. */
export function targetMatches(expected: ExpectedProposal, actual: FinalProposal): boolean {
  const { id, decision } = expected.target;
  if (actual.target.decision !== decision) return false;
  if (decision === "linked") return actual.target.entityId === id;
  if (decision === "ask")
    return actual.target.candidates.some((candidate) => candidate.entityId === id);
  return true;
}

function keyFieldResults(expected: ExpectedProposal, actual: FinalProposal | undefined) {
  const fields = expected.fields as Readonly<
    Record<string, { value: string | number } | undefined>
  >;
  return KEY_FIELDS[expected.type].flatMap((name) => {
    const want = fields[name];
    if (want === undefined) return [];
    return [{ name, ok: actual?.fields[name]?.value === want.value }];
  });
}

function turnRight(
  expected: readonly ExpectedProposal[],
  actual: readonly FinalProposal[],
): boolean {
  if (actual.length !== expected.length) return false;
  const matches = matchTurn(expected, actual);
  return expected.every((proposal, index) => {
    const found = actual[matches[index] ?? -1];
    return (
      found !== undefined &&
      targetMatches(proposal, found) &&
      keyFieldResults(proposal, found).every((result) => result.ok)
    );
  });
}

/** The drafts that became proposals: `understand` drops one with no field it could find. */
function surviving(turn: TurnRun): ToolProposal[] {
  const utterances = [turn.utterances.biased];
  return turn.drafts.filter((draft) =>
    Object.values(draft.fields as Record<string, { quote: string } | null>).some(
      (field) => field !== null && locateQuote(field.quote, utterances) !== null,
    ),
  );
}

/** Evidence coverage for one turn: fields and named targets whose evidence is the quoted words. */
function evidenceOf(turn: TurnRun): { items: number; supported: number; unquotedLinked: number } {
  const text = turn.utterances.biased.text;
  const drafts = surviving(turn);
  let items = 0;
  let supported = 0;
  let unquotedLinked = 0;
  turn.final.forEach((proposal, index) => {
    const draft = drafts[index];
    if (!draft || draft.type !== proposal.type) {
      items += Object.keys(proposal.fields).length + 1;
      return;
    }
    const quotes = draft.fields as Record<string, { quote: string } | null>;
    for (const [name, field] of Object.entries(proposal.fields)) {
      items++;
      const quote = quotes[name]?.quote;
      const said = text.slice(field.evidence.span[0], field.evidence.span[1]);
      if (
        quote !== undefined &&
        foldName(said) === foldName(quote) &&
        field.evidence.utteranceId === turn.utterances.biased.utteranceId
      ) {
        supported++;
      }
    }
    const drafted = "target" in draft ? draft.target : null;
    if (drafted !== null && proposal.type !== "contact") {
      items++;
      const mention = proposal.target.mention;
      if (mention === null) {
        // Words not in the transcript: right only if nothing was linked from them.
        const linked = proposal.target.decision !== "none";
        if (linked) unquotedLinked++;
        else supported++;
      } else {
        const said = text.slice(mention.evidence.span[0], mention.evidence.span[1]);
        if (foldName(said) === foldName(drafted.quote)) supported++;
      }
    }
  });
  return { items, supported, unquotedLinked };
}

function bounded(n: number, of: number): Ratio & { bound: number | null } {
  return { ...ratio(n, of), bound: of === 0 ? null : clopperPearsonUpper(n, of) };
}

/** Every metric, over one provider's runs of the scripts. */
export function understandingMetrics(
  runs: readonly ScriptRun[],
  labels: ErrorLabels,
): UnderstandingMetrics {
  const perType = Object.fromEntries(
    ProposalTypes.options.map((type) => [type, { expected: 0, actual: 0, matched: 0 }]),
  ) as Record<ProposalTypeV2, { expected: number; actual: number; matched: number }>;
  let turns = 0;
  let keyTotal = 0;
  let keyRight = 0;
  let dateTotal = 0;
  let dateRight = 0;
  let amountTotal = 0;
  let amountRight = 0;
  let jointTurns = 0;
  let jointRight = 0;
  let targetTotal = 0;
  let targetRight = 0;
  let decided = 0;
  let wrong = 0;
  let decidedBiased = 0;
  let wrongBiased = 0;
  let negationTurns = 0;
  let negationRight = 0;
  let evidenceItems = 0;
  let evidenceSupported = 0;
  let unquotedLinked = 0;
  let conflictExpected = 0;
  let conflictRaised = 0;
  let conflictCaught = 0;
  let finalProposals = 0;
  let flagged = 0;
  let misses = 0;
  const byKind: Partial<Record<RiskKindV2, number>> = {};
  const expectedFlags: Partial<Record<RiskKindV2, { n: number; of: number }>> = {};
  const caught = Object.fromEntries(ERROR_KINDS.map((kind) => [kind, 0])) as Record<
    ErrorKind,
    number
  >;
  const seeded = Object.fromEntries(ERROR_KINDS.map((kind) => [kind, 0])) as Record<
    ErrorKind,
    number
  >;
  const tierItems: TierItem[] = [];
  const seededProposals: (FinalProposal | undefined)[] = [];
  const errorsByTurn = new Map<string, ErrorLabels["errors"]>();
  for (const error of labels.errors) {
    const key = `${error.script}:${error.turn}`;
    errorsByTurn.set(key, [...(errorsByTurn.get(key) ?? []), error]);
  }

  for (const run of runs) {
    run.script.turns.forEach((turn, turnIndex) => {
      const result = run.turns[turnIndex];
      if (!result) throw new Error(`${run.script.id} has no run for turn ${turnIndex + 1}`);
      turns++;
      misses += result.misses;
      const expected = turn.expect;
      const final = result.final;
      const biased = result.biased;
      const matches = matchTurn(expected, final);
      const biasedMatches = matchTurn(expected, biased);
      const expectedAt = new Map<number, ExpectedProposal>();
      expected.forEach((proposal, index) => {
        const at = matches[index] ?? -1;
        if (at >= 0) expectedAt.set(at, proposal);
      });
      for (const [index, proposal] of final.entries()) {
        tierItems.push({ proposal, expected: expectedAt.get(index) });
      }
      for (const proposal of final) {
        perType[proposal.type].actual++;
        finalProposals++;
        const kinds = new Set(proposal.riskFlags.map((flag) => flag.kind));
        if (kinds.size > 0) flagged++;
        for (const kind of kinds) byKind[kind] = (byKind[kind] ?? 0) + 1;
        if (kinds.has("witness_conflict")) conflictRaised++;
      }
      expected.forEach((proposal, index) => {
        perType[proposal.type].expected++;
        const actual = final[matches[index] ?? -1];
        if (actual) perType[proposal.type].matched++;
        for (const result of keyFieldResults(proposal, actual)) {
          keyTotal++;
          if (result.ok) keyRight++;
          if (DATE_FIELDS.has(result.name)) {
            dateTotal++;
            if (result.ok) dateRight++;
          }
          if (result.name === "amount") {
            amountTotal++;
            if (result.ok) amountRight++;
          }
        }
        targetTotal++;
        if (actual && targetMatches(proposal, actual)) targetRight++;
        if (actual && DECIDED.has(actual.target.decision)) {
          decided++;
          if (actual.target.decision === "linked" && actual.target.entityId !== proposal.target.id)
            wrong++;
        }
        const before = biased[biasedMatches[index] ?? -1];
        if (before && DECIDED.has(before.target.decision)) {
          decidedBiased++;
          if (before.target.decision === "linked" && before.target.entityId !== proposal.target.id)
            wrongBiased++;
        }
        const raised = new Set(actual?.riskFlags.map((flag) => flag.kind) ?? []);
        for (const kind of proposal.expectFlags ?? []) {
          const entry = expectedFlags[kind] ?? { n: 0, of: 0 };
          expectedFlags[kind] = entry;
          entry.of++;
          if (raised.has(kind)) entry.n++;
        }
        if (proposal.expectFlags?.includes("witness_conflict")) {
          conflictExpected++;
          if (raised.has("witness_conflict")) conflictCaught++;
        }
      });
      if (expected.length > 0) {
        jointTurns++;
        if (turnRight(expected, final)) jointRight++;
      }
      if (turn.tags?.includes("negation")) {
        negationTurns++;
        if (turnRight(expected, final)) negationRight++;
      }
      const evidence = evidenceOf(result);
      evidenceItems += evidence.items;
      evidenceSupported += evidence.supported;
      unquotedLinked += evidence.unquotedLinked;
      for (const error of errorsByTurn.get(`${run.script.id}:${turnIndex}`) ?? []) {
        seeded[error.kind]++;
        const actual = final[matches[error.proposal] ?? -1];
        seededProposals.push(actual);
        if (!actual) continue;
        if (error.kind === "paraphrased_target") {
          const refused =
            actual.target.decision === "none" &&
            actual.riskFlags.some(
              (flag) => flag.kind === "unsupported" && flag.field === TARGET_FIELD,
            );
          if (refused) caught[error.kind]++;
          continue;
        }
        const field = actual.fields[error.field];
        const flaggedHere = actual.riskFlags.some(
          (flag) => flag.kind === "value_mismatch" && flag.field === error.field,
        );
        if (field?.value === error.truth && flaggedHere) caught[error.kind]++;
      }
    });
  }

  const typeCounts = (counts: {
    expected: number;
    actual: number;
    matched: number;
  }): TypeCounts => ({
    ...counts,
    precision: counts.actual === 0 ? null : counts.matched / counts.actual,
    recall: counts.expected === 0 ? null : counts.matched / counts.expected,
  });
  const totals = Object.values(perType).reduce(
    (sum, counts) => ({
      expected: sum.expected + counts.expected,
      actual: sum.actual + counts.actual,
      matched: sum.matched + counts.matched,
    }),
    { expected: 0, actual: 0, matched: 0 },
  );
  const overall = typeCounts(totals);
  const f1 =
    overall.precision === null ||
    overall.recall === null ||
    overall.precision + overall.recall === 0
      ? null
      : (2 * overall.precision * overall.recall) / (overall.precision + overall.recall);
  return {
    scripts: runs.length,
    turns,
    proposals: { ...overall, f1 },
    perType: Object.fromEntries(
      ProposalTypes.options.map((type) => [type, typeCounts(perType[type])]),
    ) as Record<ProposalTypeV2, TypeCounts>,
    keyFields: ratio(keyRight, keyTotal),
    dates: ratio(dateRight, dateTotal),
    amounts: ratio(amountRight, amountTotal),
    jointActions: ratio(jointRight, jointTurns),
    targets: ratio(targetRight, targetTotal),
    wrongAccount: bounded(wrong, decided),
    wrongAccountBiasedOnly: bounded(wrongBiased, decidedBiased),
    negation: ratio(negationRight, negationTurns),
    evidence: { ...ratio(evidenceSupported, evidenceItems), unquotedLinked },
    conflicts: {
      expected: conflictExpected,
      raised: conflictRaised,
      caught: conflictCaught,
      precision: conflictRaised === 0 ? null : conflictCaught / conflictRaised,
      recall: conflictExpected === 0 ? null : conflictCaught / conflictExpected,
    },
    flags: { ...ratio(flagged, finalProposals), byKind: sortKinds(byKind) },
    expectedFlags: Object.fromEntries(
      RiskKindV2.options.flatMap((kind) => {
        const entry = expectedFlags[kind];
        return entry ? [[kind, ratio(entry.n, entry.of)]] : [];
      }),
    ),
    seeded: Object.fromEntries(
      ERROR_KINDS.map((kind) => [kind, ratio(caught[kind], seeded[kind])]),
    ) as Record<ErrorKind, Ratio>,
    tiers: tierMetrics(tierItems, seededProposals),
    misses,
  };
}

function sortKinds(
  counts: Partial<Record<RiskKindV2, number>>,
): Partial<Record<RiskKindV2, number>> {
  return Object.fromEntries(
    RiskKindV2.options.flatMap((kind) =>
      counts[kind] === undefined ? [] : [[kind, counts[kind]]],
    ),
  );
}
