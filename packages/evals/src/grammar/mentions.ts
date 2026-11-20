// How a generated debrief names a record, and how each witness hears it (Phase 4 WP10 step 2).
//
// The words go through WP3's mishearing simulator (`@earshot/evals/channel`) under the frozen
// keyterm policy `keytermListV1`, exactly as the confusable-name set's do: the biased witness may
// mishear a name the same-sound way and snaps onto in-list spellings; the unbiased witness never
// snaps and sometimes changes a sound. The label is the confusable set's ground truth
// (`resolve`, src/linking/oracle.ts) on what the biased witness heard, with the context the
// session had at that point: the open account, the company said in the same breath, and the
// records linked earlier in the debrief. A draw the label doesn't fit is thrown away and drawn
// again, so every label is one the oracle agrees with: true by construction.
//
// - A CRM record: linked when the oracle links it; "ask" when it can't tell its sound-alikes
//   apart and the record is among them (drawn only some of the time, so asks stay rare).
// - A new name (a decoy): "new" when the biased witness heard it as new; or, when the biased
//   witness snapped it onto a CRM spelling (only from a forced snap), "ask" through the second
//   witness, with `witness_conflict` expected: the unbiased witness must have heard it as new.
import type { EntityKind, ProposalTypeV2, RiskKindV2, TargetDecision } from "@earshot/core";
import type { Rng } from "../channel/rng";
import {
  type Heard,
  hearBiased,
  hearUnbiased,
  keytermListV1,
  type NearSnap,
} from "../channel/witness";
import type { Decoy } from "../linking/decoys";
import { companyOf, dealTail, LINKING_ENTITIES, linkingEntity } from "../linking/entities";
import { resolve } from "../linking/oracle";

/** How the generator wants a name heard. */
export type MentionMode =
  /** A CRM name the biased witness doesn't mishear (it may still snap to a same-sound spelling). */
  | "exact"
  /** A CRM name heard as the channel's rates have it. */
  | "natural"
  /** A CRM name the biased witness mishears the same-sound way, never snapped a word away. */
  | "misheard"
  /** A new name, heard as the channel's rates have it but never snapped a word away. */
  | "decoy"
  /** A new name the biased witness snaps onto a CRM spelling a word away. */
  | "snap";

interface HearPlan {
  readonly mishear: "natural" | "never" | "always";
  readonly nearSnap: NearSnap;
}

const BIASED_PLANS: Readonly<Record<MentionMode, HearPlan>> = {
  exact: { mishear: "never", nearSnap: "never" },
  natural: { mishear: "natural", nearSnap: "natural" },
  misheard: { mishear: "always", nearSnap: "never" },
  decoy: { mishear: "natural", nearSnap: "never" },
  snap: { mishear: "never", nearSnap: "force" },
};

/** The same words in each version: as said, as the biased stream wrote them, as the second witness did. */
export interface Words {
  readonly said: string;
  readonly biased: string;
  readonly unbiased: string;
}

export interface PlannedMention {
  /** The words that name the target. */
  readonly words: Words;
  /** For a deal, its company's words inside them: what the tool draft quotes as `company`. */
  readonly companyPart: Words | null;
  /** The company said in the same breath as a contact, heard by both witnesses. */
  readonly company: Words | null;
  readonly kind: EntityKind;
  readonly expected: { readonly id: string | null; readonly decision: TargetDecision };
  readonly flags: readonly RiskKindV2[];
  /** The company said with it, as the session would link it on its own (for earlier links). */
  readonly linkedCompany: string | null;
  /** What the simulator did, for debugging. */
  readonly ops: readonly string[];
}

export interface MentionRequest {
  readonly type: ProposalTypeV2;
  /** A demo CRM id, or a decoy for a new record. */
  readonly target: string | Decoy;
  readonly mode: MentionMode;
  /** Whether a contact's company is said with it ("Dana Lee from Acme Dynamics"). */
  readonly withCompany: boolean;
  readonly focusEntityId: string | null;
  readonly recent: readonly string[];
  /** Whether an "ask" is acceptable for a CRM record this time. */
  readonly allowAsk: boolean;
}

const KEYTERMS = new Map<string | null, readonly string[]>();

/** The biased witness's keyterms for a session with this account open (the frozen v1 policy). */
export function keytermsFor(focusEntityId: string | null): readonly string[] {
  let terms = KEYTERMS.get(focusEntityId);
  if (!terms) {
    terms = keytermListV1(LINKING_ENTITIES, focusEntityId);
    KEYTERMS.set(focusEntityId, terms);
  }
  return terms;
}

