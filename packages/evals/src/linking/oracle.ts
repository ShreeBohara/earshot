// The set's ground truth for "the best possible decision" (spec §4.5's `expect`): what a linker
// that knew the simulator's rules would decide from what it was given. The generator labels each
// item with it and refuses an item whose class it contradicts; a test runs it again over the
// committed file. It isn't a linker: it knows which mishearings the channel makes, and it reads
// the homophone list, which the product's phonetic keys don't have.
//
// The rules:
// 1. A mention names the records whose spoken forms it sounds the same as, word for word, from
//    the start of the form ("Juniper Bay" names Juniper Bay Telecom), among records of the kind
//    the model gave and the proposal type allows.
// 2. One record: link it. The biased witness keeps a CRM name's sound (its own mistakes are
//    same-sound ones, plus dropped words), so a different sound means a different name.
// 3. None: a new record, for a company or contact. A deal has no "new" in Phase 4, so it asks.
// 4. Several: the context narrows them. The company said in the same breath keeps the records
//    whose parent it names; the open account keeps itself and its children; earlier links keep
//    themselves. One left: link it. None or several: ask.
import type { EntityKind, ProposalType } from "@earshot/core";
import { alignPhrase, soundWords } from "../channel/sound";
import { companyOf, entitiesOfKind, spokenForms } from "./entities";

/** The record kinds each proposal type may target, as Phase 3's `TARGET_KINDS` has them. */
export const TYPE_KINDS: Readonly<Record<ProposalType, readonly EntityKind[]>> = {
  note: ["company", "contact", "deal"],
  task: ["company", "contact", "deal"],
  contact: ["contact"],
  deal_update: ["deal"],
  commitment: ["company", "contact", "deal"],
};

const FORMS: ReadonlyMap<
  EntityKind,
  readonly { id: string; words: ReturnType<typeof soundWords> }[]
> = new Map(
  (["company", "contact", "deal"] as const).map((kind) => [
    kind,
    entitiesOfKind(kind).flatMap((entity) =>
      spokenForms(entity).map((form) => ({ id: entity.id, words: soundWords(form) })),
    ),
  ]),
);

/** The records of a kind a mention sounds like (rule 1), in the session's order. */
export function soundMatches(mention: string, kind: EntityKind): string[] {
  const words = soundWords(mention);
  if (words.length === 0) return [];
  const ids: string[] = [];
  for (const form of FORMS.get(kind) ?? []) {
    if (ids.includes(form.id)) continue;
    if (alignPhrase(words, form.words, { prefix: true, maxNear: 0 }) !== null) ids.push(form.id);
  }
  return ids;
}

/** What a linker is given about one mention, from one witness's transcript. */
export interface Observation {
  readonly type: ProposalType;
  readonly kind: EntityKind;
  readonly mention: string;
  /** The company said in the same breath, as heard. */
  readonly company: string | null;
  readonly focusEntityId: string | null;
  readonly recent: readonly string[];
}

export type Cue = "company" | "focus" | "recent";

export interface Resolution {
  readonly decision: "link" | "new" | "ask";
  /** The record linked; null otherwise. */
  readonly entityId: string | null;
  /** The records the mention sounds like. */
  readonly matches: readonly string[];
  /** The context that narrowed several matches to one; empty when sound alone decided. */
  readonly cues: readonly Cue[];
}

/** The best possible decision for an observation (rules 1 to 4). */
export function resolve(observation: Observation): Resolution {
  const { type, kind } = observation;
  if (!TYPE_KINDS[type].includes(kind)) {
    return { decision: "ask", entityId: null, matches: [], cues: [] };
  }
  const matches = soundMatches(observation.mention, kind);
  if (matches.length === 1) {
    return { decision: "link", entityId: matches[0] ?? null, matches, cues: [] };
  }
  if (matches.length === 0) {
    const canBeNew = kind !== "deal";
    return { decision: canBeNew ? "new" : "ask", entityId: null, matches, cues: [] };
  }
  // Each cue on its own: it informs when it keeps some matches but not all. Informative cues
  // must agree; a cue that keeps none (an unrelated open account) says nothing.
  let left = matches;
  const cues: Cue[] = [];
  const narrow = (cue: Cue, keep: (id: string) => boolean) => {
    const kept = matches.filter(keep);
    if (kept.length === 0 || kept.length === matches.length) return;
    left = left.filter((id) => kept.includes(id));
    cues.push(cue);
  };
  if (observation.company !== null && kind !== "company") {
    const named = new Set(soundMatches(observation.company, "company"));
    narrow("company", (id) => named.has(companyOf(id) ?? ""));
  }
  const focus = observation.focusEntityId;
  if (focus !== null) narrow("focus", (id) => companyOf(id) === focus || id === focus);
  if (observation.recent.length > 0) narrow("recent", (id) => observation.recent.includes(id));
  if (left.length === 1) return { decision: "link", entityId: left[0] ?? null, matches, cues };
  return { decision: "ask", entityId: null, matches, cues };
}
