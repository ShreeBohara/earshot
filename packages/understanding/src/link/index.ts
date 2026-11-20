// The entity linker (spec §4.4, WP4): it resolves the words that named a record against the
// session's records, by sound, spelling, and context, and decides to link, ask, or propose a new
// record, with a calibrated probability. Pure and in memory: SessionDO builds the index once per
// session (and again when the object wakes) from `start`'s records, at most 250.
//
// This file holds the index, `buildLinkIndex`; the rest of the pipeline is re-exported below:
// candidates (candidates.ts) → features (features.ts) → p (model.ts) → decision (decide.ts), run
// by `link` (link.ts) with the frozen parameters in params.v1.json (params.ts).
import { foldName, initials, normalizeName } from "../names";
import {
  type Phrase,
  phrase,
  prefixCodes,
  type SoundToken,
  sameSoundToken,
  soundToken,
} from "./tokens";

/**
 * A CRM record's kind: `@earshot/core`'s `EntityKind`. The types this package shares with the
 * contracts are restated here rather than imported, because importing `@earshot/core` brings its
 * session tickets, whose Web Crypto types a program without the DOM or Worker library can't
 * resolve; a type test in @earshot/evals checks that both sides stay the same.
 */
export type EntityKind = "company" | "contact" | "deal";

/** `TargetV2.decision`: link one record, ask the rep, propose a new record, or none. */
export type TargetDecision = "linked" | "ask" | "new" | "none";

/** `TargetV2.basis`: why a target was linked. The linker gives exact, sound, or context. */
export type TargetBasis = "exact" | "sound" | "context" | "focus";

/** `TargetV2.candidates[]`: a record the target may be, or a new one (a null id), with its p. */
export interface TargetCandidate {
  readonly entityId: string | null;
  readonly p: number;
}

/** A record the linker may link: `EntityRef`'s shape, as `start` carries it (spec §4.2). */
export interface LinkEntity {
  readonly id: string;
  readonly kind: EntityKind;
  readonly name: string;
  readonly aliases: readonly string[];
  /** The company of a contact or deal. */
  readonly parentId?: string;
}

/**
 * Where a form comes from: the record's name; an alias; a deal's spoken name (its company's name
 * or an alias, then its tail: "Atmos onboarding package", with no dash); or a deal's company alone,
 * for a deal named by its company (spec §4.3).
 */
export type FormRole = "name" | "alias" | "spoken" | "company";

/** One way a record is named, ready to compare. */
export interface LinkForm {
  readonly role: FormRole;
  readonly phrase: Phrase;
  /** The codes of each proper prefix of its words, for a mention that stops early. */
  readonly prefixes: readonly string[];
}

/** A record as the index holds it. */
export interface LinkRecord {
  readonly entity: LinkEntity;
  /** Its place in the session's list, which breaks every tie. */
  readonly position: number;
  /** Its forms, distinct by matching form, in the order name, aliases, spoken names, company. */
  readonly forms: readonly LinkForm[];
  /** A company's initials and abbreviation aliases, folded ("msc"). Empty for others. */
  readonly abbreviations: readonly string[];
  /** The words `tailCover` reads: a company's or contact's name, a deal's tail. */
  readonly tail: readonly SoundToken[];
  /** Adjacent tail words run together, for a mention that joins them. */
  readonly tailPairs: readonly SoundToken[];
  /**
   * Which tail words tell it from its sound-alike siblings (records of its kind whose name, an
   * alias, or, for a deal, whose company starts with the same sound): those not every sibling
   * shares. All of them when it has no sibling, or when its siblings share every word.
   */
  readonly distinguishing: readonly boolean[];
}

/** A form and the record it names. */
export interface FormRef {
  readonly record: LinkRecord;
  readonly form: LinkForm;
}

/** The per-session index (spec §4.4): built once, read by every `link` call. */
export interface LinkIndex {
  /** Every record, in the session's order. */
  readonly records: readonly LinkRecord[];
  readonly byId: ReadonlyMap<string, LinkRecord>;
  /** Records by the matching form of a name, alias, or spoken deal name: the exact source. */
  readonly byForm: ReadonlyMap<string, readonly LinkRecord[]>;
  /** Records by the codes and homophone keys of their forms' words (and adjacent pairs). */
  readonly byKey: ReadonlyMap<string, readonly LinkRecord[]>;
  /** Forms by trigram, for pg_trgm's `similarity` without scanning every form. */
  readonly byTrigram: ReadonlyMap<string, readonly FormRef[]>;
  /** Companies by initials and abbreviation alias. */
  readonly byAbbreviation: ReadonlyMap<string, readonly LinkRecord[]>;
  /** Contacts and deals by their parent's id: an account's family. */
  readonly children: ReadonlyMap<string, readonly LinkRecord[]>;
}

