import {
  ClientMessage,
  MAX_ENTITY_ALIASES,
  MAX_ENTITY_NAME_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_SESSION_ENTITIES,
} from "@earshot/core";
import { companies, contacts, deals } from "@earshot/demo-crm";
import { describe, expect, it } from "vitest";
import {
  DEBRIEFS,
  DEMO_SESSION_ENTITIES,
  demoCompanyOf,
  demoEntity,
  sessionContext,
  turnTranscript,
} from "../src";

describe("DEMO_SESSION_ENTITIES", () => {
  it("holds the whole demo CRM once: companies, then contacts, then deals", () => {
    expect(DEMO_SESSION_ENTITIES).toHaveLength(companies.length + contacts.length + deals.length);
    expect(new Set(DEMO_SESSION_ENTITIES.map((entity) => entity.id)).size).toBe(
      DEMO_SESSION_ENTITIES.length,
    );
    const kinds = DEMO_SESSION_ENTITIES.map((entity) => entity.kind);
    expect(kinds.lastIndexOf("company")).toBeLessThan(kinds.indexOf("contact"));
    expect(kinds.lastIndexOf("contact")).toBeLessThan(kinds.indexOf("deal"));
  });

  it("orders each kind by name, as rankEntities does when every row was loaded at once", () => {
    for (const kind of ["company", "contact", "deal"] as const) {
      const names = DEMO_SESSION_ENTITIES.filter((entity) => entity.kind === kind).map(
        (entity) => entity.name,
      );
      expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      // Names are unique within a kind, so the order never falls back to database ids.
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("fits a start message, so the e2e session can carry it unchanged", () => {
    expect(DEMO_SESSION_ENTITIES.length).toBeLessThanOrEqual(MAX_SESSION_ENTITIES);
    for (const entity of DEMO_SESSION_ENTITIES) {
      expect(entity.name.length).toBeLessThanOrEqual(MAX_ENTITY_NAME_CHARS);
      expect(entity.aliases.length).toBeLessThanOrEqual(MAX_ENTITY_ALIASES);
    }
    const start = {
      t: "start",
      msgId: "01a1c6e2-9320-7deb-a57a-ba62dc02df02",
      mode: "debrief",
      engine: "cascaded",
      providers: {
        speechToText: { provider: "fake", model: "fake" },
        llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      },
      startedAt: "2026-11-17T22:20:00.000Z",
      entities: DEMO_SESSION_ENTITIES,
      timeZone: "America/Los_Angeles",
    };
    expect(new TextEncoder().encode(JSON.stringify(start)).byteLength).toBeLessThan(
      MAX_MESSAGE_BYTES,
    );
    expect(ClientMessage.safeParse(start).success).toBe(true);
  });

  it("keeps company aliases, shared ones included, and gives contacts and deals none", () => {
    expect(demoEntity("co_021").aliases).toEqual(["Northwind"]);
    expect(demoEntity("co_043").aliases).toEqual(["Meridian", "MSC"]);
    expect(demoEntity("ct_045")).toEqual({
      id: "ct_045",
      kind: "contact",
      name: "Dana Lee",
      aliases: [],
      parentId: "co_011",
    });
    expect(demoEntity("deal_028").name).toBe("Acme Dynamics - Expansion");
  });

  it("gives every contact and deal its company as parentId, as POST /api/sessions does", () => {
    for (const entity of DEMO_SESSION_ENTITIES) {
      if (entity.kind === "company") {
        expect(entity).not.toHaveProperty("parentId");
      } else {
        expect(entity.parentId, entity.id).toBe(demoCompanyOf(entity.id));
        expect(demoEntity(entity.parentId ?? "").kind).toBe("company");
      }
    }
  });
});

describe("demoEntity and demoCompanyOf", () => {
  it("look up demo records and the company behind them", () => {
    expect(demoCompanyOf("co_011")).toBe("co_011");
    expect(demoCompanyOf("ct_045")).toBe("co_011");
    expect(demoCompanyOf("deal_028")).toBe("co_011");
    expect(demoCompanyOf("co_999")).toBeUndefined();
    expect(() => demoEntity("co_999")).toThrow(RangeError);
  });
});

describe("sessionContext", () => {
  it("is the demo CRM plus the script's open account, call time, and zone", () => {
    for (const script of DEBRIEFS) {
      expect(sessionContext(script)).toEqual({
        entities: DEMO_SESSION_ENTITIES,
        focusEntityId: script.focusEntityId ?? null,
        callTime: script.callTime,
        timeZone: script.timeZone,
      });
    }
  });

  it("opens an account in most scripts, and leaves some sessions without one", () => {
    const open = DEBRIEFS.filter((script) => script.focusEntityId !== undefined);
    expect(open.length).toBeGreaterThan(20);
    expect(open.length).toBeLessThan(DEBRIEFS.length);
    for (const script of open) {
      expect(demoEntity(script.focusEntityId ?? "").kind, script.id).toBe("company");
    }
  });
});

describe("turnTranscript", () => {
  it("collapses whitespace the way the fake adapter's final does", () => {
    expect(turnTranscript({ text: "  Send   Dana\nthe quote. " })).toBe("Send Dana the quote.");
    for (const script of DEBRIEFS) {
      for (const turn of script.turns) expect(turnTranscript(turn)).toBe(turn.text);
    }
  });
});
