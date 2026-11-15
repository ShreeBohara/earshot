// Pure dataset builder: no filesystem, no clock. `generate.ts` writes its output to data/, and a
// test re-runs it to prove the committed files are fresh.
import type {
  Activity,
  Company,
  ConfusableGroup,
  Contact,
  CrmDataset,
  Deal,
  DealStage,
} from "../src/schemas";
import {
  CITIES,
  COMPANY_GROUPS,
  CONTACT_GROUPS,
  DEAL_PRODUCTS,
  FILLER_FIRST_NAMES,
  FILLER_LAST_NAMES,
  MEETING_BODIES,
  MEETING_SUBJECTS,
  NOTE_BODIES,
  NOTE_SUBJECTS,
  SINGLE_COMPANIES,
  SIZES,
  TASK_BODIES,
  TASK_SUBJECTS,
  TITLES,
} from "./seed";

export const SEED = 0x6a09e667;
/** Every date in the dataset is relative to this instant. */
export const ANCHOR = Date.UTC(2026, 10, 1);
export const COMPANY_COUNT_TARGET = 60;
export const CONTACT_COUNT_TARGET = 150;
export const DEAL_COUNT_TARGET = 40;

const DAY = 86_400_000;
const HOUR = 3_600_000;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rng(seed: number) {
  const next = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    if (item === undefined) throw new Error("pick from empty list");
    return item;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  };
  return { next, int, pick, shuffle };
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const pad = (n: number, width = 3) => String(n).padStart(width, "0");
const isoDateTime = (ms: number) => new Date(ms).toISOString();
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The full dataset, byte-for-byte reproducible. */
export function buildDataset(): CrmDataset {
  const r = rng(SEED);

  // Companies: ids are assigned after a shuffle so id order does not reveal the groups.
  type Seeded = {
    name: string;
    industry: string;
    aliases: string[];
    group?: number;
  };
  const seeded: Seeded[] = [];
  COMPANY_GROUPS.forEach((group, index) => {
    for (const m of group.members) {
      seeded.push({ name: m.name, industry: m.industry, aliases: m.aliases ?? [], group: index });
    }
  });
  for (const m of SINGLE_COMPANIES) {
    seeded.push({ name: m.name, industry: m.industry, aliases: m.aliases ?? [] });
  }
  const companies: Company[] = r.shuffle(seeded).map((s, i) => {
    const [first = s.name] = s.name.split(" ");
    const aliases = [...new Set([first, ...s.aliases])].filter((a) => a !== s.name);
    return {
      id: `co_${pad(i + 1)}`,
      name: s.name,
      domain: `${slug(s.name)}.example`,
      industry: s.industry,
      size: r.pick(SIZES),
      city: r.pick(CITIES),
      aliases,
    };
  });
  const companyByName = new Map(companies.map((c) => [c.name, c]));
  const companyId = (name: string) => {
    const c = companyByName.get(name);
    if (!c) throw new Error(`unknown company ${name}`);
    return c.id;
  };

  // Contacts: confusable groups first, then filler until every account has someone to call.
  const contacts: Contact[] = [];
  const contactGroups: { confusion: ConfusableGroup["confusion"]; names: string[] }[] = [];
  const usedNames = new Set<string>();
  const usedEmails = new Set<string>();
  const domainOf = new Map(companies.map((c) => [c.id, c.domain]));
  const pendingContacts: { first: string; last: string; companyId: string }[] = [];

  for (const group of CONTACT_GROUPS) {
    const pool = r.shuffle(companies.map((c) => c.id));
    const keys: string[] = [];
    group.members.forEach(([first, last], i) => {
      const pinned = group.pinTo?.[i];
      const cid = pinned ? companyId(pinned) : (pool[i] as string);
      pendingContacts.push({ first, last, companyId: cid });
      keys.push(`${first} ${last}`);
    });
    contactGroups.push({ confusion: group.confusion, names: keys });
  }

  // Filler: cover accounts with no contact yet, then random accounts, up to the target.
  const covered = new Set(pendingContacts.map((p) => p.companyId));
  const uncovered = r.shuffle(companies.filter((c) => !covered.has(c.id)).map((c) => c.id));
  const fillerTotal = CONTACT_COUNT_TARGET - pendingContacts.length;
  for (let i = 0; i < fillerTotal; i++) {
    let first: string;
    let last: string;
    do {
      first = r.pick(FILLER_FIRST_NAMES);
      last = r.pick(FILLER_LAST_NAMES);
    } while (usedNames.has(`${first} ${last}`));
    usedNames.add(`${first} ${last}`);
    const cid = uncovered[i] ?? r.pick(companies).id;
    pendingContacts.push({ first, last, companyId: cid });
  }
  // Interleave so confusable people are not clustered at the front of the id range.
  const idByName = new Map<string, string>();
  r.shuffle(pendingContacts).forEach((p, i) => {
    const id = `ct_${pad(i + 1)}`;
    const base = `${p.first}.${p.last}`.toLowerCase().replace(/[^a-z.]/g, "");
    const domain = domainOf.get(p.companyId) as string;
    let email = `${base}@${domain}`;
    for (let n = 2; usedEmails.has(email); n++) email = `${base}${n}@${domain}`;
    usedEmails.add(email);
    contacts.push({
      id,
      companyId: p.companyId,
      firstName: p.first,
      lastName: p.last,
      title: r.pick(TITLES),
      email,
      phone: `555-01${pad(r.int(0, 99), 2)}`,
    });
    idByName.set(`${p.first} ${p.last}`, id);
  });
  if (new Set(contacts.map((c) => `${c.firstName} ${c.lastName}`)).size !== contacts.length) {
    throw new Error("duplicate contact names");
  }

  const contactsByCompany = new Map<string, Contact[]>();
  for (const c of contacts) {
    const list = contactsByCompany.get(c.companyId) ?? [];
    list.push(c);
    contactsByCompany.set(c.companyId, list);
  }
  const contactsOf = (id: string) => contactsByCompany.get(id) ?? [];

  // Deals.
  const stageWeights: [DealStage, number][] = [
    ["appointmentscheduled", 5],
    ["qualifiedtobuy", 5],
    ["presentationscheduled", 5],
    ["decisionmakerboughtin", 4],
    ["contractsent", 4],
    ["closedwon", 10],
    ["closedlost", 5],
  ];
  const totalWeight = stageWeights.reduce((sum, [, w]) => sum + w, 0);
  const pickStage = (): DealStage => {
    let roll = r.int(1, totalWeight);
    for (const [stage, w] of stageWeights) {
      roll -= w;
      if (roll <= 0) return stage;
    }
    return "closedwon";
  };
  const deals: Deal[] = [];
  const dealCompanies = r.shuffle(companies.map((c) => c.id));
  for (let i = 0; i < DEAL_COUNT_TARGET; i++) {
    const cid = dealCompanies[i % dealCompanies.length] as string;
    const company = companies.find((c) => c.id === cid) as Company;
    const stage = pickStage();
    const closed = stage === "closedwon" || stage === "closedlost";
    const offset = closed ? -r.int(7, 200) : r.int(10, 150);
    const amount = Math.round(Math.exp(Math.log(5000) + r.next() * Math.log(50)) / 500) * 500;
    deals.push({
      id: `deal_${pad(i + 1)}`,
      companyId: cid,
      name: `${company.name} - ${r.pick(DEAL_PRODUCTS)}`,
      amount,
      stage,
      closeDate: isoDate(ANCHOR + offset * DAY),
      ownerContactId: r.pick(contactsOf(cid)).id,
    });
  }
  const dealNames = new Set<string>();
  for (const d of deals) {
    let name = d.name;
    for (let n = 2; dealNames.has(name); n++) name = `${d.name} ${n}`;
    dealNames.add(name);
    d.name = name;
  }

  // Activities: 2-8 per account, oldest first within an account.
  const activities: Activity[] = [];
  for (const company of companies) {
    const count = r.int(2, 8);
    const rows: Omit<Activity, "id">[] = [];
    for (let i = 0; i < count; i++) {
      const type = r.pick(["note", "task", "meeting"] as const);
      const at = ANCHOR - r.int(1, 180) * DAY + (9 + r.int(0, 8)) * HOUR + r.int(0, 3) * 900_000;
      const contact = r.next() < 0.8 ? r.pick(contactsOf(company.id)) : undefined;
      const subject = r.pick(
        type === "note" ? NOTE_SUBJECTS : type === "task" ? TASK_SUBJECTS : MEETING_SUBJECTS,
      );
      const body = r.pick(
        type === "note" ? NOTE_BODIES : type === "task" ? TASK_BODIES : MEETING_BODIES,
      );
      const row: Omit<Activity, "id"> = {
        companyId: company.id,
        ...(contact ? { contactId: contact.id } : {}),
        type,
        subject,
        body,
        at: isoDateTime(at),
      };
      if (type === "task") {
        const dueAt = at + r.int(3, 30) * DAY;
        row.dueAt = isoDateTime(dueAt);
        row.status = dueAt < ANCHOR && r.next() < 0.7 ? "completed" : "open";
      }
      rows.push(row);
    }
    rows.sort((a, b) => a.at.localeCompare(b.at));
    for (const row of rows) activities.push({ id: `act_${pad(activities.length + 1, 4)}`, ...row });
  }

  // Confusable groups, with ids resolved and ordered by first member id.
  const confusables: ConfusableGroup[] = [];
  COMPANY_GROUPS.forEach((group) => {
    confusables.push({
      id: "",
      kind: "company",
      confusion: group.confusion,
      memberIds: group.members.map((m) => companyId(m.name)),
    });
  });
  for (const group of contactGroups) {
    confusables.push({
      id: "",
      kind: "contact",
      confusion: group.confusion,
      memberIds: group.names.map((n) => idByName.get(n) as string),
    });
  }
  confusables.forEach((g, i) => {
    g.id = `cg_${pad(i + 1, 2)}`;
  });

  return { companies, contacts, deals, activities, confusables };
}

export const DATASET_FILES = [
  "companies",
  "contacts",
  "deals",
  "activities",
  "confusables",
] as const satisfies readonly (keyof CrmDataset)[];

export function serialize(rows: unknown): string {
  return `${JSON.stringify(rows, null, 2)}\n`;
}
