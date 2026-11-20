// `link(mention, ctx)` (spec WP4 step 6): candidates → features → calibrated p → link, ask, new,
// or none. Pure; SessionDO's understanding step calls it once per proposal target (WP8).
import { CANDIDATE_SOURCES, type CandidateSource, findCandidates } from "./candidates";
import { decide } from "./decide";
import { type CandidateFeatures, type FeatureName, type Features, featuresOf } from "./features";
import type { EntityKind, LinkIndex, TargetBasis, TargetCandidate, TargetDecision } from "./index";
import { sigmoid } from "./model";
import type { LinkerParams } from "./params";
import { type PreparedMention, prepareMention } from "./tokens";

export const ENTITY_KINDS: readonly EntityKind[] = ["company", "contact", "deal"];

/** The words that named a record, as the extractor quotes them (WP8's tool schema v2). */
export interface MentionInput {
  readonly text: string;
  /** The kind the model said the record is, or null. */
  readonly kind: EntityKind | null;
  /** The company said in the same breath ("Kathryn Moore from Blue Harbor"). */
  readonly companyText?: string | null;
}

/** What the candidates and their features are computed from. */
export interface RowContext {
  readonly index: LinkIndex;
  /** The account open in Earshot (`start.focusEntityId`). */
  readonly focusEntityId: string | null;
  /** Records linked earlier in the session, most recent first. */
  readonly recent: readonly string[];
  /** The turn's other mentions: their companies count as said in the turn (`parentCtx`). */
  readonly turnMentions: readonly MentionInput[];
  /**
   * The record kinds the proposal type allows (spec §4.4: candidates are filtered to them).
   * Every kind when absent.
   */
  readonly kinds?: readonly EntityKind[];
  /**
   * The candidate sources to use; all of them when absent. Without both sound sources (an
   * ablation), nothing is tied by sound either.
   */
  readonly sources?: readonly CandidateSource[];
}

export interface LinkContext extends Omit<RowContext, "sources"> {
  readonly params: LinkerParams;
}

export interface LinkResult {
  readonly decision: TargetDecision;
  /** The linked record; set exactly when the decision is "linked". */
  readonly entityId: string | null;
  /**
   * Calibrated: the linked record's p; for "new", the share of probability no candidate claims
   * (1 minus their sum, at least 0); for "ask", the best candidate's p, so a risk–coverage sweep
   * can admit it; null for "none". Candidates' p never sum past 1 (`candidateProbabilities`).
   */
  readonly p: number | null;
  /** Why it linked (null unless linked): exact, sound, or context (spec §4.4). */
  readonly basis: TargetBasis | null;
  /** At most 4, most likely first: the top 3 records, plus "new" (a null id) where it applies. */
  readonly candidates: readonly TargetCandidate[];
  /** The best candidate's features. For tests and evals only; product code doesn't read them. */
  readonly features?: Readonly<Record<string, number>>;
}

/** p of a candidate under a parameter set: the logistic function of its weighted features. */
export function probability(params: LinkerParams, features: Features): number {
  let z = params.bias;
  for (const feature of params.features) z += (params.weights[feature] ?? 0) * features[feature];
  return sigmoid(z);
}

/**
 * Whether a mention may become a new record: it was named as a company or a contact, and the
 * proposal type allows that kind. Never a deal (Phase 4 has no create-deal proposal), never an
 * unknown kind.
 */
export function canBeNew(kind: EntityKind | null, kinds: readonly EntityKind[]): boolean {
  return (kind === "company" || kind === "contact") && kinds.includes(kind);
}

export type CandidateRow = CandidateFeatures;

/** The candidates for a mention with their features, in prefilter order: what the fit learns from. */
export function candidateRows(mention: MentionInput, context: RowContext): CandidateRow[] {
  return rowsFor(prepareMention(mention.text), mention, context);
}

function rowsFor(
  prepared: PreparedMention,
  mention: MentionInput,
  context: RowContext,
): CandidateRow[] {
  if (prepared.phrase.tokens.length === 0) return [];
  const recent = new Set(context.recent);
  const candidates = findCandidates(prepared, context.index, {
    kinds: context.kinds ?? ENTITY_KINDS,
    focusEntityId: context.focusEntityId,
    recent,
    ...(context.sources === undefined ? {} : { sources: context.sources }),
  });
  const companies: string[] = [];
  const addCompany = (text: string | null | undefined) => {
    if (text && text.trim() !== "" && !companies.includes(text)) companies.push(text);
  };
  addCompany(mention.companyText);
  for (const other of context.turnMentions) {
    if (other.kind === "company") addCompany(other.text);
    addCompany(other.companyText);
  }
  const sources = context.sources ?? CANDIDATE_SOURCES;
  return featuresOf(prepared, candidates, {
    kind: mention.kind,
    sound: sources.includes("sound") || sources.includes("homophone"),
    companies: companies.map(prepareMention),
    focusEntityId: context.focusEntityId,
    recent,
    index: context.index,
  });
}

/** The features that come from context rather than from the words: what `basis` tests. */
const CONTEXT_FEATURES: readonly FeatureName[] = ["parentCtx", "focus", "recent", "rivalContext"];