/** The oracle's proposal type: a meeting can hang off the same kinds a note can. */
function oracleType(type: ProposalTypeV2) {
  return type === "meeting" ? "note" : type;
}

/** A form a rep says a record by: a company's name or alias; a contact's name; a deal's. */
interface Said {
  readonly text: string;
  readonly kind: EntityKind;
  /** A deal's company words. */
  readonly companyPart: string | null;
  readonly tail: string | null;
}

function saidForm(target: string | Decoy, rng: Rng): Said {
  if (typeof target !== "string") {
    return { text: target.text, kind: target.kind, companyPart: null, tail: null };
  }
  const entity = linkingEntity(target);
  if (entity.kind === "company") {
    const forms = [entity.name, ...entity.aliases];
    const text = rng.chance(0.7) || forms.length === 1 ? entity.name : rng.pick(forms.slice(1));
    return { text, kind: "company", companyPart: null, tail: null };
  }
  if (entity.kind === "contact") {
    return { text: entity.name, kind: "contact", companyPart: null, tail: null };
  }
  const company = linkingEntity(entity.parentId ?? "");
  const companyText =
    rng.chance(0.75) || company.aliases.length === 0 ? company.name : rng.pick(company.aliases);
  const tailWords = dealTail(entity).toLowerCase().split(" ");
  const roll = rng.next();
  const tail =
    roll < 0.6
      ? tailWords.join(" ")
      : roll < 0.8 || tailWords.length === 1
        ? null
        : (tailWords[0] ?? null);
  return {
    text: tail === null ? companyText : `${companyText} ${tail}`,
    kind: "deal",
    companyPart: companyText,
    tail,
  };
}

/** One witness's hearing of the words: a deal's company words go through it; its tail is kept. */
function hear(
  said: Said,
  witness: "biased" | "unbiased",
  plan: HearPlan,
  keyterms: readonly string[],
  rng: Rng,
) {
  const part = (text: string, kind: EntityKind): Heard =>
    witness === "biased"
      ? hearBiased(text, kind, keyterms, rng, plan)
      : hearUnbiased(text, kind, rng, plan);
  if (said.kind !== "deal" || said.companyPart === null) {
    const heard = part(said.text, said.kind);
    return { text: heard.text, ops: heard.ops, companyPart: null as string | null };
  }
  const company = part(said.companyPart, "company");
  return {
    text: said.tail === null ? company.text : `${company.text} ${said.tail}`,
    ops: company.ops,
    companyPart: company.text,
  };
}

const NATURAL: HearPlan = { mishear: "natural", nearSnap: "natural" };

/** The company a contact belongs to, said as a rep would: its name, sometimes an alias. */
function companyWords(companyId: string, rng: Rng): string {
  const company = linkingEntity(companyId);
  const forms = [company.name, ...company.aliases];
  return rng.chance(0.75) || forms.length === 1 ? company.name : rng.pick(forms.slice(1));
}

/**
 * One draw of a mention: what's said, how both witnesses hear it, and its label; null when the
 * oracle's reading doesn't fit what the request asked for.
 */
