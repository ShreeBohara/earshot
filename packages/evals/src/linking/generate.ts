// Generates the confusable-name set (spec WP3 step 3, §4.5): exactly the spec's class shares of
// 600 explicit mentions, each said in a carrier sentence, heard by both witnesses through the
// mishearing simulator, given a context, and labelled with its gold record and best decision.
//
// Each class has a recipe: what is said (a CRM name in a form that's unique by sound, or one its
// sound-alikes share, or a decoy), what context comes with it, and what the witnesses must do (B:
// a mishearing that survives the keyterm bias; E2: a snap). An attempt that the ground truth
// (oracle.ts) doesn't place in its class is thrown away and drawn again, so every item's label is
// one the oracle agrees with. Everything comes from seeded streams, one per class, so the output
// is the same on every run: scripts/gen-confusable.ts writes it, and a test regenerates it.
import type { EntityKind, EntityRef, ProposalType } from "@earshot/core";
import { foldName, normalizeName } from "@earshot/understanding/names";
import type { MishearOp } from "../channel/ops";
import { createRng, type Rng, subSeed } from "../channel/rng";
import {
  type Heard,
  hearBiased,
  hearUnbiased,
  keytermListV1,
  type NearSnap,
} from "../channel/witness";
import { DECOYS, type Decoy } from "./decoys";
import {
  companyOf,
  dealTail,
  entitiesOfKind,
  groupOf,
  LINKING_ENTITIES,
  LOOKALIKE_FREE_COMPANIES,
  linkingEntity,
  spokenForms,
} from "./entities";
import { type Observation, type Resolution, resolve, soundMatches } from "./oracle";
import {
  CALIBRATION_SHARE,
  CLASS_COUNTS,
  CLASS_EXPECT,
  type ConfusableItem,
  type Cue,
  ITEM_CLASSES,
  type ItemClass,
  type Reading,
  type Split,
} from "./schema";
import { fillTemplate, pickTemplate, type Template } from "./templates";

/** The set's seed: SHA-256's fifth initial hash word, as the demo CRM uses its first. */
export const SET_SEED = 0x510e527f;
/** Attempts per item before the generator gives up: a recipe that can't fill its class is a bug. */
const MAX_ATTEMPTS = 500;

// ---------------------------------------------------------------------------------------------
// What is said, and how each witness hears it

/** A mention as said. A deal's is its company's words and then its tail's ("Atmos onboarding"). */
interface Said {
  readonly kind: EntityKind;
  readonly text: string;
  readonly companyPart: string;
  readonly tailPart: string | null;
}

const plainSaid = (kind: EntityKind, text: string): Said => ({
  kind,
  text,
  companyPart: text,
  tailPart: null,
});

const dealSaid = (companyPart: string, tailPart: string | null): Said => ({
  kind: "deal",
  text: tailPart ? `${companyPart} ${tailPart}` : companyPart,
  companyPart,
  tailPart,
});

interface Plan {
  readonly mishear: "natural" | "never" | "always";
  readonly op?: MishearOp;
  readonly nearSnap: NearSnap;
  /** Deals: drop the tail's last word, as a stream that missed it would. */
  readonly dropTailWord?: boolean;
}

const NATURAL: Plan = { mishear: "natural", nearSnap: "natural" };

interface HeardMention extends Heard {
  /** A deal's company words as heard; the whole mention otherwise. */
  readonly companyText: string;
}

/**
 * One witness's hearing of a mention. A deal's company words go through the witness like any
 * company name (keyterms included); its tail is everyday words, which a stream gets right, so the
 * tail only ever loses its last word.
 */
function hear(
  said: Said,
  witness: "biased" | "unbiased",
  plan: Plan,
  keyterms: readonly string[],
  rng: Rng,
): HeardMention {
  const part = (text: string, kind: EntityKind) =>
    witness === "biased"
      ? hearBiased(text, kind, keyterms, rng, plan)
      : hearUnbiased(text, kind, rng, plan);
  if (said.kind !== "deal") {
    const heard = part(said.text, said.kind);
    return { ...heard, companyText: heard.text };
  }
  const company = part(said.companyPart, "company");
  const ops = [...company.ops];
  let tail = said.tailPart;
  if (plan.dropTailWord && tail !== null) {
    const words = tail.split(" ");
    words.pop();
    tail = words.length > 0 ? words.join(" ") : null;
    ops.push("dropTail");
  }
  return {
    text: tail === null ? company.text : `${company.text} ${tail}`,
    ops,
    companyText: company.text,
  };
}

