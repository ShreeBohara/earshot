// The linker's features (spec §4.4, and one more), one row per candidate. Each is in [0, 1] except
// `parentCtx` (−1 to 1) and `tieCount` (0 to log 8). Where a record has several forms (a name,
// aliases, a deal's spoken names), a feature takes its best form.
//
// | Feature       | Meaning                                                                      |
// |---------------|------------------------------------------------------------------------------|
// | exact         | The mention's matching form equals a name, alias, or spoken deal name         |
// | aliasShared   | That form belongs to two or more records of the kind ("Northwind", "MSC")     |
// | phonFull      | 1 minus the normalized edit distance between the run-together codes, against  |
// |               | the form and each proper prefix of its words (a rep may stop early)           |
// | phonHead      | The first significant words sound the same                                   |
// | trgm          | max(`similarity`, `word_similarity`), as pg_trgm computes them                |
// | jw            | Jaro–Winkler on the matching forms                                           |
// | tailCover     | Share of the record's distinguishing words heard in the mention (a deal's    |
// |               | tail: "onboarding" against "expansion"; "Labs" against "Logistics")           |
// | initials      | The mention is the company's initials or an abbreviation alias               |
// | kindMatch     | The model's kind is the record's: 1; unknown: 0.5; another: 0                 |
// | parentCtx     | Contacts and deals, when a company was said in the turn: 1 when it sounds    |
// |               | like the record's parent, falling to −1 as it sounds less like it; else 0     |
// | focus         | The record is the open account, or belongs to it                             |
// | recent        | Linked earlier in this session                                               |
// | tieCount      | log(1 + other candidates of the kind within 0.05 on phonFull)                |
// | rivalContext  | One of those tied candidates has more context than this one: the company    |
// |               | said names its parent, it's in the open account's family, or it was linked   |
// |               | earlier, where this one isn't (a 14th feature; see below)                    |
//
// `rivalContext` isn't in the spec's list. A per-candidate model can't otherwise tell the two ways
// a homophone can lose: as the sibling of a record context picked out ("Akme Dynamics" with Acme
// Dynamics open: Akme and Acmi lose), or in a group nothing separates ("Northwind" alone, with no
// account open). Both look the same to the 13 features, and the first is far commoner, so the fit
// gave every member of an unseparated group a p near 0.1. Their total then fell under τ_new, and
// "Northwind" or "MSC" alone came out "new": a duplicate of a record the CRM has. With the 14th,
// an unseparated group shares its probability, and the linker asks.
import { jaroWinkler, trigramSimilarity, wordSimilarity } from "../names";
import type { Candidate, CandidateSource } from "./candidates";
import type { EntityKind, FormRole, LinkForm, LinkIndex, LinkRecord } from "./index";
import { codeSimilarity, heard, type Phrase, type PreparedMention, sameHead } from "./tokens";

