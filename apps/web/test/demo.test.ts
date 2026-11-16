import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDemo, clock } from "@/lib/demo";
import { findInRepo } from "@/lib/repo-path";

const log = readFileSync(findInRepo("packages/events/fixtures/demo-session.jsonl"), "utf8");

describe("the replay demo", () => {
  it("replays the fixture into its transcript and proposals", () => {
    const demo = buildDemo(log);
    expect(demo.session).toMatchObject({ status: "ended", mode: "debrief", engine: "cascaded" });
    expect(demo.utterances).toHaveLength(7);
    expect(demo.utterances[0]).toMatchObject({ at: "0:01", witness: "biased" });
    expect(demo.proposals.map((p) => [p.type, p.status])).toEqual([
      ["contact", "approved"],
      ["deal_update", "approved"],
      ["task", "edited"],
      ["note", "approved"],
      ["commitment", "rejected"],
    ]);
    expect(demo.events).toHaveLength(19);
  });

  it("links every field to the words it came from", () => {
    const demo = buildDemo(log);
    const contact = demo.proposals[0];
    expect(contact?.fields.find((f) => f.name === "company")?.evidence).toMatchObject({
      quote: "Acme Corp",
      at: "0:03.4",
    });
    expect(contact?.fields.find((f) => f.name === "name")?.evidence?.quote).toBe("Dana Lee");
    for (const proposal of demo.proposals) {
      for (const field of proposal.fields) {
        expect(field.evidence, `${proposal.type}.${field.name}`).not.toBeNull();
      }
    }
    const task = demo.proposals[2];
    expect(task?.fields.find((f) => f.name === "title")).toMatchObject({
      value: "Send Dana the pricing breakdown",
      editedTo: "Send Dana the pricing breakdown for the security add-on",
    });
  });

  it("is deterministic", () => {
    expect(buildDemo(log)).toEqual(buildDemo(log));
  });

  it("formats offsets as m:ss", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(61_500)).toBe("1:01");
    expect(clock(3_400, true)).toBe("0:03.4");
  });
});
