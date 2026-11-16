import type { EntityRef } from "@earshot/core";
import { toEntityRows } from "@earshot/demo-crm";
import { describe, expect, it } from "vitest";
import { matchEntity } from "../src/entities";

// The demo CRM's 250 records, as POST /api/sessions would hand them to a session.
const entities: EntityRef[] = toEntityRows().map((row) => ({
  id: row.externalId,
  kind: row.kind,
  name: row.name,
  aliases: row.aliases,
}));
const ANY = ["company", "contact", "deal"] as const;

describe("matchEntity", () => {
  it("matches a name exactly, ignoring case and spacing", () => {
    expect(matchEntity("Acme Dynamics", entities, ANY)?.id).toBe("co_011");
    expect(matchEntity("  acme   DYNAMICS ", entities, ANY)?.id).toBe("co_011");
    expect(matchEntity("Dana Lee", entities, ["contact"])?.id).toBe("ct_045");
  });

  it("matches an alias that only one record has", () => {
    expect(matchEntity("Acme", entities, ANY)?.id).toBe("co_011");
    expect(matchEntity("akme", entities, ANY)?.id).toBe("co_044");
  });

  it("matches nothing for a near miss: the confusable names stay apart", () => {
    expect(matchEntity("Dana Leigh", entities, ANY)).toBeNull();
    expect(matchEntity("Atmas Industrial", entities, ANY)).toBeNull();
    expect(matchEntity("Dana", entities, ANY)).toBeNull();
  });

  it("refuses an ambiguous alias: three companies answer to Northwind, two to MSC", () => {
    expect(matchEntity("Northwind", entities, ANY)).toBeNull();
    expect(matchEntity("MSC", entities, ANY)).toBeNull();
    expect(matchEntity("Northwind Labs", entities, ANY)?.name).toBe("Northwind Labs");
  });

  it("only matches the kinds the proposal type allows", () => {
    expect(matchEntity("Acme Dynamics", entities, ["deal"])).toBeNull();
    expect(matchEntity("Acme Dynamics - Expansion", entities, ["deal"])?.id).toBe("deal_028");
  });

  it("returns null for no name", () => {
    expect(matchEntity(null, entities, ANY)).toBeNull();
    expect(matchEntity("   ", entities, ANY)).toBeNull();
  });
});