const KEYTERMS = new Map<string | null, readonly string[]>();

/** The biased witness's keyterms for a session with this account open. */
function keytermsFor(focusEntityId: string | null): readonly string[] {
  let terms = KEYTERMS.get(focusEntityId);
  if (!terms) {
    terms = keytermListV1(LINKING_ENTITIES, focusEntityId);
    KEYTERMS.set(focusEntityId, terms);
  }
  return terms;
}

// ---------------------------------------------------------------------------------------------
// The forms a rep says, sorted by what the ground truth makes of them

const COMPANY_IDS: readonly string[] = entitiesOfKind("company").map((entity) => entity.id);

/** Every way to say a record: a company's name and aliases; a contact's name; a deal's forms. */
function saidForms(entity: EntityRef): Said[] {
  if (entity.kind === "company")
    return spokenForms(entity).map((form) => plainSaid("company", form));
  if (entity.kind === "contact") return [plainSaid("contact", entity.name)];
  const company = linkingEntity(entity.parentId ?? "");
  const tail = dealTail(entity).toLowerCase();
  const tailWords = tail.split(" ");
  const tails: (string | null)[] = [tail, null];
  if (tailWords.length > 1) tails.push(tailWords[0] ?? null);
  return [company.name, ...company.aliases].flatMap((form) =>
    tails.map((variant) => dealSaid(form, variant)),
  );
}

interface Form {
  readonly id: string;
  readonly said: Said;
  /** The records the form sounds like, among those of its kind. */
  readonly matches: readonly string[];
}

const ALL_FORMS: readonly Form[] = LINKING_ENTITIES.flatMap((entity) =>
  saidForms(entity).map((said) => ({
    id: entity.id,
    said,
    matches: soundMatches(said.text, entity.kind),
  })),
);

/** Forms that name only their own record: classes A and B. Deals keep at least a tail word. */
const UNIQUE_FORMS: readonly Form[] = ALL_FORMS.filter(
  (form) =>
    form.matches.length === 1 &&
    form.matches[0] === form.id &&
    (form.said.kind !== "deal" || form.said.tailPart !== null),
);

/** Forms that also name a sound-alike: classes C and D. */
const SHARED_FORMS: readonly Form[] = ALL_FORMS.filter(
  (form) => form.matches.length >= 2 && form.matches.includes(form.id),
);

/** Deal forms whose company words name two deals or more, while the tail names one: C by tail. */
const TAIL_FORMS: readonly Form[] = UNIQUE_FORMS.filter(
  (form) => form.said.kind === "deal" && soundMatches(form.said.companyPart, "deal").length >= 2,
);

/** Normalized spoken forms, per kind: a heard mention that equals one isn't a mishearing. */
const FORM_KEYS: ReadonlyMap<EntityKind, ReadonlySet<string>> = new Map(
  (["company", "contact", "deal"] as const).map((kind) => [
    kind,
    new Set(
      entitiesOfKind(kind).flatMap((entity) => spokenForms(entity).map((f) => normalizeName(f))),
    ),
  ]),
);

const ofKind = (forms: readonly Form[], kind: EntityKind) =>
  forms.filter((form) => form.said.kind === kind);

/** A queue over a pool: every item once, in a shuffled order, then again. */
function cycler<T>(items: readonly T[], rng: Rng): () => T {
  if (items.length === 0) throw new RangeError("cycler over an empty pool");
  let queue: T[] = [];
  return () => {
    if (queue.length === 0) queue = rng.shuffle(items);
    return queue.pop() as T;
  };
}

// ---------------------------------------------------------------------------------------------
// Context

const TYPE_WEIGHTS: Readonly<Record<EntityKind, Readonly<Record<string, number>>>> = {
  company: { note: 0.5, task: 0.3, commitment: 0.2 },
  contact: { contact: 0.4, note: 0.3, task: 0.2, commitment: 0.1 },
  deal: { deal_update: 0.55, note: 0.25, task: 0.1, commitment: 0.1 },
};

function pickType(rng: Rng, kind: EntityKind): ProposalType {
  return rng.weighted(TYPE_WEIGHTS[kind]) as ProposalType;
}

