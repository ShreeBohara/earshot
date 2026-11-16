import {
  MAX_MESSAGE_BYTES,
  MAX_SESSION_ENTITIES,
  parseClientMessage,
  type SessionProviders,
  uuidv7,
} from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  START_SLACK_BYTES,
  sessionEntities,
  startEntityBudget,
  toEntityRef,
  utf8Length,
} from "@/lib/voice/entities";
import {
  type CrmEntity,
  estimateKeytermTokens,
  KEYTERM_LIMITS,
  rankEntities,
  sessionKeyterms,
} from "@/lib/voice/keyterms";

let counter = 0;
const day = (n: number) => new Date(Date.UTC(2026, 10, n));

function row(overrides: Partial<CrmEntity> & Pick<CrmEntity, "kind" | "name">): CrmEntity {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`,
    aliases: [],
    connectionId: null,
    sourceId: `src_${counter}`,
    companyId: null,
    updatedAt: day(1),
    ...overrides,
  };
}

const PROVIDERS: SessionProviders = {
  speechToText: { provider: "deepgram", model: "nova-3" },
  llm: { provider: "groq", model: "openai/gpt-oss-20b" },
};

describe("rankEntities", () => {
  const acme = row({ kind: "company", name: "Acme Corp", sourceId: "co_acme", aliases: ["Acme"] });
  const globex = row({ kind: "company", name: "Globex", updatedAt: day(9) });
  const initech = row({ kind: "company", name: "Initech", updatedAt: day(5) });
  const dana = row({ kind: "contact", name: "Dana Lee", companyId: "co_acme" });
  const omar = row({
    kind: "contact",
    name: "Omar Haddad",
    companyId: "co_acme",
    updatedAt: day(7),
  });
  const priya = row({
    kind: "contact",
    name: "Priya Shah",
    companyId: "co_globex",
    updatedAt: day(8),
  });
  const renewal = row({ kind: "deal", name: "Acme renewal", companyId: "co_acme" });
  const expansion = row({ kind: "deal", name: "Globex expansion", companyId: "co_globex" });
  // Same `companyId`, but from a CRM connection, so it isn't the demo account's.
  const elsewhere = row({
    kind: "contact",
    name: "Sam Ortiz",
    companyId: "co_acme",
    connectionId: "6f1d2c3b-4a5e-4f60-8a7b-000000000001",
  });
  const rows = [renewal, priya, globex, dana, elsewhere, initech, expansion, acme, omar];

  it("puts the selected account, its contacts, and its deals first, then the other companies by recency", () => {
    const ranked = rankEntities(rows, acme.id);
    expect(ranked.keytermSources.map((r) => r.name)).toEqual([
      "Acme Corp",
      "Omar Haddad", // updated more recently than Dana
      "Dana Lee",
      "Acme renewal",
      "Globex",
      "Initech",
    ]);
    expect(ranked.all.map((r) => r.name)).toEqual([
      ...ranked.keytermSources.map((r) => r.name),
      "Priya Shah",
      "Sam Ortiz",
      "Globex expansion",
    ]);
  });

  it("ranks companies alone, by recency, when no account is selected or the selection is stale", () => {
    for (const selected of [undefined, null, uuidv7(), dana.id]) {
      const ranked = rankEntities(rows, selected);
      expect(ranked.keytermSources.map((r) => r.name)).toEqual(["Globex", "Initech", "Acme Corp"]);
      expect(ranked.all).toHaveLength(rows.length);
    }
  });

  it("breaks ties by name, then id, and counts a row once", () => {
    const a = row({ kind: "company", name: "Same" });
    const b = row({ kind: "company", name: "Same" });
    const c = row({ kind: "company", name: "Alpha" });
    const ranked = rankEntities([b, a, c, a]);
    expect(ranked.all.map((r) => r.id)).toEqual([c.id, a.id, b.id]);
  });
});

describe("sessionKeyterms", () => {
  it("takes each source's name, then its aliases, deduplicated ignoring case", () => {
    const keyterms = sessionKeyterms([
      { name: "Acme Corp", aliases: ["Acme", "ACME CORP", " acme "] },
      { name: "  Dana   Lee ", aliases: [] },
      { name: "acme", aliases: ["Akme"] },
    ]);
    expect(keyterms).toEqual({
      assemblyai: ["Acme Corp", "Acme", "Dana Lee", "Akme"],
      deepgram: ["Acme Corp", "Acme", "Dana Lee", "Akme"],
    });
  });

  it("drops what can't be a keyterm: one character, control characters, anything shaped like a key", () => {
    const keyterms = sessionKeyterms([
      { name: "X", aliases: ["Bell\u0007Labs", `gsk_${"a".repeat(30)}`, "Ok"] },
    ]);
    expect(keyterms.assemblyai).toEqual(["Ok"]);
    expect(keyterms.deepgram).toEqual(["Ok"]);
  });

  it("normalizes to NFC, so composed and decomposed spellings are one term", () => {
    const keyterms = sessionKeyterms([{ name: "Zoë Brandt", aliases: ["Zoë Brandt"] }]);
    expect(keyterms.assemblyai).toEqual(["Zoë Brandt"]);
  });

  it("gives AssemblyAI at most 100 terms of at most 50 characters, skipping longer ones", () => {
    const sources = Array.from({ length: 150 }, (_, n) => ({
      name: n % 10 === 0 ? `Company ${n} ${"x".repeat(50)}` : `Company ${n}`,
      aliases: [],
    }));
    const { assemblyai } = sessionKeyterms(sources);
    expect(assemblyai).toHaveLength(KEYTERM_LIMITS.assemblyai.maxTerms);
    expect(assemblyai.every((term) => term.length <= 50)).toBe(true);
    expect(assemblyai.slice(0, 3)).toEqual(["Company 1", "Company 2", "Company 3"]);
  });

  it("gives Deepgram at most 50 terms within its token budget, and lets smaller terms fill in", () => {
    // 49 characters each: 26 estimated tokens, so 19 fit in 500, with 6 tokens to spare.
    const long = Array.from({ length: 30 }, (_, n) => ({
      name: `${String(n).padStart(2, "0")} ${"y".repeat(46)}`,
      aliases: [],
    }));
    const short = { name: "Ana", aliases: ["Bo"] };
    const { deepgram } = sessionKeyterms([...long, short]);
    expect(deepgram).toHaveLength(21);
    expect(deepgram.slice(-2)).toEqual(["Ana", "Bo"]);
    const tokens = deepgram.reduce((sum, term) => sum + estimateKeytermTokens(term), 0);
    expect(tokens).toBeLessThanOrEqual(KEYTERM_LIMITS.deepgram.maxTokens);

    const many = Array.from({ length: 80 }, (_, n) => ({ name: `T${n}`, aliases: [] }));
    expect(sessionKeyterms(many).deepgram).toHaveLength(KEYTERM_LIMITS.deepgram.maxTerms);
  });

  it("estimates Deepgram tokens conservatively: a token per two bytes, plus one", () => {
    expect(estimateKeytermTokens("Acme")).toBe(3);
    expect(estimateKeytermTokens("Okafor")).toBe(4);
    expect(estimateKeytermTokens("Zoë")).toBe(3); // 4 bytes of UTF-8
    expect(estimateKeytermTokens("東京")).toBe(4); // 6 bytes
  });
});

describe("sessionEntities", () => {
  it("leaves room in `start` for everything but the entities, plus some slack", () => {
    const envelope = JSON.stringify({
      t: "start",
      msgId: uuidv7(),
      mode: "debrief",
      engine: "cascaded",
      providers: PROVIDERS,
      startedAt: "2026-11-15T19:15:00.000Z",
      entities: [],
    });
    expect(startEntityBudget(PROVIDERS)).toBe(
      MAX_MESSAGE_BYTES - utf8Length(envelope) - START_SLACK_BYTES,
    );
  });

  it("stops at 250 entities when they're small", () => {
    const rows = Array.from({ length: 400 }, (_, n) => row({ kind: "contact", name: `P ${n}` }));
    const entities = sessionEntities(rows, startEntityBudget(PROVIDERS));
    expect(entities).toHaveLength(MAX_SESSION_ENTITIES);
    expect(entities.map((e) => e.name)).toEqual(rows.slice(0, 250).map((r) => r.name));
  });

  it("stops at the byte budget when they're large, and skips one that doesn't fit for smaller ones after it", () => {
    const big = (n: number) =>
      row({
        kind: "company",
        name: `Big ${n} ${"b".repeat(190)}`,
        aliases: Array.from({ length: 20 }, (_, a) => `Alias ${a} ${"a".repeat(185)}`),
      });
    const rows = [
      ...Array.from({ length: 40 }, (_, n) => big(n)),
      row({ kind: "deal", name: "Small" }),
    ];
    const budget = startEntityBudget(PROVIDERS);
    const entities = sessionEntities(rows, budget);
    expect(entities.length).toBeLessThan(40);
    expect(entities.at(-1)?.name).toBe("Small");
    const bytes = utf8Length(JSON.stringify(entities)) - 2; // the items and commas, without []
    expect(bytes).toBeLessThanOrEqual(budget);

    const frame = JSON.stringify({
      t: "start",
      msgId: uuidv7(),
      mode: "debrief",
      engine: "cascaded",
      providers: PROVIDERS,
      startedAt: "2026-11-15T19:15:00.000+05:30",
      entities,
    });
    expect(utf8Length(frame)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(parseClientMessage(frame)).toMatchObject({ ok: true });
  });

  it("counts bytes, not characters: names in other scripts take up to three bytes a character", () => {
    const rows = Array.from({ length: 250 }, (_, n) =>
      row({ kind: "contact", name: `${"東".repeat(150)}${n}`, aliases: ["京".repeat(150)] }),
    );
    const entities = sessionEntities(rows, startEntityBudget(PROVIDERS));
    const frame = JSON.stringify({
      t: "start",
      msgId: uuidv7(),
      mode: "debrief",
      engine: "cascaded",
      providers: PROVIDERS,
      startedAt: "2026-11-15T19:15:00.000Z",
      entities,
    });
    expect(entities.length).toBeLessThan(250);
    expect(utf8Length(frame)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(parseClientMessage(frame)).toMatchObject({ ok: true });
  });
});

describe("toEntityRef", () => {
  it("trims, caps aliases at 20 distinct ones, and keeps only what the socket accepts", () => {
    const ref = toEntityRef({
      id: "6f1d2c3b-4a5e-4f60-8a7b-000000000009",
      kind: "company",
      name: "  Acme Corp ",
      aliases: [
        "Acme",
        "acme",
        "ACME CORP",
        "",
        "   ",
        "z".repeat(201),
        `AIza${"0".repeat(35)}`,
        ...Array.from({ length: 30 }, (_, n) => `Alias ${n}`),
      ],
    });
    expect(ref?.name).toBe("Acme Corp");
    expect(ref?.aliases).toEqual(["Acme", ...Array.from({ length: 19 }, (_, n) => `Alias ${n}`)]);
  });

  it("drops a record whose name or id can't be sent", () => {
    const base = { id: "6f1d2c3b-4a5e-4f60-8a7b-000000000010", kind: "deal" as const, aliases: [] };
    expect(toEntityRef({ ...base, name: "   " })).toBeUndefined();
    expect(toEntityRef({ ...base, name: "n".repeat(201) })).toBeUndefined();
    expect(toEntityRef({ ...base, name: `sk-ant-api03-${"x".repeat(30)}` })).toBeUndefined();
    expect(toEntityRef({ ...base, id: "i".repeat(129), name: "Fine" })).toBeUndefined();
    // A company name that merely contains `sk-` is fine, as the protocol agrees.
    expect(toEntityRef({ ...base, name: "Risk-Management-Partners-International" })).toBeDefined();
  });
});