/** What follows a deal's company in its CRM name: "Atmos Industrial - Onboarding package". */
const AFTER_COMPANY = /^\s*[-–—:|/]\s*/u;
/** The first separator in a deal name whose company isn't known. */
const SEPARATOR = /\s[-–—|/]\s|:\s/u;
/** An alias that's an abbreviation as written ("MSC", "PCE"): 2 to 6 capital letters. */
const CAPITALS = /^\p{Lu}{2,6}$/u;

/**
 * A deal's company forms and its tail. The CRM writes "Company - Tail"; nobody says the dash, so
 * the linker matches "Company Tail" and "Alias Tail" instead (WP3's finding).
 */
function dealParts(
  deal: LinkEntity,
  company: LinkEntity | undefined,
): { companyForms: readonly string[]; tail: string } {
  if (company) {
    const companyForms = [company.name, ...company.aliases];
    const lower = deal.name.toLowerCase();
    // Longest first, so "Acme Dynamics - X" isn't read as "Acme" followed by "Dynamics - X".
    for (const prefix of [...companyForms].sort((a, b) => b.length - a.length)) {
      if (!lower.startsWith(prefix.toLowerCase())) continue;
      const rest = deal.name.slice(prefix.length);
      const separator = AFTER_COMPANY.exec(rest);
      if (separator && rest.length > separator[0].length) {
        return { companyForms, tail: rest.slice(separator[0].length) };
      }
    }
    return { companyForms, tail: deal.name };
  }
  const separator = SEPARATOR.exec(deal.name);
  if (separator) {
    const head = deal.name.slice(0, separator.index).trim();
    const tail = deal.name.slice(separator.index + separator[0].length).trim();
    if (head !== "" && tail !== "") return { companyForms: [head], tail };
  }
  return { companyForms: [], tail: deal.name };
}

function abbreviationsOf(entity: LinkEntity): string[] {
  if (entity.kind !== "company") return [];
  const out = new Set<string>();
  if (foldName(entity.name).split(" ").length >= 2) {
    for (const letters of [initials(entity.name), initials(normalizeName(entity.name))]) {
      if (Array.from(letters).length >= 2) out.add(letters);
    }
  }
  const fromName = new Set(out);
  for (const alias of entity.aliases) {
    const folded = foldName(alias);
    if (folded.includes(" ") || folded === "") continue;
    if (fromName.has(folded) || CAPITALS.test(alias.trim())) out.add(folded);
  }
  return [...out];
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (list.at(-1) !== value) list.push(value);
}

/**
 * Builds the index over a session's records (spec §4.4): matching forms of names and aliases
 * (and of deals as they're said), Double Metaphone codes and homophone keys per word, trigram
 * sets, initials, how many records share each form, and the parent map. Under 5 ms for 250
 * records (target). Records keep the session's order, which breaks ties everywhere downstream.
 */