/**
 * Each candidate's p, in the rows' order: the model's, scaled down so they sum to 1 when they sum
 * past it. The candidates are rival answers to one question, and the model scores each alone, so
 * a group it can't separate ("MSC": two companies) can claim more than certainty between them.
 * Scaling keeps their order and leaves the usual case, a clear winner and a remainder for "new",
 * as the model gave it. `withContext: false` scores the words alone, for `basis`.
 */
export function candidateProbabilities(
  params: LinkerParams,
  rows: readonly CandidateRow[],
  withContext = true,
): number[] {
  const p = rows.map((row) =>
    probability(
      params,
      withContext
        ? row.features
        : ({
            ...row.features,
            ...Object.fromEntries(CONTEXT_FEATURES.map((name) => [name, 0])),
          } as Features),
    ),
  );
  const total = p.reduce((sum, value) => sum + value, 0);
  return total > 1 ? p.map((value) => value / total) : p;
}

interface Scored {
  readonly row: CandidateRow;
  readonly p: number;
}

function ranked(rows: readonly CandidateRow[], params: LinkerParams, withContext = true): Scored[] {
  const p = candidateProbabilities(params, rows, withContext);
  return rows.map((row, k) => ({ row, p: p[k] ?? 0 })).sort((a, b) => b.p - a.p);
}

/**
 * Why a record was linked: "context" for a deal named only by its company (spec §4.3), and for a
 * link the words alone wouldn't make (without the company said, the open account, and earlier
 * links, the rule wouldn't link the same record); otherwise "exact" for a name, alias, or spoken
 * deal name said exactly, and "sound" for the rest.
 */
function basisOf(
  scored: readonly Scored[],
  rows: readonly CandidateRow[],
  params: LinkerParams,
  newAllowed: boolean,
): TargetBasis {
  const top = scored[0]?.row;
  if (!top) return "sound";
  const byCompany =
    top.kind === "deal" &&
    (top.exactRole === "company" || (top.exactRole === null && top.soundRole === "company"));
  if (byCompany) return "context";
  const words = ranked(rows, params, false);
  const alone = decide(
    words.map((entry) => entry.p),
    newAllowed,
    params.thresholds,
  );
  if (alone !== "linked" || words[0]?.row !== top) return "context";
  return top.exactRole === null ? "sound" : "exact";
}

function byLikelihood(a: TargetCandidate, b: TargetCandidate): number {
  return b.p - a.p || (a.entityId === null ? 1 : 0) - (b.entityId === null ? 1 : 0);
}

const NONE: LinkResult = { decision: "none", entityId: null, p: null, basis: null, candidates: [] };

/**
 * Resolves a mention against the session's records (spec §4.4, WP4):
 * - linked: one record, p1 ≥ τ_link and ahead of the next by δ;
 * - new: the candidates' total p below τ_new, for a company or contact the proposal type allows,
 *   or no candidate at all;
 * - ask: anything else, with the top 3 records, plus "new" when p1 < τ_link and it may be new;
 * - none: no candidate and it can't be new (a deal, an unknown kind), or no words to match.
 */
export function link(mention: MentionInput, ctx: LinkContext): LinkResult {
  const { params } = ctx;
  const kinds = ctx.kinds ?? ENTITY_KINDS;
  const newAllowed = canBeNew(mention.kind, kinds);
  const prepared = prepareMention(mention.text);
  if (prepared.phrase.tokens.length === 0) return NONE;
  const rows = rowsFor(prepared, mention, { ...ctx, sources: params.sources });
  if (rows.length === 0) {
    return newAllowed
      ? {
          decision: "new",
          entityId: null,
          p: 1,
          basis: null,
          candidates: [{ entityId: null, p: 1 }],
        }
      : NONE;
  }
  const scored = ranked(rows, params);
  const [top] = scored;
  if (!top) return NONE;
  const decision = decide(
    scored.map((entry) => entry.p),
    newAllowed,
    params.thresholds,
  );
  const records: TargetCandidate[] = scored
    .slice(0, 3)
    .map((entry) => ({ entityId: entry.row.entityId, p: entry.p }));
  const pNew = Math.max(0, 1 - scored.reduce((sum, entry) => sum + entry.p, 0));
  const features = top.row.features;
  if (decision === "linked") {
    return {
      decision,
      entityId: top.row.entityId,
      p: top.p,
      basis: basisOf(scored, rows, params, newAllowed),
      candidates: records,
      features,
    };
  }
  if (decision === "new") {
    return {
      decision,
      entityId: null,
      p: pNew,
      basis: null,
      candidates: [{ entityId: null, p: pNew }, ...records].sort(byLikelihood),
      features,
    };
  }
  const offerNew = newAllowed && top.p < params.thresholds.tauLink;
  return {
    decision: "ask",
    entityId: null,
    p: top.p,
    basis: null,
    candidates: (offerNew ? [...records, { entityId: null, p: pNew }] : records).sort(byLikelihood),
    features,
  };
}

/** `link_uncertain` (spec §4.4): a link that isn't an exact name or alias, with p below 0.97 (target). */
export const LINK_UNCERTAIN_BELOW = 0.97;

export function isLinkUncertain(result: LinkResult): boolean {
  return (
    result.decision === "linked" &&
    result.basis !== "exact" &&
    (result.p ?? 0) < LINK_UNCERTAIN_BELOW
  );
}