/** Records and their companies: what an unrelated context must stay clear of. */
function family(ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    out.add(id);
    const company = companyOf(id);
    if (company) out.add(company);
  }
  return out;
}

function unrelatedCompany(rng: Rng, avoid: ReadonlySet<string>): string {
  return rng.pick(COMPANY_IDS.filter((id) => !avoid.has(id)));
}

/** Null, or an account that has nothing to do with the mention. */
function neutralFocus(rng: Rng, avoid: ReadonlySet<string>, pNull = 0.6): string | null {
  return rng.chance(pNull) ? null : unrelatedCompany(rng, avoid);
}

/** None, one, or two earlier links that have nothing to do with the mention. */
function unrelatedRecent(rng: Rng, avoid: ReadonlySet<string>): string[] {
  const roll = rng.next();
  const count = roll < 0.5 ? 0 : roll < 0.8 ? 1 : 2;
  const pool = LINKING_ENTITIES.filter(
    (entity) => !avoid.has(entity.id) && !avoid.has(companyOf(entity.id) ?? ""),
  ).map((entity) => entity.id);
  const out: string[] = [];
  while (out.length < count) {
    const id = rng.pick(pool);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function companyForms(id: string): readonly string[] {
  return spokenForms(linkingEntity(id));
}

const UNRELATED_DECOY_COMPANIES = DECOYS.filter(
  (decoy) => decoy.kind === "company" && decoy.like === null,
);

// ---------------------------------------------------------------------------------------------
// Drafts

interface Draft {
  readonly itemClass: ItemClass;
  readonly type: ProposalType;
  readonly said: Said;
  readonly saidCompany: { readonly text: string; readonly gold: string } | null;
  readonly template: Template;
  readonly biased: HeardMention;
  readonly unbiased: HeardMention;
  readonly biasedCompany: Heard | null;
  readonly unbiasedCompany: Heard | null;
  readonly focusEntityId: string | null;
  readonly recent: readonly string[];
  readonly gold: string;
  readonly cue: Cue | null;
  readonly group: string | null;
}

interface Setup {
  readonly itemClass: ItemClass;
  readonly said: Said;
  readonly gold: string;
  readonly group: string | null;
  readonly focusEntityId: string | null;
  readonly recent: readonly string[];
  readonly saidCompany: { readonly text: string; readonly gold: string } | null;
  readonly cue: Cue | null;
  readonly biasedPlan: Plan;
  readonly unbiasedPlan?: Plan;
  readonly type?: ProposalType;
}

/** Hears a setup through both witnesses and picks its carrier sentence. */
function realize(setup: Setup, rng: Rng): Draft {
  const type = setup.type ?? pickType(rng, setup.said.kind);
  const keyterms = keytermsFor(setup.focusEntityId);
  const biased = hear(setup.said, "biased", setup.biasedPlan, keyterms, rng);
  const unbiased = hear(setup.said, "unbiased", setup.unbiasedPlan ?? NATURAL, keyterms, rng);
  const company = setup.saidCompany;
  const biasedCompany = company
    ? hearBiased(company.text, "company", keyterms, rng, NATURAL)
    : null;
  const unbiasedCompany = company ? hearUnbiased(company.text, "company", rng) : null;
  const template = pickTemplate(rng, type, setup.said.kind, company !== null, setup.gold === "NEW");
  return {
    itemClass: setup.itemClass,
    type,
    said: setup.said,
    saidCompany: company,
    template,
    biased,
    unbiased,
    biasedCompany,
    unbiasedCompany,
    focusEntityId: setup.focusEntityId,
    recent: setup.recent,
    gold: setup.gold,
    cue: setup.cue,
    group: setup.group,
  };
}

function observe(draft: Draft, witness: "biased" | "unbiased"): Observation {
  return {
    type: draft.type,
    kind: draft.said.kind,
    mention: draft[witness].text,
    company: (witness === "biased" ? draft.biasedCompany : draft.unbiasedCompany)?.text ?? null,
    focusEntityId: draft.focusEntityId,
    recent: draft.recent,
  };
}

const linksTo = (resolution: Resolution, id: string) =>
  resolution.decision === "link" && resolution.entityId === id;

/** Whether exactly these cues, and no others, narrowed the matches. */
const sameCues = (resolution: Resolution, cues: readonly string[]) =>
  resolution.cues.length === cues.length && resolution.cues.every((cue) => cues.includes(cue));

/** Whether a mention was heard exactly as said (same words, once folded). */
const heardAsSaid = (draft: Draft) => foldName(draft.biased.text) === foldName(draft.said.text);

/** Whether a heard mention is some record's spoken form: a snap onto a name, not a mishearing. */
const isSomeForm = (text: string, kind: EntityKind) =>
  FORM_KEYS.get(kind)?.has(normalizeName(text)) ?? false;

// ---------------------------------------------------------------------------------------------
// The classes

type Attempt = (index: number) => Draft | null;

function companyContext(rng: Rng, contactId: string, chance: number) {
  const parent = companyOf(contactId);
  if (!parent || !rng.chance(chance)) return null;
  return { text: rng.pick(companyForms(parent)), gold: parent };
}

/** A: a CRM name heard exactly, unique by sound; the 18 companies with no look-alike first. */
function classA(rng: Rng): Attempt {
  const pools = {
    company: cycler(ofKind(UNIQUE_FORMS, "company"), rng),
    contact: cycler(ofKind(UNIQUE_FORMS, "contact"), rng),
    deal: cycler(ofKind(UNIQUE_FORMS, "deal"), rng),
  };
  return (index) => {
    let form: Form;
    if (index < LOOKALIKE_FREE_COMPANIES.length) {
      const id = LOOKALIKE_FREE_COMPANIES[index] as string;
      const own = UNIQUE_FORMS.filter((candidate) => candidate.id === id);
      form = rng.chance(0.7) ? (own[0] as Form) : rng.pick(own);
    } else {
      form = pools[rng.weighted({ company: 0.45, contact: 0.4, deal: 0.15 })]();
    }
    const gold = form.id;
    const avoid = family([gold]);
    const roll = rng.next();
    const focus = roll < 0.5 ? null : roll < 0.85 ? unrelatedCompany(rng, avoid) : companyOf(gold);
    const recent = rng.chance(0.1) ? [gold] : unrelatedRecent(rng, avoid);
    const draft = realize(
      {
        itemClass: "A",
        said: form.said,
        gold,
        group: groupOf(gold),
        focusEntityId: focus ?? null,
        recent,
        saidCompany: form.said.kind === "contact" ? companyContext(rng, gold, 0.5) : null,
        cue: null,
        biasedPlan: { mishear: "never", nearSnap: "never" },
      },
      rng,
    );
    const resolution = resolve(observe(draft, "biased"));
    const ok = heardAsSaid(draft) && linksTo(resolution, gold) && resolution.matches.length === 1;
    return ok ? draft : null;
  };
}

/** B: a CRM name misheard, still unique by sound (or by its tail). */
function classB(rng: Rng): Attempt {
  const pools = {
    company: cycler(ofKind(UNIQUE_FORMS, "company"), rng),
    contact: cycler(ofKind(UNIQUE_FORMS, "contact"), rng),
    deal: cycler(ofKind(UNIQUE_FORMS, "deal"), rng),
  };
  return () => {
    const form = pools[rng.weighted({ company: 0.3, contact: 0.55, deal: 0.15 })]();
    const gold = form.id;
    const avoid = family([gold]);
    const dropTailWord = form.said.kind === "deal" && rng.chance(0.5);
    const draft = realize(
      {
        itemClass: "B",
        said: form.said,
        gold,
        group: groupOf(gold),
        focusEntityId: neutralFocus(rng, avoid, 0.55),
        recent: unrelatedRecent(rng, avoid),
        saidCompany: form.said.kind === "contact" ? companyContext(rng, gold, 0.5) : null,
        cue: null,
        biasedPlan: dropTailWord
          ? { mishear: "never", nearSnap: "never", dropTailWord }
          : { mishear: "always", nearSnap: "never" },
      },
      rng,
    );
    const resolution = resolve(observe(draft, "biased"));
    const ok =
      !heardAsSaid(draft) &&
      !isSomeForm(draft.biased.text, form.said.kind) &&
      linksTo(resolution, gold) &&
      resolution.matches.length === 1;
    return ok ? draft : null;
  };
}

/** C: a sound-alike its context separates: the company said, the open account, an earlier link, a deal's tail. */
function classC(rng: Rng): Attempt {
  const shared = {
    company: cycler(ofKind(SHARED_FORMS, "company"), rng),
    contact: cycler(ofKind(SHARED_FORMS, "contact"), rng),
    deal: cycler(ofKind(SHARED_FORMS, "deal"), rng),
  };
  const withCompany = cycler(ofKind(SHARED_FORMS, "contact"), rng);
  const tails = cycler(TAIL_FORMS, rng);
  return () => {
    const cue = rng.weighted({ company: 0.3, focus: 0.25, recent: 0.2, tail: 0.25 }) as Cue;
    let form: Form;
    if (cue === "company") form = withCompany();
    else if (cue === "tail") form = tails();
    else if (cue === "focus")
      form = shared[rng.weighted({ company: 0.45, contact: 0.35, deal: 0.2 })]();
    else form = shared[rng.weighted({ company: 0.45, contact: 0.45, deal: 0.1 })]();
    const gold = form.id;
    const avoid = family([gold, ...form.matches]);
    const focus = cue === "focus" ? (companyOf(gold) ?? null) : neutralFocus(rng, avoid);
    const recent =
      cue === "recent"
        ? rng.shuffle([gold, ...(rng.chance(0.4) ? unrelatedRecent(rng, avoid).slice(0, 1) : [])])
        : unrelatedRecent(rng, avoid);
    const draft = realize(
      {
        itemClass: "C",
        said: form.said,
        gold,
        group: groupOf(gold),
        focusEntityId: focus,
        recent,
        saidCompany: cue === "company" ? companyContext(rng, gold, 1) : null,
        cue,
        biasedPlan: NATURAL,
      },
      rng,
    );
    const resolution = resolve(observe(draft, "biased"));
    if (!linksTo(resolution, gold)) return null;
    if (cue === "tail") {
      const companyWords = soundMatches(draft.biased.companyText, "deal");
      return resolution.matches.length === 1 && companyWords.length >= 2 ? draft : null;
    }
    return resolution.matches.length >= 2 && sameCues(resolution, [cue]) ? draft : null;
  };
}

/** D: a sound-alike with nothing to separate it. */
function classD(rng: Rng): Attempt {
  const shared = {
    company: cycler(ofKind(SHARED_FORMS, "company"), rng),
    contact: cycler(ofKind(SHARED_FORMS, "contact"), rng),
    deal: cycler(ofKind(SHARED_FORMS, "deal"), rng),
  };
  return () => {
    const form = shared[rng.weighted({ company: 0.45, contact: 0.4, deal: 0.15 })]();
    const gold = form.id;
    const avoid = family([gold, ...form.matches]);
    const draft = realize(
      {
        itemClass: "D",
        said: form.said,
        gold,
        group: groupOf(gold),
        focusEntityId: neutralFocus(rng, avoid),
        recent: unrelatedRecent(rng, avoid),
        saidCompany: form.said.kind === "contact" ? companyContext(rng, gold, 0.35) : null,
        cue: null,
        biasedPlan: NATURAL,
      },
      rng,
    );
    const resolution = resolve(observe(draft, "biased"));
    const ok =
      resolution.decision === "ask" &&
      resolution.matches.length >= 2 &&
      resolution.matches.includes(gold);
    return ok ? draft : null;
  };
}

/** A contact decoy's company said in the same breath: the sound-alike's, another, or a new one. */
function decoyCompany(rng: Rng, decoy: Decoy, chance: number) {
  if (decoy.kind !== "contact" || !rng.chance(chance)) return null;
  const roll = rng.next();
  const like = decoy.like ? companyOf(decoy.like) : undefined;
  if (like && roll < 0.6) return { text: rng.pick(companyForms(like)), gold: like };
  if (roll < 0.85) {
    const other = unrelatedCompany(rng, family(decoy.like ? [decoy.like] : []));
    return { text: rng.pick(companyForms(other)), gold: other };
  }
  return { text: rng.pick(UNRELATED_DECOY_COMPANIES).text, gold: "NEW" };
}

const ALIKE_DECOYS = DECOYS.filter((decoy) => decoy.like !== null);
const UNRELATED_DECOYS = DECOYS.filter((decoy) => decoy.like === null);

/** E1: a new name that sounds like a CRM name, heard as itself. */
function classE1(rng: Rng): Attempt {
  const decoys = cycler(ALIKE_DECOYS, rng);
  return () => {
    const decoy = decoys();
    const like = decoy.like as string;
    const avoid = family([like]);
    const roll = rng.next();
    const focus = roll < 0.6 ? null : roll < 0.9 ? unrelatedCompany(rng, avoid) : companyOf(like);
    const draft = realize(
      {
        itemClass: "E1",
        said: plainSaid(decoy.kind, decoy.text),
        gold: "NEW",
        group: groupOf(like),
        focusEntityId: focus ?? null,
        recent: unrelatedRecent(rng, avoid),
        saidCompany: decoyCompany(rng, decoy, 0.6),
        cue: null,
        biasedPlan: { mishear: "natural", nearSnap: "never" },
      },
      rng,
    );
    return resolve(observe(draft, "biased")).decision === "new" ? draft : null;
  };
}

/** E2: the same, but the biased witness snapped it to a CRM spelling; only the second witness hears it. */
function classE2(rng: Rng): Attempt {
  const decoys = cycler(ALIKE_DECOYS, rng);
  return () => {
    const decoy = decoys();
    const like = decoy.like as string;
    const avoid = family([like]);
    // A contact is a keyterm only when its account is open.
    const focus =
      decoy.kind === "contact" ? (companyOf(like) ?? null) : neutralFocus(rng, avoid, 0.7);
    const saidCompany =
      decoy.kind === "contact" && focus !== null && rng.chance(0.4)
        ? { text: rng.pick(companyForms(focus)), gold: focus }
        : null;
    const draft = realize(
      {
        itemClass: "E2",
        said: plainSaid(decoy.kind, decoy.text),
        gold: "NEW",
        group: groupOf(like),
        focusEntityId: focus,
        recent: unrelatedRecent(rng, avoid),
        saidCompany,
        cue: null,
        biasedPlan: { mishear: "never", nearSnap: "force" },
      },
      rng,
    );
    const ok =
      draft.biased.ops.includes("snap") &&
      resolve(observe(draft, "biased")).decision === "link" &&
      resolve(observe(draft, "unbiased")).decision === "new";
    return ok ? draft : null;
  };
}

/** F: a new name unlike any CRM name. */
function classF(rng: Rng): Attempt {
  const decoys = cycler(UNRELATED_DECOYS, rng);
  return () => {
    const decoy = decoys();
    const draft = realize(
      {
        itemClass: "F",
        said: plainSaid(decoy.kind, decoy.text),
        gold: "NEW",
        group: null,
        focusEntityId: neutralFocus(rng, new Set()),
        recent: unrelatedRecent(rng, new Set()),
        saidCompany: decoyCompany(rng, decoy, 0.5),
        cue: null,
        biasedPlan: NATURAL,
      },
      rng,
    );
    return resolve(observe(draft, "biased")).decision === "new" ? draft : null;
  };
}

/** Companies whose name, missing its last word, also names a sibling: G's raw material. */
const G_PAIRS: readonly { gold: string; name: string; sibling: string }[] = entitiesOfKind(
  "company",
).flatMap((entity) => {
  const words = entity.name.split(" ");
  if (words.length < 2 || soundMatches(entity.name, "company").length !== 1) return [];
  const short = soundMatches(words.slice(0, -1).join(" "), "company");
  return short
    .filter((id) => id !== entity.id && short.includes(entity.id))
    .map((sibling) => ({ gold: entity.id, name: entity.name, sibling }));
});

/** G: the open account is the wrong sibling; only the unbiased witness heard the distinguishing word. */
function classG(rng: Rng): Attempt {
  const pairs = cycler(G_PAIRS, rng);
  return () => {
    const pair = pairs();
    const avoid = family([pair.gold, pair.sibling]);
    const draft = realize(
      {
        itemClass: "G",
        said: plainSaid("company", pair.name),
        gold: pair.gold,
        group: groupOf(pair.gold),
        focusEntityId: pair.sibling,
        recent: unrelatedRecent(rng, avoid),
        saidCompany: null,
        cue: null,
        biasedPlan: { mishear: "always", op: "dropTail", nearSnap: "never" },
      },
      rng,
    );
    const biased = resolve(observe(draft, "biased"));
    const unbiased = resolve(observe(draft, "unbiased"));
    const ok =
      linksTo(biased, pair.sibling) && sameCues(biased, ["focus"]) && linksTo(unbiased, pair.gold);
    return ok ? draft : null;
  };
}

const RECIPES: Readonly<Record<ItemClass, (rng: Rng) => Attempt>> = {
  A: classA,
  B: classB,
  C: classC,
  D: classD,
  E1: classE1,
  E2: classE2,
  F: classF,
  G: classG,
};

function draftClass(itemClass: ItemClass): Draft[] {
  const rng = createRng(subSeed(SET_SEED, `class:${itemClass}`));
  const attempt = RECIPES[itemClass](rng);
  const drafts: Draft[] = [];
  while (drafts.length < CLASS_COUNTS[itemClass]) {
    let draft: Draft | null = null;
    for (let tries = 0; tries < MAX_ATTEMPTS && draft === null; tries++) {
      draft = attempt(drafts.length);
    }
    if (draft === null) {
      throw new Error(`class ${itemClass}: no item after ${MAX_ATTEMPTS} attempts`);
    }
    drafts.push(draft);
  }
  return drafts;
}

// ---------------------------------------------------------------------------------------------
// The split, and the items

/**
 * Marks 40% of each class as calibration, spread evenly over its confusable groups: the class's
 * items in group order (shuffled within each group), every 2.5th one calibration.
 */
function assignSplits(drafts: readonly Draft[]): Split[] {
  const rng = createRng(subSeed(SET_SEED, "split"));
  const splits = new Array<Split>(drafts.length).fill("test");
  for (const itemClass of ITEM_CLASSES) {
    const indices = drafts.flatMap((draft, index) =>
      draft.itemClass === itemClass ? [index] : [],
    );
    const byGroup = new Map<string, number[]>();
    for (const index of indices) {
      const key = drafts[index]?.group ?? "~";
      byGroup.set(key, [...(byGroup.get(key) ?? []), index]);
    }
    const ordered = [...byGroup.keys()]
      .sort()
      .flatMap((key) => rng.shuffle(byGroup.get(key) ?? []));
    const want = Math.round(CALIBRATION_SHARE * ordered.length);
    ordered.forEach((index, position) => {
      const before = Math.floor((position * want) / ordered.length);
      const after = Math.floor(((position + 1) * want) / ordered.length);
      if (after > before) splits[index] = "calibration";
    });
  }
  return splits;
}

function reading(draft: Draft, witness: "biased" | "unbiased"): Reading {
  const mention = draft[witness];
  const company = witness === "biased" ? draft.biasedCompany : draft.unbiasedCompany;
  const filled = fillTemplate(draft.template, mention.text, company?.text ?? null);
  return {
    transcript: filled.transcript,
    mention: filled.mention,
    company: filled.company,
    noise: [...mention.ops, ...(company?.ops ?? []).map((op) => `company:${op}`)],
  };
}

function toItem(draft: Draft, index: number, split: Split): ConfusableItem {
  return {
    id: `cf-${String(index + 1).padStart(4, "0")}`,
    split,
    class: draft.itemClass,
    type: draft.type,
    said: { text: draft.said.text, kind: draft.said.kind },
    biased: reading(draft, "biased"),
    unbiased: reading(draft, "unbiased"),
    context: {
      focusEntityId: draft.focusEntityId,
      company: draft.saidCompany
        ? { said: draft.saidCompany.text, gold: draft.saidCompany.gold }
        : null,
      recent: [...draft.recent],
    },
    gold: draft.gold,
    expect: CLASS_EXPECT[draft.itemClass],
    group: draft.group,
    cue: draft.cue,
  };
}

/** The confusable-name set, v1: the same 600 items on every run. */
export function generateConfusableSet(): ConfusableItem[] {
  const drafts = ITEM_CLASSES.flatMap(draftClass);
  const splits = assignSplits(drafts);
  return drafts.map((draft, index) => toItem(draft, index, splits[index] ?? "test"));
}

/** The record pools the recipes draw from, for tests and the ADR's numbers. */
export const POOLS = {
  unique: UNIQUE_FORMS.length,
  shared: SHARED_FORMS.length,
  tail: TAIL_FORMS.length,
  gPairs: G_PAIRS.length,
} as const;

export type { Draft as ConfusableDraft };
