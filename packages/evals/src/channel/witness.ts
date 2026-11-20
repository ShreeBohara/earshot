// The two witnesses (spec WP3 step 1, §4.6). Both hear what the rep said through the same
// mishearing rules; they differ in what happens next.
//
// - The biased witness is the production stream, primed with the session's keyterms. An in-list
//   spelling that sounds exactly like what it heard always wins (uniformly, when several do: the
//   confusable group's spellings), and one a word away wins with probability `pSnap`.
// - The unbiased witness has no keyterms. It never snaps; it writes unusual names the common way
//   and sometimes changes a consonant.
//
// Each returns the text it wrote and the rules that acted, for the set's `noise` field.
import type { EntityKind, EntityRef } from "@earshot/core";
import { MISHEAR_OPS, type MishearOp, opCandidates } from "./ops";
import { CHANNEL_PARAMS, type WitnessParams } from "./params";
import type { Rng } from "./rng";
import { alignPhrase, soundWords } from "./sound";

export interface Heard {
  readonly text: string;
  /** The rules that acted, in order: mishearing rules, then "snap" or "snap-same". */
  readonly ops: readonly string[];
}

/** One mishearing, drawn from a witness's rule weights among the rules that apply. */
export function mishear(
  said: string,
  kind: EntityKind,
  weights: WitnessParams["ops"],
  rng: Rng,
): { text: string; op: MishearOp } | null {
  const options: Partial<Record<MishearOp, string[]>> = {};
  const usable: Partial<Record<MishearOp, number>> = {};
  for (const op of MISHEAR_OPS) {
    const weight = weights[op] ?? 0;
    if (weight <= 0) continue;
    const candidates = opCandidates(op, said, kind);
    if (candidates.length === 0) continue;
    options[op] = candidates;
    usable[op] = weight;
  }
  if (Object.keys(usable).length === 0) return null;
  const op = rng.weighted(usable as Record<MishearOp, number>);
  return { text: rng.pick(options[op] ?? []), op };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** An in-list spelling as a stream writes it: words only, so a deal's " - " is a space. */
function spoken(term: string): string {
  // Splitting on whitespace and dropping lone hyphens is linear; /\s+-\s+/g backtracks on long
  // runs of spaces.
  return term
    .split(/\s+/)
    .filter((word) => word !== "-")
    .join(" ");
}

/**
 * The session's keyterms, as `apps/web/lib/voice/keyterms.ts` builds them for AssemblyAI: the
 * open account, its contacts, its deals, then the other companies (by name, since every demo
 * row has the same `updated_at`); each source's name and then its aliases, without repeats
 * ignoring case, at least 2 and at most 50 characters, the first `maxTerms`. With no account
 * open that's the companies alone, and the last ones alphabetically don't make the cut.
 */
export function keytermList(
  entities: readonly EntityRef[],
  focusEntityId: string | null,
  maxTerms: number = CHANNEL_PARAMS.biased.maxKeyterms,
): string[] {
  const byName = (a: EntityRef, b: EntityRef) => compare(a.name, b.name) || compare(a.id, b.id);
  const account = entities.find((row) => row.id === focusEntityId && row.kind === "company");
  const belongs = (row: EntityRef) => account !== undefined && row.parentId === account.id;
  const ofKind = (kind: EntityKind, include: (row: EntityRef) => boolean) =>
    entities.filter((row) => row.kind === kind && include(row)).sort(byName);
  const sources = [
    ...(account ? [account] : []),
    ...ofKind("contact", belongs),
    ...ofKind("deal", belongs),
    ...ofKind("company", (row) => row !== account),
  ];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const { name, aliases } of sources) {
    for (const raw of [name, ...aliases]) {
      const term = raw.normalize("NFC").replace(/\s+/g, " ").trim();
      if ([...term].length < 2 || term.length > 50 || seen.has(term.toLowerCase())) continue;
      seen.add(term.toLowerCase());
      terms.push(term);
    }
  }
  return terms.slice(0, maxTerms);
}

export type NearSnap = "natural" | "never" | "force";

/**
 * The keyterm bias on what the biased witness heard: the in-list spellings that sound exactly
 * like it, one chosen uniformly; failing those, with probability `pSnap` (always with "force",
 * never with "never"), the nearest spelling one word away. Whole phrases only: a keyterm never
 * replaces part of what was heard.
 */
export function snapToKeyterms(
  heard: string,
  keyterms: readonly string[],
  rng: Rng,
  nearSnap: NearSnap = "natural",
): Heard {
  const words = soundWords(heard);
  const same: string[] = [];
  const near: { term: string; distance: number }[] = [];
  for (const term of keyterms) {
    const match = alignPhrase(words, soundWords(term), { prefix: false, maxNear: 1 });
    if (match === null) continue;
    if (match.near === 0) same.push(spoken(term));
    else near.push({ term: spoken(term), distance: match.distance });
  }
  if (same.length > 0) {
    const text = rng.pick([...new Set(same)]);
    return { text, ops: text === heard ? [] : ["snap-same"] };
  }
  if (near.length === 0 || nearSnap === "never") return { text: heard, ops: [] };
  if (nearSnap === "natural" && !rng.chance(CHANNEL_PARAMS.biased.pSnap)) {
    return { text: heard, ops: [] };
  }
  const least = Math.min(...near.map((option) => option.distance));
  const nearest = near.filter((option) => option.distance <= least + 1e-12);
  return { text: rng.pick([...new Set(nearest.map((option) => option.term))]), ops: ["snap"] };
}

export interface HearOptions {
  /** "natural" draws from `pMishear`; "never" and "always" decide it. */
  readonly mishear?: "natural" | "never" | "always";
  /** Use this rule when mishearing, instead of drawing one. */
  readonly op?: MishearOp;
}

function heardBy(
  said: string,
  kind: EntityKind,
  params: WitnessParams,
  rng: Rng,
  options: HearOptions,
): Heard {
  const mode = options.mishear ?? "natural";
  const misheard = mode === "always" || (mode === "natural" && rng.chance(params.pMishear));
  if (!misheard) return { text: said, ops: [] };
  if (options.op) {
    const candidates = opCandidates(options.op, said, kind);
    return candidates.length === 0
      ? { text: said, ops: [] }
      : { text: rng.pick(candidates), ops: [options.op] };
  }
  const result = mishear(said, kind, params.ops, rng);
  return result ? { text: result.text, ops: [result.op] } : { text: said, ops: [] };
}

/** What the biased witness writes for a name: a mishearing, then the keyterm bias. */
export function hearBiased(
  said: string,
  kind: EntityKind,
  keyterms: readonly string[],
  rng: Rng,
  options: HearOptions & { readonly nearSnap?: NearSnap } = {},
): Heard {
  const first = heardBy(said, kind, CHANNEL_PARAMS.biased, rng, options);
  const snapped = snapToKeyterms(first.text, keyterms, rng, options.nearSnap ?? "natural");
  return { text: snapped.text, ops: [...first.ops, ...snapped.ops] };
}

/** What the unbiased witness writes for a name: a mishearing at most, and never a snap. */
export function hearUnbiased(
  said: string,
  kind: EntityKind,
  rng: Rng,
  options: HearOptions = {},
): Heard {
  return heardBy(said, kind, CHANNEL_PARAMS.unbiased, rng, options);
}