export function buildLinkIndex(entities: readonly LinkEntity[]): LinkIndex {
  const words = new Map<string, SoundToken>();
  const token = (word: string) => {
    let found = words.get(word);
    if (!found) {
      found = soundToken(word);
      words.set(word, found);
    }
    return found;
  };
  const phrases = new Map<string, Phrase>();
  const phraseOf = (text: string) => {
    let found = phrases.get(text);
    if (!found) {
      found = phrase(text, token);
      phrases.set(text, found);
    }
    return found;
  };

  const ids = new Map(entities.map((entity) => [entity.id, entity]));
  const drafts = entities.map((entity, position) => {
    const parent = entity.parentId === undefined ? undefined : ids.get(entity.parentId);
    const company = parent?.kind === "company" ? parent : undefined;
    const named: [FormRole, string][] = [
      ["name", entity.name],
      ...entity.aliases.map((alias): [FormRole, string] => ["alias", alias]),
    ];
    let tailText = entity.name;
    let heads: readonly string[] = [entity.name, ...entity.aliases];
    if (entity.kind === "deal") {
      const { companyForms, tail } = dealParts(entity, company);
      tailText = tail;
      for (const form of companyForms) named.push(["spoken", `${form} ${tail}`]);
      for (const form of companyForms) named.push(["company", form]);
      if (companyForms.length > 0) heads = companyForms;
    }
    const forms: LinkForm[] = [];
    for (const [role, text] of named) {
      const built = phraseOf(text);
      if (built.tokens.length === 0) continue;
      if (forms.some((form) => form.phrase.text === built.text)) continue;
      forms.push({ role, phrase: built, prefixes: prefixCodes(built.tokens) });
    }
    const tail = phraseOf(tailText);
    const headKeys = new Set<string>();
    for (const head of heads) {
      for (const key of phraseOf(head).tokens[0]?.keys ?? []) headKeys.add(key);
    }
    return { entity, position, forms, tail: tail.tokens, tailPairs: tail.pairs, headKeys };
  });

  // Siblings share a head sound; a tail word distinguishes a record unless every sibling has it.
  const byHead = new Map<string, number[]>();
  for (const draft of drafts) {
    for (const key of draft.headKeys) push(byHead, `${draft.entity.kind} ${key}`, draft.position);
  }
  const records: LinkRecord[] = drafts.map((draft) => {
    const siblings = new Set<number>();
    for (const key of draft.headKeys) {
      for (const other of byHead.get(`${draft.entity.kind} ${key}`) ?? []) {
        if (other !== draft.position) siblings.add(other);
      }
    }
    const others = [...siblings].map((position) => drafts[position]?.tail ?? []);
    let distinguishing = draft.tail.map(
      (word) =>
        others.length === 0 ||
        !others.every((tail) => tail.some((theirs) => sameSoundToken(word, theirs))),
    );
    if (!distinguishing.includes(true)) distinguishing = draft.tail.map(() => true);
    return {
      entity: draft.entity,
      position: draft.position,
      forms: draft.forms,
      abbreviations: abbreviationsOf(draft.entity),
      tail: draft.tail,
      tailPairs: draft.tailPairs,
      distinguishing,
    };
  });

  const byForm = new Map<string, LinkRecord[]>();
  const byKey = new Map<string, LinkRecord[]>();
  const byTrigram = new Map<string, FormRef[]>();
  const byAbbreviation = new Map<string, LinkRecord[]>();
  const children = new Map<string, LinkRecord[]>();
  for (const record of records) {
    for (const form of record.forms) {
      push(byForm, form.phrase.text, record);
      for (const word of [...form.phrase.tokens, ...form.phrase.pairs]) {
        for (const key of word.keys) push(byKey, key, record);
      }
      const ref = { record, form };
      for (const trigram of form.phrase.trigrams) push(byTrigram, trigram, ref);
    }
    for (const letters of record.abbreviations) push(byAbbreviation, letters, record);
    const parentId = record.entity.parentId;
    if (parentId !== undefined && record.entity.kind !== "company") {
      push(children, parentId, record);
    }
  }
  return {
    records,
    byId: new Map(records.map((record) => [record.entity.id, record])),
    byForm,
    byKey,
    byTrigram,
    byAbbreviation,
    children,
  };
}

export {
  CANDIDATE_SOURCES,
  type Candidate,
  type CandidateOptions,
  type CandidateSource,
  findCandidates,
  MAX_CANDIDATES,
  TRIGRAM_MIN,
} from "./candidates";
export {
  decide,
  finalDecision,
  type GridItem,
  type GridLimits,
  type GridResult,
  type GridWitness,
  isDecision,
  outcomesDiffer,
  type ReadingOutcome,
  type RuleDecision,
  searchThresholds,
  THRESHOLD_GRID,
  type ThresholdGrid,
  type Thresholds,
  witnessConflict,
} from "./decide";
export {
  type CandidateFeatures,
  FEATURE_NAMES,
  type FeatureName,
  type Features,
  featuresOf,
  TIE_WINDOW,
} from "./features";
export {
  type CandidateRow,
  canBeNew,
  candidateProbabilities,
  candidateRows,
  ENTITY_KINDS,
  isLinkUncertain,
  LINK_UNCERTAIN_BELOW,
  type LinkContext,
  type LinkResult,
  link,
  type MentionInput,
  probability,
  type RowContext,
} from "./link";
export { fitLogistic, type LogisticFit, sigmoid } from "./model";
export {
  LINKER_PARAMS_V1,
  type LinkerParams,
  type LinkerProvenance,
  parseLinkerParams,
} from "./params";
export {
  codeSimilarity,
  heard,
  type Phrase,
  type PreparedMention,
  phrase,
  prepareMention,
  type SoundToken,
  sameHead,
  sameSoundToken,
  soundToken,
} from "./tokens";
