import { describe, expect, it } from "vitest";
import { z } from "zod";
import { contracts, EventEnvelope, eventPayloadContracts } from "../src";

describe("event payload contracts", () => {
  it.each(eventPayloadContracts)("$type v$schemaVersion is a registered contract", ({ schema }) => {
    expect(Object.values(contracts)).toContain(schema);
  });

  it.each(eventPayloadContracts)(
    "$type v$schemaVersion names its type and version in its JSON Schema",
    ({ type, schemaVersion, schema }) => {
      const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" });
      expect(json["x-event-type"]).toBe(type);
      expect(json["x-schema-version"]).toBe(schemaVersion);
      const name = Object.entries(contracts).find(([, contract]) => contract === schema)?.[0];
      expect(json.title).toBe(name);
    },
  );

  it("has one schema per (type, schemaVersion)", () => {
    const keys = eventPayloadContracts.map(({ type, schemaVersion }) => `${type}@${schemaVersion}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("uses event types the envelope accepts", () => {
    const type = EventEnvelope.shape.type;
    for (const contract of eventPayloadContracts) {
      expect(type.safeParse(contract.type).success).toBe(true);
    }
  });
});
