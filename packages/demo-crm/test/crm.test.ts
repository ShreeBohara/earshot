import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDataset, DATASET_FILES, serialize } from "../scripts/build";
import { DATA_DIR } from "../scripts/paths";
import { activities, companies, confusables, contacts, deals, toEntityRows } from "../src";

const unique = (values: string[]) => new Set(values).size === values.length;

describe("counts", () => {
  it("has about 60 companies", () => expect(companies.length).toBeGreaterThanOrEqual(55));
  it("has at most 65 companies", () => expect(companies.length).toBeLessThanOrEqual(65));
  it("has about 150 contacts", () => {
    expect(contacts.length).toBeGreaterThanOrEqual(140);
    expect(contacts.length).toBeLessThanOrEqual(160);
  });
  it("has about 40 deals", () => {
    expect(deals.length).toBeGreaterThanOrEqual(35);
    expect(deals.length).toBeLessThanOrEqual(45);
  });
  it("gives every company 2-8 activities", () => {
    for (const company of companies) {
      const n = activities.filter((a) => a.companyId === company.id).length;
      expect(n, company.name).toBeGreaterThanOrEqual(2);
      expect(n, company.name).toBeLessThanOrEqual(8);
    }
  });
});

describe("uniqueness", () => {
  it("has unique ids within each dataset", () => {
    for (const rows of [companies, contacts, deals, activities, confusables]) {
      expect(unique(rows.map((r) => r.id))).toBe(true);
    }
  });
  it("has unique company names and domains", () => {
    expect(unique(companies.map((c) => c.name))).toBe(true);
    expect(unique(companies.map((c) => c.domain))).toBe(true);
  });
  it("has unique contact names and emails", () => {
    expect(unique(contacts.map((c) => `${c.firstName} ${c.lastName}`))).toBe(true);
    expect(unique(contacts.map((c) => c.email))).toBe(true);
  });
  it("has unique deal names", () => expect(unique(deals.map((d) => d.name))).toBe(true));
});

describe("referential integrity", () => {
  const companyIds = new Set(companies.map((c) => c.id));
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  it("points contacts at real companies", () => {
    for (const c of contacts) expect(companyIds.has(c.companyId), c.id).toBe(true);
  });
  it("gives every company at least one contact", () => {
    const withContacts = new Set(contacts.map((c) => c.companyId));
    for (const c of companies) expect(withContacts.has(c.id), c.name).toBe(true);
  });
  it("points deals at a real company and one of its contacts", () => {
    for (const d of deals) {
      expect(companyIds.has(d.companyId), d.id).toBe(true);
      expect(contactById.get(d.ownerContactId)?.companyId, d.id).toBe(d.companyId);
    }
  });
  it("points activities at a real company and, when set, one of its contacts", () => {
    for (const a of activities) {
      expect(companyIds.has(a.companyId), a.id).toBe(true);
      if (a.contactId) expect(contactById.get(a.contactId)?.companyId, a.id).toBe(a.companyId);
    }
  });
  it("sets dueAt and status on tasks only", () => {
    for (const a of activities) {
      expect(a.dueAt !== undefined, a.id).toBe(a.type === "task");
      expect(a.status !== undefined, a.id).toBe(a.type === "task");
    }
  });
});

describe("emails and phones", () => {
  it("puts every email on the company's .example domain", () => {
    const domainById = new Map(companies.map((c) => [c.id, c.domain]));
    for (const c of contacts) {
      expect(c.email.endsWith(".example")).toBe(true);
      expect(c.email.split("@")[1], c.id).toBe(domainById.get(c.companyId));
    }
  });
  it("keeps every phone in the fictional 555-01xx range", () => {
    for (const c of contacts) expect(c.phone).toMatch(/^555-01\d{2}$/);
  });
});

describe("confusable groups", () => {
  const byKind = (kind: "company" | "contact") => confusables.filter((g) => g.kind === kind);
  const ids = {
    company: new Set(companies.map((c) => c.id)),
    contact: new Set(contacts.map((c) => c.id)),
  };

  it("has at least 15 groups", () => expect(confusables.length).toBeGreaterThanOrEqual(15));
  it("has at least 15 company groups", () =>
    expect(byKind("company").length).toBeGreaterThanOrEqual(15));
  it("covers every confusion type", () => {
    expect(new Set(confusables.map((g) => g.confusion))).toEqual(
      new Set(["spelling", "phonetic", "shared-stem", "abbreviation"]),
    );
  });
  it("has 2+ distinct, existing members per group", () => {
    for (const g of confusables) {
      expect(g.memberIds.length, g.id).toBeGreaterThanOrEqual(2);
      expect(new Set(g.memberIds).size, g.id).toBe(g.memberIds.length);
      for (const id of g.memberIds) expect(ids[g.kind].has(id), `${g.id}:${id}`).toBe(true);
    }
  });
  it("includes the documented examples", () => {
    const names = (kind: "company" | "contact") =>
      byKind(kind).map((g) =>
        g.memberIds.map((id) => {
          const c = companies.find((x) => x.id === id);
          const p = contacts.find((x) => x.id === id);
          return c ? c.name : `${p?.firstName} ${p?.lastName}`;
        }),
      );
    expect(names("company")).toContainEqual(
      expect.arrayContaining(["Acme Dynamics", "Akme Dynamics"]),
    );
    expect(names("contact")).toContainEqual(
      expect.arrayContaining(["Dana Lee", "Dana Li", "Donna Lee"]),
    );
  });
});

describe("entity rows", () => {
  const rows = toEntityRows();
  it("emits one row per company, contact, and deal, and none for activities", () => {
    expect(rows.length).toBe(companies.length + contacts.length + deals.length);
    expect(activities.length).toBeGreaterThan(0);
  });
  it("has unique (kind, externalId) keys", () => {
    expect(unique(rows.map((r) => `${r.kind}:${r.externalId}`))).toBe(true);
  });
  it("carries company aliases through", () => {
    const msc = rows.find((r) => r.name === "Meridian Supply Co");
    expect(msc?.aliases).toContain("MSC");
  });
});

describe("determinism", () => {
  const fresh = buildDataset();
  it.each(DATASET_FILES)("committed %s.json equals a fresh generator run", (name) => {
    const committed = readFileSync(join(DATA_DIR, `${name}.json`), "utf8");
    expect(committed).toBe(serialize(fresh[name]));
  });
  it("two runs are identical", () => {
    expect(buildDataset()).toEqual(fresh);
  });
});