function drawMention(
  request: MentionRequest,
  rng: Rng,
  companyFor: string | null,
): PlannedMention | null {
  const said = saidForm(request.target, rng);
  const keyterms = keytermsFor(request.focusEntityId);
  const biased = hear(said, "biased", BIASED_PLANS[request.mode], keyterms, rng);
  const unbiased = hear(said, "unbiased", NATURAL, keyterms, rng);
  let company: Words | null = null;
  if (companyFor !== null && said.kind === "contact") {
    const text = companyWords(companyFor, rng);
    company = {
      said: text,
      biased: hearBiased(text, "company", keyterms, rng, NATURAL).text,
      unbiased: hearUnbiased(text, "company", rng).text,
    };
  }
  const observe = (mention: string, companyText: string | null, kind: EntityKind = said.kind) =>
    resolve({
      type: kind === said.kind ? oracleType(request.type) : "note",
      kind,
      mention,
      company: companyText,
      focusEntityId: request.focusEntityId,
      recent: request.recent,
    });
  const biasedReading = observe(biased.text, company?.biased ?? null);
  let expected: PlannedMention["expected"];
  let flags: RiskKindV2[];
  if (typeof request.target === "string") {
    const gold = request.target;
    if (biasedReading.decision === "link" && biasedReading.entityId === gold) {
      expected = { id: gold, decision: "linked" };
      flags = [];
    } else if (
      request.allowAsk &&
      biasedReading.decision === "ask" &&
      biasedReading.matches.includes(gold)
    ) {
      expected = { id: gold, decision: "ask" };
      flags = ["ambiguous_target"];
    } else {
      return null;
    }
  } else if (request.mode === "snap") {
    const unbiasedReading = observe(unbiased.text, company?.unbiased ?? null);
    const snapped =
      biased.ops.includes("snap") &&
      biasedReading.decision === "link" &&
      unbiasedReading.decision === "new";
    if (!snapped) return null;
    expected = { id: null, decision: "ask" };
    flags = ["witness_conflict"];
  } else {
    if (biasedReading.decision !== "new") return null;
    expected = { id: null, decision: "new" };
    flags = ["new_entity"];
  }
  // The company said beside a contact, or inside a deal's words: the session links it on its own
  // (`linkCompany` in @earshot/agent) and adds it to the earlier links.
  const companyText = company?.biased ?? (said.kind === "deal" ? biased.companyPart : null);
  const linkedCompany =
    companyText === null
      ? null
      : (() => {
          const reading = observe(companyText, null, "company");
          return reading.decision === "link" ? reading.entityId : null;
        })();
  return {
    words: { said: said.text, biased: biased.text, unbiased: unbiased.text },
    companyPart:
      said.companyPart === null
        ? null
        : {
            said: said.companyPart,
            biased: biased.companyPart ?? said.companyPart,
            unbiased: unbiased.companyPart ?? said.companyPart,
          },
    company,
    kind: said.kind,
    expected,
    flags,
    linkedCompany: linkedCompany ?? null,
    ops: [...biased.ops, ...unbiased.ops.map((op) => `unbiased:${op}`)],
  };
}

/** Attempts per mention before the caller falls back to another record. */
const MAX_ATTEMPTS = 60;

/**
 * Plans a mention of a record (or a new name), drawing until the oracle's label fits; null when
 * none does within `MAX_ATTEMPTS` (a request that can't be met, such as a snap with no keyterm a
 * word away).
 */
export function planMention(request: MentionRequest, rng: Rng): PlannedMention | null {
  const target = request.target;
  const companyFor =
    request.withCompany && typeof target === "string" && linkingEntity(target).kind === "contact"
      ? (companyOf(target) ?? null)
      : null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const drawn = drawMention(request, rng, companyFor);
    if (drawn) return drawn;
  }
  return null;
}

/**
 * The words of a new contact's company, said in the same breath: the account the debrief is
 * about, heard by both witnesses.
 */
export function companyMention(companyId: string, focusEntityId: string | null, rng: Rng): Words {
  const keyterms = keytermsFor(focusEntityId);
  const text = companyWords(companyId, rng);
  return {
    said: text,
    biased: hearBiased(text, "company", keyterms, rng, NATURAL).text,
    unbiased: hearUnbiased(text, "company", rng).text,
  };
}

/**
 * The company said beside a contact or inside a deal's words, as the session links it on its own
 * (`linkCompany` in @earshot/agent, which adds it to the earlier links): the oracle's reading of
 * the words as a company, with the open account and the earlier links as context.
 */
export function linkedCompanyOf(
  text: string,
  focusEntityId: string | null,
  recent: readonly string[],
): string | null {
  const reading = resolve({
    type: "note",
    kind: "company",
    mention: text,
    company: null,
    focusEntityId,
    recent,
  });
  return reading.decision === "link" ? reading.entityId : null;
}

/** The same words in every version: a record named where no witness hears it differently. */
export function plainWords(text: string): Words {
  return { said: text, biased: text, unbiased: text };
}

/**
 * The session's earlier links after a proposal, as `withRecentLinks` in @earshot/agent builds
 * them: the company linked beside it, then its target when linked from words that were said,
 * most recent first, at most 20.
 */
export function nextRecent(
  recent: readonly string[],
  linkedCompany: string | null,
  target: { readonly id: string | null; readonly decision: TargetDecision } | null,
): string[] {
  const out = [...recent];
  for (const id of [linkedCompany, target?.decision === "linked" ? target.id : null]) {
    if (id === null) continue;
    const at = out.indexOf(id);
    if (at >= 0) out.splice(at, 1);
    out.unshift(id);
  }
  return out.slice(0, 20);
}
