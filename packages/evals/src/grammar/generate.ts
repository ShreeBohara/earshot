// The debrief generator (Phase 4 WP10 step 2; ADR-0031): d031–d200, seeded, in format v2. The 30
// hand-written scripts stay as they are. scripts/gen-debriefs.ts writes the files, and a test
// regenerates them and fails on any byte of difference.
//
// Each script is a debrief about one account, the one open in Earshot four times in five: three to
// five push-to-talk turns, each proposing up to two things, or nothing. A turn is a template
// (templates.ts) with its slots filled from the demo CRM and the phrase builders (phrases.ts):
// - names go through WP3's mishearing simulator under the frozen keyterm policy, and each target
//   is labelled by the confusable set's oracle (mentions.ts);
// - some turns take back a date or an amount ("by Thursday, sorry, Friday"), some carry a
//   negation, a third or so are disfluent (disfluency.ts);
// - one script in five or so names a new company or person that the biased stream snapped onto a
//   CRM spelling: only the second witness hears it right, so it expects a `witness_conflict`.
//
// Everything comes from seeded streams: one for the plan (accounts, voices, call times), and one
// per script, so editing how one script is written doesn't move another's draws.
import type { EntityKind, ProposalTypeV2, RiskKindV2, TargetDecision } from "@earshot/core";
import { companies, contacts, deals } from "@earshot/demo-crm";
import { createRng, type Rng, subSeed } from "../channel/rng";
import { inConfusableGroup } from "../coverage";
import { DEBRIEFS } from "../debriefs";
import { DECOYS, type Decoy } from "../linking/decoys";
import { groupMembers, linkingEntity } from "../linking/entities";
import {
  DEBRIEF_FORMAT_VERSION,
  type DebriefScriptFile,
  type ExpectedProposal,
  KOKORO_VOICES,
  type KokoroVoice,
  type Noise,
  type TurnTag,
} from "../schema";
import { localDate, parseUsd, resolveDatePhrase, resolveTimePhrase } from "../verify";
import { addDisfluency, DISFLUENCY_KINDS, type DisfluencyKind } from "./disfluency";
import {
  DOCS,
  EARLY_STAGES,
  FACTS,
  NEGATED_FACTS,
  NEGATED_PROMISES,
  NEW_PEOPLE,
  NOISE_SNRS,
  NOISE_WEIGHTS,
  ROLES,
  STAGES,
  TIME_ZONES,
  TOPICS,
} from "./lexicon";
import {
  companyMention,
  linkedCompanyOf,
  type MentionMode,
  nextRecent,
  type PlannedMention,
  plainWords,
  planMention,
  type Words,
} from "./mentions";
import {
  amountCorrection,
  amountPhrase,
  type CallContext,
  closePhrase,
  dateCorrection,
  dayPhrase,
  duePhrase,
  emailFor,
  phoneFor,
  timePhrase,
  type ValuePhrase,
} from "./phrases";
import {
  fillTemplate,
  isTidy,
  joinSentences,
  lit,
  parseTemplate,
  render,
  type Seg,
} from "./segments";
import {
  NEGATED_QUIET_TEMPLATES,
  QUIET_TEMPLATES,
  type QuietTemplate,
  TEMPLATES,
  type Template,
} from "./templates";

/** The generator's seed: SHA-256's sixth initial hash word (the confusable set uses the fifth). */
export const DEBRIEF_SEED = 0x9b05688c;
export const GENERATED_FIRST = 31;
export const GENERATED_LAST = 200;
/** Bump when the generator's output changes on purpose; the reproduction test names it. */
export const GENERATOR_VERSION = "debriefs.v1";

export const GENERATED_IDS: readonly string[] = Array.from(
  { length: GENERATED_LAST - GENERATED_FIRST + 1 },
  (_, i) => `d${String(GENERATED_FIRST + i).padStart(3, "0")}`,
);

/** A turn is retried this many times (fresh draws) before the generator gives up: a bug. */
const MAX_TURN_ATTEMPTS = 40;

const DECOY_PEOPLE: readonly Decoy[] = NEW_PEOPLE.map((text) => ({
  text,
  kind: "contact",
  like: null,
}));
const NEW_CONTACT_NAMES: readonly Decoy[] = [
  ...DECOYS.filter((decoy) => decoy.kind === "contact"),
  ...DECOY_PEOPLE,
];
const NEW_COMPANY_NAMES: readonly Decoy[] = DECOYS.filter((decoy) => decoy.kind === "company");

// ---------------------------------------------------------------------------------------------
// The plan: one row per script

interface ScriptPlan {
  readonly id: string;
  readonly company: string;
  readonly focusEntityId: string | null;
  readonly voice: KokoroVoice;
  readonly speed: number | null;
  readonly noise: Noise | null;
  readonly timeZone: string;
  readonly callTime: string;
  readonly turns: number;
  /** One turn names a new record the biased stream snapped onto a CRM spelling. */
  readonly snap: boolean;
  /** One turn takes back a date or an amount. */
  readonly correction: boolean;
}