export const FEATURE_NAMES = [
  "exact",
  "aliasShared",
  "phonFull",
  "phonHead",
  "trgm",
  "jw",
  "tailCover",
  "initials",
  "kindMatch",
  "parentCtx",
  "focus",
  "recent",
  "tieCount",
  "rivalContext",
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export type Features = Readonly<Record<FeatureName, number>>;

/** Candidates whose `phonFull` is this close count as tied (spec §4.4). */
export const TIE_WINDOW = 0.05;

/** A candidate with its features, as the model scores it and the fit learns from it. */
export interface CandidateFeatures {
  readonly entityId: string;
  readonly kind: EntityKind;
  readonly sources: readonly CandidateSource[];
  readonly features: Features;
  /** The role of the form the mention equals, or null when it equals none. */
  readonly exactRole: FormRole | null;
  /** The role of the form that sounds most like the mention (the first of equals). */
  readonly soundRole: FormRole;
}

export interface FeatureContext {
  /** The kind the model gave the mention, or null. */
  readonly kind: EntityKind | null;
  /**
   * Whether ties may be called by sound (`tieCount`, `rivalContext`, and shared spelling scores).
   * False only for an ablation without sound, which then has no notion of sounding alike at all.
   */
  readonly sound: boolean;
  /** The company said in the same breath, and the companies named elsewhere in the turn. */
  readonly companies: readonly PreparedMention[];
  readonly focusEntityId: string | null;
  readonly recent: ReadonlySet<string>;
  readonly index: LinkIndex;
}

/**
 * How much a phrase sounds like a form, in [0, 1]: its run-together codes against the form's and
 * against each proper prefix of the form's words. 1 for the same matching form.
 */
function soundsLike(said: Phrase, form: LinkForm): number {
  if (said.text === form.phrase.text) return 1;
  return Math.max(
    codeSimilarity(said.codes, form.phrase.codes),
    codeSimilarity(said.codes, form.prefixes),
  );
}

/**
 * 1 when a company said in the turn sounds like the record's parent (a name or alias, or the
 * start of one: "Quarry" for "Quarry Lane Media"); falling linearly to −1 as the best company's
 * codes reach 75% alike and below; 0 when no company was said, or the record has no parent the
 * index knows.
 */
function parentContext(record: LinkRecord, context: FeatureContext): number {
  if (record.entity.kind === "company" || context.companies.length === 0) return 0;
  const parentId = record.entity.parentId;
  const parent = parentId === undefined ? undefined : context.index.byId.get(parentId);
  if (!parent) return 0;
  let best = 0;
  for (const company of context.companies) {
    for (const form of parent.forms) best = Math.max(best, soundsLike(company.phrase, form));
  }
  if (best >= 1) return 1;
  return Math.min(1, Math.max(-1, 4 * best - 3));
}

/** Every candidate's features, in the candidates' order. */
export function featuresOf(
  mention: PreparedMention,
  candidates: readonly Candidate[],
  context: FeatureContext,
): CandidateFeatures[] {
  const said = mention.phrase;
  const spelled =
    !mention.spelled.includes(" ") && Array.from(mention.spelled).length >= 2
      ? mention.spelled
      : null;
  const rows = candidates.map((candidate) => {
    const { record } = candidate;
    const kind = record.entity.kind;
    let exactRole: FormRole | null = null;
    let soundRole: FormRole = record.forms[0]?.role ?? "name";
    let phonFull = 0;
    let phonHead = 0;
    let trgm = 0;
    let jw = 0;
    for (const form of record.forms) {
      if (exactRole === null && said.text === form.phrase.text) exactRole = form.role;
      const sound = soundsLike(said, form);
      if (sound > phonFull) {
        phonFull = sound;
        soundRole = form.role;
      }
      if (phonHead === 0 && sameHead(said, form.phrase)) phonHead = 1;
      trgm = Math.max(
        trgm,
        trigramSimilarity(said.trigrams, form.phrase.trigrams),
        wordSimilarity(said.text, form.phrase.text),
      );
      jw = Math.max(jw, jaroWinkler(said.text, form.phrase.text));
    }
    const aliasShared =
      exactRole !== null &&
      (context.index.byForm.get(said.text) ?? []).filter((other) => other.entity.kind === kind)
        .length >= 2;
    const flags = heard(record.tail, record.tailPairs, said);
    let distinguishing = 0;
    let caught = 0;
    record.distinguishing.forEach((counts, k) => {
      if (!counts) return;
      distinguishing++;
      if (flags[k]) caught++;
    });
    const features: Record<FeatureName, number> = {
      exact: exactRole === null ? 0 : 1,
      aliasShared: aliasShared ? 1 : 0,
      phonFull,
      phonHead,
      trgm,
      jw,
      tailCover: distinguishing === 0 ? 0 : caught / distinguishing,
      initials: spelled !== null && record.abbreviations.includes(spelled) ? 1 : 0,
      kindMatch: context.kind === null ? 0.5 : context.kind === kind ? 1 : 0,
      parentCtx: parentContext(record, context),
      focus:
        context.focusEntityId !== null &&
        (record.entity.id === context.focusEntityId ||
          record.entity.parentId === context.focusEntityId)
          ? 1
          : 0,
      recent: context.recent.has(record.entity.id) ? 1 : 0,
      tieCount: 0,
      rivalContext: 0,
    };
    return {
      entityId: record.entity.id,
      kind,
      sources: candidate.sources,
      features,
      exactRole,
      soundRole,
    };
  });
  const support = (features: Features) =>
    (features.parentCtx > 0 ? 1 : 0) + features.focus + features.recent;
  const spelling = rows.map(({ features }) => ({
    exact: features.exact,
    trgm: features.trgm,
    jw: features.jw,
  }));
  rows.forEach((row) => {
    const ties = context.sound
      ? rows.filter(
          (other) =>
            other !== row &&
            other.kind === row.kind &&
            Math.abs(other.features.phonFull - row.features.phonFull) <= TIE_WINDOW + 1e-9,
        )
      : [];
    row.features.tieCount = Math.log1p(ties.length);
    const own = support(row.features);
    row.features.rivalContext = ties.some((other) => support(other.features) > own) ? 1 : 0;
    // Spelling can't separate records that sound the same: a keyterm-biased stream writes
    // whichever spelling it likes (ADR-0028). So tied candidates share their best spelling scores.
    for (const other of ties) {
      const theirs = spelling[rows.indexOf(other)];
      if (!theirs) continue;
      row.features.exact = Math.max(row.features.exact, theirs.exact);
      row.features.trgm = Math.max(row.features.trgm, theirs.trgm);
      row.features.jw = Math.max(row.features.jw, theirs.jw);
    }
  });
  return rows;
}
