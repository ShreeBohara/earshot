// Candidates (spec §4.4): the union of the sources below, filtered to the record kinds the
// proposal type allows, with the top 8 by a prefilter score kept for scoring.
//
// - exact: the mention's matching form is a record's name, alias, or spoken deal name;
// - sound: a word of the mention shares a Double Metaphone code with a word of a record's form
//   ("Nite" and "Knight": NT; "Akme" and "Acme": AKM);
// - homophone: a word of the mention is a listed homophone of one ("Sean" and "Shawn": SN and XN,
//   which share no code; WP3's finding);
// - trigram: pg_trgm's `similarity` or `word_similarity` at or above 0.2, below pg_trgm's 0.3
//   default because short names score low ("Akme" and "Acme" score 0.25);
// - initials: the mention is a company's initials or an abbreviation alias ("MSC", "M. S. C.");
// - family: the open account and its contacts and deals, when the mention is one word.
import { wordSimilarity } from "../names";
import type { EntityKind, FormRef, LinkIndex, LinkRecord } from "./index";
import { HOMOPHONE_KEY, type PreparedMention } from "./tokens";

export const CANDIDATE_SOURCES = [
  "exact",
  "sound",
  "homophone",
  "trigram",
  "initials",
  "family",
] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

/** How many candidates are scored (spec §4.4). */
export const MAX_CANDIDATES = 8;
/** The trigram source's threshold on `similarity` or `word_similarity` (target). */
export const TRIGRAM_MIN = 0.2;
/** A mention this many words long or shorter brings in the open account's family. */
const SHORT_MENTION = 1;
/** The prefilter score of a record only the family source found. */
const FAMILY_SCORE = 0.25;
/** Added to the prefilter for the open account's family, and again for an earlier link. */
const CONTEXT_BONUS = 0.1;

export interface Candidate {
  readonly record: LinkRecord;
  /** The sources that found it, in `CANDIDATE_SOURCES` order. */
  readonly sources: readonly CandidateSource[];
  /**
   * What the top 8 are kept by: the best source's score in [0, 1] (1 for an exact form or
   * initials; for sound, the share of the mention's words it has a sound-alike for; for
   * trigrams, the better of `similarity` and `word_similarity`), plus 0.1 for the open account's
   * family and 0.1 for an earlier link.
   */
  readonly prefilter: number;
}

export interface CandidateOptions {
  /** The record kinds the proposal type allows. */
  readonly kinds: readonly EntityKind[];
  readonly focusEntityId: string | null;
  /** Records linked earlier in the session. */
  readonly recent: ReadonlySet<string>;
  /** The sources to use; all of them by default (an ablation drops some). */
  readonly sources?: readonly CandidateSource[];
  /** How many to keep; `MAX_CANDIDATES` by default. */
  readonly max?: number;
}

interface Hit {
  readonly sources: Set<CandidateSource>;
  score: number;
}

/** The candidates for a mention, best prefilter first, ties in the session's order. */
export function findCandidates(
  mention: PreparedMention,
  index: LinkIndex,
  options: CandidateOptions,
): Candidate[] {
  const said = mention.phrase;
  if (said.tokens.length === 0) return [];
  const sources = new Set(options.sources ?? CANDIDATE_SOURCES);
  const kinds = new Set(options.kinds);
  const hits = new Map<LinkRecord, Hit>();
  const hit = (record: LinkRecord, source: CandidateSource, score: number) => {
    if (!kinds.has(record.entity.kind)) return;
    let found = hits.get(record);
    if (!found) {
      found = { sources: new Set(), score: 0 };
      hits.set(record, found);
    }
    found.sources.add(source);
    if (score > found.score) found.score = score;
  };

  if (sources.has("exact")) {
    for (const record of index.byForm.get(said.text) ?? []) hit(record, "exact", 1);
  }

  // Sound and homophones together: which of the mention's words each record has a sound-alike
  // for, through a code or the homophone list. Two words run together count for both.
  const matched = new Map<LinkRecord, { words: Set<number>; by: Set<CandidateSource> }>();
  const look = (keys: readonly string[], at: readonly number[]) => {
    for (const key of keys) {
      const source: CandidateSource = key.startsWith(HOMOPHONE_KEY) ? "homophone" : "sound";
      if (!sources.has(source)) continue;
      for (const record of index.byKey.get(key) ?? []) {
        let found = matched.get(record);
        if (!found) {
          found = { words: new Set(), by: new Set() };
          matched.set(record, found);
        }
        for (const position of at) found.words.add(position);
        found.by.add(source);
      }
    }
  };
  said.tokens.forEach((word, k) => {
    look(word.keys, [k]);
  });
  said.pairs.forEach((pair, k) => {
    look(pair.keys, [k, k + 1]);
  });
  for (const [record, found] of matched) {
    for (const source of found.by) hit(record, source, found.words.size / said.tokens.length);
  }

  if (sources.has("trigram") && said.trigrams.length > 0) {
    const shared = new Map<FormRef, number>();
    for (const trigram of said.trigrams) {
      for (const ref of index.byTrigram.get(trigram) ?? [])
        shared.set(ref, (shared.get(ref) ?? 0) + 1);
    }
    for (const [ref, count] of shared) {
      if (!kinds.has(ref.record.entity.kind)) continue;
      let score = count / (said.trigrams.length + ref.form.phrase.trigrams.length - count);
      // `word_similarity` can't beat the share of the mention's trigrams the form has at all.
      if (score < TRIGRAM_MIN && count / said.trigrams.length >= TRIGRAM_MIN) {
        score = Math.max(score, wordSimilarity(said.text, ref.form.phrase.text));
      }
      if (score >= TRIGRAM_MIN) hit(ref.record, "trigram", score);
    }
  }

  if (sources.has("initials")) {
    const letters = mention.spelled;
    if (!letters.includes(" ") && Array.from(letters).length >= 2) {
      for (const record of index.byAbbreviation.get(letters) ?? []) hit(record, "initials", 1);
    }
  }

  const focus = options.focusEntityId === null ? undefined : index.byId.get(options.focusEntityId);
  if (sources.has("family") && focus && said.tokens.length <= SHORT_MENTION) {
    hit(focus, "family", FAMILY_SCORE);
    for (const child of index.children.get(focus.entity.id) ?? [])
      hit(child, "family", FAMILY_SCORE);
  }

  const candidates: Candidate[] = [];
  for (const [record, found] of hits) {
    const inFamily =
      focus !== undefined && (record === focus || record.entity.parentId === focus.entity.id);
    const prefilter =
      found.score +
      (inFamily ? CONTEXT_BONUS : 0) +
      (options.recent.has(record.entity.id) ? CONTEXT_BONUS : 0);
    candidates.push({
      record,
      sources: CANDIDATE_SOURCES.filter((source) => found.sources.has(source)),
      prefilter,
    });
  }
  candidates.sort((a, b) => b.prefilter - a.prefilter || a.record.position - b.record.position);
  return candidates.slice(0, options.max ?? MAX_CANDIDATES);
}
