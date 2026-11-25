// A mapping as plans read it (Phase 6 spec §4.9): the rep's owner, and one made from a schema.
import { describe, expect, it } from "vitest";
import { type Capabilities, type CrmSchema, defaultMapping, ownerFor } from "../src";

const SCHEMA: CrmSchema = {
  stages: [
    { stageId: "s1", pipelineId: "p1", label: "Discovery" },
    { stageId: "s2", pipelineId: "p1", label: "Proposal" },
  ],
  owners: [
    { ownerId: "o1", email: "Rep@Example.com", name: "Rep One" },
    { ownerId: "o2", email: null, name: "No Email" },
  ],
  associations: [],
  properties: [],
};

const objects = (meeting: boolean, task = true): Pick<Capabilities, "objects"> => ({
  objects: { company: true, contact: true, deal: true, note: true, task, meeting },
});

describe("defaultMapping", () => {
  it("maps each stage by its label, new deals to the first's pipeline, and reps by email", () => {
    const mapping = defaultMapping(SCHEMA, objects(true), {
      reps: [
        { userId: "u1", email: "rep@example.com" },
        { userId: "u2", email: "nobody@example.com" },
        { userId: "u3", email: null },
      ],
      words: { s2: ["sent the proposal"] },
    });
    expect(mapping).toEqual({
      v: 1,
      stages: [
        { stageId: "s1", pipelineId: "p1", label: "Discovery", words: [] },
        { stageId: "s2", pipelineId: "p1", label: "Proposal", words: ["sent the proposal"] },
      ],
      newDeals: { pipelineId: "p1" },
      owners: [{ userId: "u1", ownerId: "o1" }],
      destinations: { commitment: "task", meeting: "meeting" },
    });
  });

  it("sends meetings and commitments to notes where the CRM can't hold them", () => {
    expect(defaultMapping(SCHEMA, objects(false, false)).destinations).toEqual({
      commitment: "note",
      meeting: "note",
    });
    expect(defaultMapping({ stages: [], owners: [] }, objects(true)).newDeals).toEqual({
      pipelineId: null,
    });
  });
});

describe("ownerFor", () => {
  it("names the rep's owner, or none", () => {
    const mapping = { owners: [{ userId: "u1", ownerId: "o1" }] };
    expect(ownerFor(mapping, "u1")).toBe("o1");
    expect(ownerFor(mapping, "u2")).toBeNull();
    expect(ownerFor(mapping, null)).toBeNull();
  });
});