/** Minutes the zone is ahead of UTC at an instant. */
function zoneOffsetMinutes(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? "0");
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  return Math.round((wall - instant) / 60_000);
}

/** The instant a wall-clock time is in a zone. */
function zonedInstant(isoDate: string, hour: number, minute: number, timeZone: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  const wall = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour, minute);
  let instant = wall - zoneOffsetMinutes(wall, timeZone) * 60_000;
  instant = wall - zoneOffsetMinutes(instant, timeZone) * 60_000;
  return instant;
}

const FIRST_CALL_DAY = Date.UTC(2026, 10, 2); // 2026-11-02, a Monday
const LAST_CALL_DAY = Date.UTC(2027, 1, 26); // 2027-02-26, a Friday
const DAY_MS = 86_400_000;

function planScripts(): ScriptPlan[] {
  const rng = createRng(subSeed(DEBRIEF_SEED, "plan"));
  // Accounts: every company, once more for each of being in a confusable group and having a deal
  // to update, dealt in shuffled rounds.
  const withDeal = new Set(deals.map((deal) => deal.companyId));
  const deck = [
    ...companies.map((company) => company.id),
    ...companies.filter((company) => inConfusableGroup(company.id)).map((company) => company.id),
    ...companies.filter((company) => withDeal.has(company.id)).map((company) => company.id),
  ];
  let accounts: string[] = [];
  let voices: KokoroVoice[] = [];
  const taken = new Set(DEBRIEFS.map((script) => Date.parse(script.callTime)));
  const days: string[] = [];
  for (let at = FIRST_CALL_DAY; at <= LAST_CALL_DAY; at += DAY_MS) {
    const weekday = new Date(at).getUTCDay();
    if (weekday >= 1 && weekday <= 5) days.push(new Date(at).toISOString().slice(0, 10));
  }
  return GENERATED_IDS.map((id, index) => {
    if (accounts.length === 0) accounts = rng.shuffle(deck);
    if (voices.length === 0) voices = rng.shuffle(KOKORO_VOICES);
    const company = accounts.pop() as string;
    const voice = voices.pop() as KokoroVoice;
    const timeZone = rng.weighted(TIME_ZONES);
    let callTime = 0;
    do {
      const day = rng.pick(days);
      const hour = rng.int(8, 17);
      const minute = rng.pick([0, 10, 20, 30, 40, 50]);
      callTime = zonedInstant(day, hour, minute, timeZone);
    } while (taken.has(callTime));
    taken.add(callTime);
    const noiseKind = rng.weighted(NOISE_WEIGHTS);
    const noise: Noise | null =
      noiseKind === "none" ? null : { kind: noiseKind, snrDb: rng.pick(NOISE_SNRS) };
    const roll = rng.next();
    return {
      id,
      company,
      focusEntityId: rng.chance(0.8) ? company : null,
      voice,
      speed: rng.chance(0.2) ? rng.pick([0.9, 0.95, 1.05, 1.1]) : null,
      noise,
      timeZone,
      callTime: new Date(callTime).toISOString(),
      turns: roll < 0.3 ? 3 : roll < 0.7 ? 4 : 5,
      // About one script in four each; the coverage minimums are 25 and 30.
      snap: index % 4 === 2 || rng.chance(0.06),
      correction: index % 4 === 1 || rng.chance(0.08),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// One proposal, planned

type TargetPlan =
  | { readonly kind: "record"; readonly id: string; readonly mode: MentionMode }
  | { readonly kind: "new"; readonly decoy: Decoy; readonly mode: "decoy" | "snap" }
  | { readonly kind: "implied"; readonly id: string };

interface ProposalPlan {
  readonly type: ProposalTypeV2;
  readonly target: TargetPlan;
  /** Say a contact's company with it. */
  readonly withCompany: boolean;
}

/** What one proposal contributes to its turn once composed. */
interface Composed {
  readonly segs: Seg[];
  readonly expected: (rendered: ReturnType<typeof render>) => ExpectedProposal;
  readonly mention: PlannedMention | null;
  readonly negation: boolean;
  /** The proposal's date and amount fields, for a self-correction. */
  readonly values: ReadonlyMap<string, ValuePhrase<string> | ValuePhrase<number>>;
  readonly target: { readonly id: string | null; readonly decision: TargetDecision };
  readonly linkedCompany: string | null;
  readonly describe: string;
}

interface Session {
  readonly plan: ScriptPlan;
  readonly ctx: CallContext;
  readonly rng: Rng;
  recent: string[];
}

const contactsOf = (companyId: string) =>
  contacts.filter((contact) => contact.companyId === companyId).map((contact) => contact.id);
const dealsOf = (companyId: string) =>
  deals.filter((deal) => deal.companyId === companyId).map((deal) => deal.id);

/** A record of a company's family, confusable members twice as likely. */
function pickWeighted(rng: Rng, ids: readonly string[]): string {
  return rng.pick(ids.flatMap((id) => (inConfusableGroup(id) ? [id, id] : [id])));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A field's value written the way a model would, from the template's pattern. */
function fillValue(pattern: string, words: Readonly<Record<string, string>>): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char !== "{") {
      out += char;
      continue;
    }
    const end = pattern.indexOf("}", i);
    const name = pattern.slice(i + 1, end);
    const value = words[name] ?? words[name.toLowerCase()];
    if (value === undefined) throw new Error(`no value for {${name}} in "${pattern}"`);
    out += name.charAt(0) === name.charAt(0).toUpperCase() ? capitalize(value) : value;
    i = end;
  }
  return out;
}

const VAR = (words: Words, role?: string): Seg => ({
  kind: "var",
  ...words,
  ...(role ? { role } : {}),
});

const NEGATABLE_SLOTS = new Set(["fact", "Fact", "promise"]);

/** Whether a template can carry a negation: a note's clause, a promise, or its own words. */
function canNegate(template: Template): boolean {
  return (
    template.negation === true ||
    parseTemplate(template.text).some(
      (part) => part.kind === "slot" && NEGATABLE_SLOTS.has(part.name),
    )
  );
}

/**
 * The templates a proposal can use. A promise is only ever negated ("we won't raise prices"), so
 * that template waits for a negated turn.
 */
function templatesFor(
  proposal: ProposalPlan,
  mentionKind: EntityKind | null,
  negate: boolean,
): Template[] {
  const isNew = proposal.target.kind === "new";
  return TEMPLATES[proposal.type].filter((template) => {
    const parts = parseTemplate(template.text);
    const slots = new Set(parts.flatMap((part) => (part.kind === "slot" ? [part.name] : [])));
    if (mentionKind === null ? template.kinds.length > 0 : !template.kinds.includes(mentionKind)) {
      return false;
    }
    if (mentionKind !== null && slots.has("C") !== proposal.withCompany) return false;
    if (isNew && template.forNew === false) return false;
    if (!isNew && template.onlyNew) return false;
    if (slots.has("promise") && !negate) return false;
    if (negate && !canNegate(template)) return false;
    return true;
  });
}

/** Composes one proposal: its template filled, its mention heard, its expected proposal. */
function composeProposal(
  session: Session,
  proposal: ProposalPlan,
  index: number,
  negate: boolean,
): Composed | null {
  const { rng, ctx, plan } = session;
  let mention: PlannedMention | null = null;
  let target: { id: string | null; decision: TargetDecision };
  let flags: RiskKindV2[] = [];
  let mentionKind: EntityKind | null = null;
  if (proposal.target.kind === "implied") {
    target = { id: proposal.target.id, decision: "linked" };
    flags = ["implied_target"];
  } else {
    const request = {
      type: proposal.type,
      target: proposal.target.kind === "record" ? proposal.target.id : proposal.target.decoy,
      mode: proposal.target.mode,
      withCompany: proposal.withCompany,
      focusEntityId: plan.focusEntityId,
      recent: session.recent,
      allowAsk: rng.chance(0.3),
    };
    mention = planMention(request, rng);
    if (mention === null) return null;
    target = { ...mention.expected };
    flags = [...mention.flags];
    mentionKind = mention.kind;
  }
  // A negation goes where the type has room for one; elsewhere the turn goes without.
  const negatable = templatesFor(proposal, mentionKind, true);
  const negated = negate && negatable.length > 0;
  let options = negated ? negatable : templatesFor(proposal, mentionKind, false);
  // Most deal updates move the number: amounts are a coverage minimum of their own.
  if (proposal.type === "deal_update" && rng.chance(0.8)) {
    const priced = options.filter((option) => option.text.includes("{AMT}"));
    if (priced.length > 0) options = priced;
  }
  if (options.length === 0) return null;
  const template = rng.pick(options);
  const parts = parseTemplate(template.text);

  // The words the template's slots take.
  const doc = rng.pick(DOCS);
  const topic = rng.pick(TOPICS);
  const fact = negated ? rng.pick(NEGATED_FACTS) : rng.pick(FACTS);
  const promise = rng.pick(NEGATED_PROMISES);
  const role = rng.pick(ROLES);
  const values = new Map<string, ValuePhrase<string> | ValuePhrase<number>>();
  const drop = new Set<string>();
  const fields = new Set(parts.flatMap((part) => (part.kind === "open" ? [part.field] : [])));
  if (fields.has("dueDate") && rng.chance(0.25)) drop.add("dueDate");
  if (fields.has("time") && fields.has("date") && rng.chance(0.3)) drop.add("time");
  const companyWords: Words | null =
    mention?.company ??
    (parts.some((part) => part.kind === "slot" && part.name === "C")
      ? companyMention(plan.company, plan.focusEntityId, rng)
      : null);
  const personField =
    template.personField !== undefined &&
    mention !== null &&
    (mention.kind === "contact" || rng.chance(0.3)) &&
    rng.chance(0.7)
      ? template.personField
      : null;
  const email =
    proposal.type === "contact" && mention !== null
      ? proposal.target.kind === "record"
        ? (contacts.find((contact) => contact.id === (proposal.target as { id: string }).id)
            ?.email ?? "")
        : emailFor(
            mention.words.said,
            companies.find((company) => company.id === plan.company)?.domain ?? "example.example",
          )
      : "";
  const phone = phoneFor(rng);
  const stage = rng.pick(STAGES);
  const early = rng.pick(EARLY_STAGES);
  const fill = (slot: string): Seg | Seg[] => {
    switch (slot) {
      case "M": {
        if (mention === null)
          throw new Error(`${template.id} names a record, but none was planned`);
        const seg = VAR(mention.words, `mention:${index}`);
        return personField
          ? [{ kind: "open", field: personField }, seg, { kind: "close", field: personField }]
          : seg;
      }
      case "C":
        if (companyWords === null)
          throw new Error(`${template.id} says a company, but none was planned`);
        return VAR(companyWords, `company:${index}`);
      case "DUE": {
        const phrase = duePhrase(rng, ctx);
        values.set("dueDate", phrase);
        return lit(phrase.said);
      }
      case "CLOSE": {
        const phrase = closePhrase(rng, ctx);
        values.set("closeDate", phrase);
        return lit(phrase.said);
      }
      case "DAY": {
        const phrase = dayPhrase(rng, ctx);
        values.set("date", phrase);
        return lit(phrase.said);
      }
      case "TIME": {
        const phrase = timePhrase(rng);
        values.set("time", phrase);
        return lit(phrase.said);
      }
      case "AMT": {
        const phrase = amountPhrase(rng);
        values.set("amount", phrase);
        return VAR({ said: phrase.said, biased: phrase.heard, unbiased: phrase.heard });
      }
      case "STAGE":
        return lit(stage);
      case "EARLY":
        return lit(early);
      case "ROLE":
        return lit(role);
      case "EMAIL":
        return lit(email);
      case "PHONE":
        return lit(phone);
      case "doc":
        return lit(doc);
      case "topic":
        return lit(topic);
      case "fact":
        return lit(fact);
      case "Fact":
        return lit(capitalize(fact));
      case "promise":
        return lit(promise);
      case "role":
        return lit(role);
      default:
        throw new Error(`${template.id} has an unknown slot {${slot}}`);
    }
  };
  // A deal update needs a field left after dropping; contacts and the rest always have one.
  const segs = fillTemplate(parts, fill, drop).map(
    (seg): Seg =>
      seg.kind === "open" || seg.kind === "close"
        ? { ...seg, field: `${index}.${seg.field}` }
        : seg,
  );
  // The quoted clause carries the negation (a note's body, a promise's text), so that field is
  // expected to be flagged; a template's own negation sits outside every field.
  const negation = template.negation === true || negated;
  const negatedFields =
    negated && !template.negation ? (fields.has("body") ? ["body"] : ["text"]) : [];

  const mentionWords = mention?.words ?? null;
  const expected = (rendered: ReturnType<typeof render>): ExpectedProposal => {
    const quoteOf = (field: string) => {
      const span = rendered.fields.get(`${index}.${field}`);
      if (!span) throw new Error(`${template.id}: no span for ${field}`);
      return rendered.text.slice(span[0], span[1]);
    };
    const mentionQuote = (() => {
      const span = rendered.roles.get(`mention:${index}`);
      return span ? rendered.text.slice(span[0], span[1]) : null;
    })();
    const companyQuote = (() => {
      const span = rendered.roles.get(`company:${index}`);
      return span ? rendered.text.slice(span[0], span[1]) : null;
    })();
    const words: Record<string, string> = {
      m: mentionQuote ?? "",
      c: companyQuote ?? "",
      doc,
      topic,
      fact,
      promise,
      role,
    };
    const out: Record<string, { value: string | number; quote: string }> = {};
    const prefix = `${index}.`;
    const filled = segs.flatMap((seg) =>
      seg.kind === "open" && seg.field.startsWith(prefix) ? [seg.field.slice(prefix.length)] : [],
    );
    for (const field of filled) {
      const quote = quoteOf(field);
      const phrase = values.get(field);
      let value: string | number;
      if (field === "dueDate" || field === "closeDate" || field === "date") {
        const resolved = resolveDatePhrase(quote, ctx.callTime, ctx.timeZone);
        if (resolved === null || resolved.date !== phrase?.value) {
          throw new Error(`${template.id}: "${quote}" doesn't resolve to ${String(phrase?.value)}`);
        }
        value = resolved.date;
      } else if (field === "amount") {
        if (parseUsd(quote) !== phrase?.value)
          throw new Error(`${template.id}: "${quote}" isn't ${String(phrase?.value)}`);
        value = phrase.value;
      } else if (field === "time") {
        const time = resolveTimePhrase(quote);
        if (time === null || time !== phrase?.value)
          throw new Error(`${template.id}: "${quote}" isn't ${String(phrase?.value)}`);
        value = time;
      } else if (
        field === personField ||
        field === "name" ||
        field === "company" ||
        field === "stage" ||
        field === "email" ||
        field === "phone" ||
        (field === "title" && proposal.type === "contact")
      ) {
        value = quote;
      } else {
        const pattern = template.values?.[field];
        if (pattern === undefined) throw new Error(`${template.id}: no value for ${field}`);
        value = fillValue(pattern, words);
      }
      out[field] = { value, quote };
    }
    const expectFlags = [
      ...new Set([...flags, ...(negatedFields.length > 0 ? (["negation"] as RiskKindV2[]) : [])]),
    ];
    const targetField = { target: { id: target.id, decision: target.decision } };
    const flagField = expectFlags.length > 0 ? { expectFlags } : {};
    if (proposal.type === "contact") {
      return { type: "contact", ...targetField, ...flagField, fields: out as never };
    }
    const named =
      mentionQuote === null || mention === null
        ? {}
        : {
            named: {
              quote: mentionQuote,
              kind: mention.kind,
              ...(mention.kind === "deal" && mention.companyPart
                ? { company: mention.companyPart.biased }
                : companyQuote !== null
                  ? { company: companyQuote }
                  : {}),
            },
          };
    return {
      type: proposal.type,
      ...targetField,
      ...named,
      ...flagField,
      fields: out,
    } as ExpectedProposal;
  };
  const describe = describeProposal(proposal, mentionWords);
  // The company said with the target (a contact's, or a new contact's company field) or inside a
  // deal's words: the session links it and keeps it among the earlier links.
  const companyLinkText = companyWords?.biased ?? mention?.companyPart?.biased ?? null;
  return {
    segs,
    expected,
    mention,
    negation,
    values,
    target,
    linkedCompany:
      companyLinkText === null
        ? null
        : linkedCompanyOf(companyLinkText, plan.focusEntityId, session.recent),
    describe,
  };
}

function describeProposal(proposal: ProposalPlan, words: Words | null): string {
  const name = words?.said ?? "the account";
  switch (proposal.type) {
    case "note":
      return `a note on ${name}`;
    case "task":
      return `a task for ${name}`;
    case "commitment":
      return `a promise to ${name}`;
    case "deal_update":
      return `the ${name} deal`;
    case "meeting":
      return `a meeting with ${name}`;
    case "contact":
      return proposal.target.kind === "record" ? `${name}'s details` : `a new contact, ${name}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Recipes: what a turn is about

type Recipe =
  | "company_note"
  | "company_task"
  | "company_commitment"
  | "company_meeting"
  | "contact_task"
  | "contact_note"
  | "contact_commitment"
  | "contact_meeting"
  | "deal_update"
  | "deal_other"
  | "new_contact"
  | "update_contact"
  | "new_company"
  | "other_account"
  | "implied"
  | "snap";

function recordMode(rng: Rng): MentionMode {
  return rng.weighted({ exact: 0.45, natural: 0.4, misheard: 0.15 });
}

/** The proposal (or proposals) a recipe makes, for this script; null when it doesn't apply. */
function proposalsFor(session: Session, recipe: Recipe): ProposalPlan[] | null {
  const { rng, plan } = session;
  const family = plan.company;
  const people = contactsOf(family);
  const familyDeals = dealsOf(family);
  const focused = plan.focusEntityId === family;
  const contactCompany = (contactId: string) =>
    contacts.find((contact) => contact.id === contactId)?.companyId ?? null;
  const person = (type: ProposalTypeV2): ProposalPlan | null => {
    if (people.length === 0) return null;
    const id = pickWeighted(rng, people);
    const withCompany = rng.chance(focused ? 0.3 : 0.75);
    return { type, target: { kind: "record", id, mode: recordMode(rng) }, withCompany };
  };
  const companyTarget = (type: ProposalTypeV2): ProposalPlan => ({
    type,
    target: { kind: "record", id: family, mode: recordMode(rng) },
    withCompany: false,
  });
  switch (recipe) {
    case "company_note":
      return [companyTarget("note")];
    case "company_task":
      return [companyTarget("task")];
    case "company_commitment":
      return [companyTarget("commitment")];
    case "company_meeting":
      return [companyTarget("meeting")];
    case "contact_task": {
      const p = person("task");
      return p ? [p] : null;
    }
    case "contact_note": {
      const p = person("note");
      return p ? [p] : null;
    }
    case "contact_commitment": {
      const p = person("commitment");
      return p ? [p] : null;
    }
    case "contact_meeting": {
      const p = person("meeting");
      return p ? [p] : null;
    }
    case "deal_update": {
      const id = familyDeals[0];
      if (id === undefined) return null;
      const update: ProposalPlan = {
        type: "deal_update",
        target: { kind: "record", id, mode: recordMode(rng) },
        withCompany: false,
      };
      // A deal update often comes with a task for one of the account's people.
      if (rng.chance(0.3)) {
        const follow = person("task");
        if (follow) return [update, follow];
      }
      return [update];
    }
    case "deal_other": {
      const id = familyDeals[0];
      if (id === undefined) return null;
      const type = rng.pick(["note", "task", "commitment", "meeting"] as const);
      return [{ type, target: { kind: "record", id, mode: recordMode(rng) }, withCompany: false }];
    }
    case "new_contact":
      return [
        {
          type: "contact",
          target: { kind: "new", decoy: rng.pick(NEW_CONTACT_NAMES), mode: "decoy" },
          withCompany: rng.chance(0.6),
        },
      ];
    case "update_contact": {
      if (people.length === 0) return null;
      const id = pickWeighted(rng, people);
      return [
        {
          type: "contact",
          target: { kind: "record", id, mode: recordMode(rng) },
          withCompany: rng.chance(0.4),
        },
      ];
    }
    case "new_company": {
      const type = rng.pick(["note", "task", "meeting", "commitment"] as const);
      return [
        {
          type,
          target: { kind: "new", decoy: rng.pick(NEW_COMPANY_NAMES), mode: "decoy" },
          withCompany: false,
        },
      ];
    }
    case "other_account": {
      // Another account, named in passing: its company, or one of its people with the company said.
      const other = pickWeighted(
        rng,
        companies.map((company) => company.id).filter((id) => id !== family),
      );
      const type = rng.pick(["note", "task", "meeting", "commitment"] as const);
      const otherPeople = contactsOf(other);
      if (otherPeople.length > 0 && rng.chance(0.5)) {
        const id = pickWeighted(rng, otherPeople);
        return [
          {
            type,
            target: { kind: "record", id, mode: recordMode(rng) },
            withCompany: contactCompany(id) !== null,
          },
        ];
      }
      return [
        { type, target: { kind: "record", id: other, mode: recordMode(rng) }, withCompany: false },
      ];
    }
    case "implied": {
      if (plan.focusEntityId === null) return null;
      const type = rng.pick(["note", "task", "commitment", "meeting", "deal_update"] as const);
      if (type === "deal_update") {
        const only = dealsOf(plan.focusEntityId);
        if (only.length !== 1) return null;
        return [{ type, target: { kind: "implied", id: only[0] as string }, withCompany: false }];
      }
      return [{ type, target: { kind: "implied", id: plan.focusEntityId }, withCompany: false }];
    }
    case "snap": {
      // A new person whose sound-alike works at the open account (a contact is a keyterm only
      // then), or a new company a word away from a boosted CRM company.
      const people_ = DECOYS.filter(
        (decoy) =>
          decoy.kind === "contact" &&
          decoy.like !== null &&
          plan.focusEntityId !== null &&
          contactCompany(decoy.like) === plan.focusEntityId,
      );
      if (people_.length > 0 && rng.chance(0.6)) {
        return [
          {
            type: "contact",
            target: { kind: "new", decoy: rng.pick(people_), mode: "snap" },
            withCompany: rng.chance(0.4),
          },
        ];
      }
      const type = rng.pick(["note", "task", "meeting", "commitment"] as const);
      return [
        {
          type,
          target: {
            kind: "new",
            decoy: rng.pick(NEW_COMPANY_NAMES.filter((decoy) => decoy.like !== null)),
            mode: "snap",
          },
          withCompany: false,
        },
      ];
    }
  }
}

const OPENERS: Readonly<Record<string, number>> = {
  company_note: 0.3,
  deal_update: 0.35,
  contact_task: 0.15,
  company_meeting: 0.1,
  contact_note: 0.15,
};

const LATER: Readonly<Record<string, number>> = {
  contact_task: 0.1,
  contact_note: 0.05,
  contact_commitment: 0.07,
  contact_meeting: 0.09,
  company_task: 0.05,
  company_commitment: 0.04,
  company_meeting: 0.04,
  company_note: 0.04,
  deal_update: 0.17,
  deal_other: 0.03,
  new_contact: 0.06,
  update_contact: 0.05,
  new_company: 0.03,
  other_account: 0.05,
  implied: 0.07,
};

// ---------------------------------------------------------------------------------------------
// A turn

interface TurnOut {
  readonly turn: DebriefScriptFile["turns"][number];
  readonly describe: readonly string[];
}

const CORRECTION_MARKERS = [
  ", sorry, ",
  ", I mean ",
  ", actually ",
  ", make that ",
  ". Scratch that, ",
];

/** Takes back one date or amount in a composed turn; null when it has neither to take back. */
function addCorrection(
  segs: readonly Seg[],
  composed: readonly Composed[],
  session: Session,
): Seg[] | null {
  const { rng, ctx } = session;
  const candidates: { index: number; field: string }[] = [];
  composed.forEach((proposal, index) => {
    for (const field of ["amount", "dueDate", "closeDate", "date"]) {
      if (proposal.values.has(field)) candidates.push({ index, field });
    }
  });
  for (const candidate of rng.shuffle(candidates)) {
    const name = `${candidate.index}.${candidate.field}`;
    const at = segs.findIndex((seg) => seg.kind === "open" && seg.field === name);
    const phrase = composed[candidate.index]?.values.get(candidate.field);
    const inner = segs[at + 1];
    if (at < 0 || !phrase || !inner || inner.kind === "open" || inner.kind === "close") continue;
    const marker = rng.pick(CORRECTION_MARKERS);
    if (candidate.field === "amount" && typeof phrase.value === "number") {
      const correction = amountCorrection(phrase as ValuePhrase<number>, rng);
      if (!correction) continue;
      const { retracted } = correction;
      return [
        ...segs.slice(0, at),
        VAR({ said: retracted.said, biased: retracted.heard, unbiased: retracted.heard }),
        lit(marker, true),
        ...segs.slice(at),
      ];
    }
    if (typeof phrase.value === "string") {
      const correction = dateCorrection(phrase as ValuePhrase<string>, rng, ctx);
      if (!correction) continue;
      return [
        ...segs.slice(0, at),
        lit(`${correction.retracted}${marker}`, true),
        segs[at] as Seg,
        lit(correction.replacement.said),
        ...segs.slice(at + 2),
      ];
    }
  }
  return null;
}

/**
 * A turn that proposes nothing: the end of the debrief ("That's all for Acme Dynamics."), or,
 * more often, a sound-alike account set aside with a negation ("Not to be confused with Akme
 * Dynamics, which is a different account.").
 */
function quietTurn(session: Session): { segs: Seg[]; negation: boolean } {
  const { rng, plan } = session;
  const siblings = groupMembers(plan.company).filter((id) => id !== plan.company);
  const template: QuietTemplate = rng.chance(0.65)
    ? rng.pick(NEGATED_QUIET_TEMPLATES)
    : rng.pick(QUIET_TEMPLATES);
  const others = companies.map((company) => company.id).filter((id) => id !== plan.company);
  const other = siblings.length > 0 ? rng.pick(siblings) : rng.pick(others);
  const segs = fillTemplate(parseTemplate(template.text), (slot) => {
    if (slot === "M") return VAR(plainWords(linkingEntity(plan.company).name));
    if (slot === "S") return VAR(plainWords(linkingEntity(other).name));
    throw new Error(`unknown slot {${slot}} in ${template.id}`);
  });
  return { segs, negation: template.negation };
}

function composeTurn(
  session: Session,
  recipe: Recipe | "quiet",
  options: { correction: boolean; first: boolean },
): TurnOut | null {
  const { rng } = session;
  const pauseBeforeMs = options.first ? rng.int(12, 20) * 100 : rng.int(9, 26) * 100;
  if (recipe === "quiet") {
    const quiet = quietTurn(session);
    return finishTurn(session, quiet.segs, [], {
      pauseBeforeMs,
      negation: quiet.negation,
      correction: false,
    });
  }
  const proposals = proposalsFor(session, recipe);
  if (proposals === null) return null;
  const negate = rng.chance(0.14);
  const composed: Composed[] = [];
  let recent = session.recent;
  for (const [index, proposal] of proposals.entries()) {
    const saved = session.recent;
    session.recent = recent;
    const result = composeProposal(session, proposal, index, negate && index === 0);
    session.recent = saved;
    if (result === null) return null;
    composed.push(result);
    recent = nextRecent(
      recent,
      result.linkedCompany,
      proposal.target.kind === "implied" ? null : result.target,
    );
  }
  let segs = composed[0]?.segs ?? [];
  for (const next of composed.slice(1)) segs = joinSentences(segs, next.segs);
  let correction = false;
  if (options.correction) {
    const corrected = addCorrection(segs, composed, session);
    if (corrected) {
      segs = corrected;
      correction = true;
    }
  }
  const out = finishTurn(session, segs, composed, {
    pauseBeforeMs,
    negation: composed.some((proposal) => proposal.negation),
    correction,
  });
  if (out === null) return null;
  session.recent = recent;
  return out;
}

/** Adds disfluencies, renders the three versions, and checks what the ground truth relies on. */
function finishTurn(
  session: Session,
  input: readonly Seg[],
  composed: readonly Composed[],
  info: { pauseBeforeMs: number; negation: boolean; correction: boolean },
): TurnOut | null {
  const { rng } = session;
  let segs = [...input];
  let disfluent = false;
  if (rng.chance(0.36)) {
    const count = rng.chance(0.2) ? 2 : 1;
    for (let n = 0; n < count; n++) {
      for (const kind of rng.shuffle<DisfluencyKind>(DISFLUENCY_KINDS)) {
        const changed = addDisfluency(segs, kind, rng);
        if (changed) {
          segs = changed;
          disfluent = true;
          break;
        }
      }
    }
  }
  const said = render(segs, "said");
  const biased = render(segs, "biased");
  const unbiased = render(segs, "unbiased");
  for (const text of [said.text, biased.text, unbiased.text]) {
    if (!isTidy(text) || text.length > 600) return null;
  }
  // A date, time, or amount must be the first of its words in the turn: that's where evidence
  // lands, and it's what makes a self-correction's quote the value the rep settled on.
  for (const [name, span] of biased.fields) {
    const field = name.slice(name.indexOf(".") + 1);
    if (!["dueDate", "closeDate", "date", "time", "amount"].includes(field)) continue;
    const quote = biased.text.slice(span[0], span[1]);
    if (biased.text.indexOf(quote) !== span[0]) return null;
  }
  let expect: ExpectedProposal[];
  try {
    expect = composed.map((proposal) => proposal.expected(biased));
  } catch {
    return null;
  }
  const tags: TurnTag[] = [];
  if (info.negation) tags.push("negation");
  if (info.correction) tags.push("self_correction");
  if (disfluent) tags.push("disfluency");
  const heard: { biased?: string; unbiased?: string } = {};
  if (biased.text !== said.text) heard.biased = biased.text;
  if (unbiased.text !== said.text) heard.unbiased = unbiased.text;
  return {
    turn: {
      pauseBeforeMs: info.pauseBeforeMs,
      text: said.text,
      ...(Object.keys(heard).length > 0 ? { heard } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      expect,
    },
    describe: composed.map((proposal) => proposal.describe),
  };
}

// ---------------------------------------------------------------------------------------------
// A script

function generateScript(plan: ScriptPlan): DebriefScriptFile {
  const rng = createRng(subSeed(DEBRIEF_SEED, `script:${plan.id}`));
  const session: Session = {
    plan,
    ctx: { callTime: plan.callTime, timeZone: plan.timeZone },
    rng,
    recent: [],
  };
  const snapAt = plan.snap ? rng.int(1, plan.turns - 1) : -1;
  // From this turn on, the first turn with a date or an amount to take back takes one back.
  const correctionFrom = plan.correction ? rng.int(0, plan.turns - 1) : plan.turns;
  let corrected = false;
  const turns: DebriefScriptFile["turns"] = [];
  const described: string[] = [];
  for (let index = 0; index < plan.turns; index++) {
    const last = index === plan.turns - 1;
    let out: TurnOut | null = null;
    for (let attempt = 0; attempt < MAX_TURN_ATTEMPTS && out === null; attempt++) {
      let recipe: Recipe | "quiet";
      if (index === snapAt && attempt < MAX_TURN_ATTEMPTS / 2) recipe = "snap";
      else if (index === 0) recipe = rng.weighted(OPENERS) as Recipe;
      else if (rng.chance(last ? 0.2 : 0.08)) recipe = "quiet";
      else recipe = rng.weighted(LATER) as Recipe;
      out = composeTurn(session, recipe, {
        correction: !corrected && index >= correctionFrom,
        first: index === 0,
      });
    }
    if (out === null) {
      throw new Error(`${plan.id} turn ${index + 1}: no turn after ${MAX_TURN_ATTEMPTS} attempts`);
    }
    if (out.turn.tags?.includes("self_correction")) corrected = true;
    turns.push(out.turn);
    described.push(...out.describe);
  }
  const account = linkingEntity(plan.company).name;
  const parts = [...new Set(described)];
  let title = `${account}: ${parts.join(", ")}`;
  while (title.length > 120 && parts.length > 1) {
    parts.pop();
    title = `${account}: ${parts.join(", ")}, and more`;
  }
  if (title.length > 120) title = `${title.slice(0, 117)}...`;
  return {
    version: DEBRIEF_FORMAT_VERSION,
    id: plan.id,
    title,
    voice: plan.voice,
    ...(plan.speed !== null ? { speed: plan.speed } : {}),
    callTime: plan.callTime,
    timeZone: plan.timeZone,
    ...(plan.focusEntityId !== null ? { focusEntityId: plan.focusEntityId } : {}),
    ...(plan.noise !== null ? { noise: plan.noise } : {}),
    turns,
  };
}

/** d031–d200, as the generator writes them today. */
export function generateDebriefScripts(): DebriefScriptFile[] {
  return planScripts().map(generateScript);
}

/** A script file's bytes: two-space JSON and a final newline. */
export function serializeScript(script: DebriefScriptFile): string {
  return `${JSON.stringify(script, null, 2)}\n`;
}

/** The call's local date, for tests. */
export function callDateOf(script: Pick<DebriefScriptFile, "callTime" | "timeZone">): string {
  return localDate(script.callTime, script.timeZone);
}
