import { describe, expect, it } from "vitest";
import { z } from "zod";
import { contracts, EventEnvelope, ExternalRef, eventPayloadContracts } from "../src";

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

describe("a record's link in a sync event (a review fix)", () => {
  const ref = (url: string | null) => ({ object: "deal", id: "18837412", url });
  const hubspot = "https://app.hubspot.com/contacts/48211/record/0-3/";

  it.each([
    ["a HubSpot record", `${hubspot}18837412`],
    [
      "an Attio record, with a query and a fragment",
      "https://app.attio.com/acme/person/b5c8?tab=notes#n1",
    ],
    [
      "a self-hosted Twenty on localhost, over http",
      "http://localhost:3000/object/opportunity/7f1e",
    ],
    ["a link of exactly 2,048 characters", hubspot + "1".repeat(2048 - hubspot.length)],
  ])("takes %s", (_, url) => {
    expect(ExternalRef.safeParse(ref(url)).success).toBe(true);
    expect(ExternalRef.safeParse(ref(null)).success).toBe(true);
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["javascript: in capitals", "JavaScript:alert(document.cookie)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["ftp:", "ftp://files.example.com/deal.pdf"],
    ["a scheme-relative link", "//app.hubspot.com/record/1"],
    ["https in capitals", "HTTPS://app.hubspot.com/record/1"],
    ["credentials before the host", "https://admin:hunter2@app.hubspot.com/record/1"],
    ["no host", "https:///record/1"],
    ["nothing after the scheme", "https://"],
    ["a space", "https://app.hubspot.com/record/1 javascript:alert(1)"],
    ["a line break", "https://app.hubspot.com/record/1\njavascript:alert(1)"],
    ["a link of 2,049 characters", hubspot + "1".repeat(2049 - hubspot.length)],
  ])("refuses %s", (_, url) => {
    expect(ExternalRef.safeParse(ref(url)).success).toBe(false);
  });

  it("puts the rule in the JSON Schema the lab's Pydantic models are made from", () => {
    const json = z.toJSONSchema(ExternalRef, {
      target: "draft-2020-12",
      io: "output",
    }) as unknown as {
      properties: { url: { anyOf: Record<string, unknown>[] } };
    };
    const [link] = json.properties.url.anyOf;
    // A pattern and a length on a plain string: Pydantic drops both from a `format: uri` string.
    expect(link).toEqual({
      type: "string",
      maxLength: 2048,
      pattern: "^https?:\\/\\/[^\\s/?#@]+(?:[/?#]\\S*)?$",
    });
  });
});
