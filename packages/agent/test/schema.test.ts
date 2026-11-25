import { PROPOSAL_TYPE_FIELDS } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  describeIssues,
  MAX_PROPOSALS_PER_TURN,
  STRICT_UNSUPPORTED_KEYWORDS,
  SUBMIT_PROPOSALS_JSON_SCHEMA,
  submitProposalsInput,
} from "../src/schema";

type Node = { [key: string]: unknown };

/** Every object node of a JSON Schema, with its path. */
function* walk(node: unknown, path = "$"): Generator<[string, Node]> {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) yield* walk(item, `${path}[${index}]`);
  } else if (node !== null && typeof node === "object") {
    yield [path, node as Node];
    for (const [key, value] of Object.entries(node)) yield* walk(value, `${path}.${key}`);
  }
}

describe("the submit_proposals JSON Schema", () => {
  const nodes = [...walk(SUBMIT_PROPOSALS_JSON_SCHEMA)];

  it("uses no keyword Anthropic's strict tool use refuses", () => {
    const keywords = new Set(nodes.flatMap(([, node]) => Object.keys(node)));
    for (const keyword of STRICT_UNSUPPORTED_KEYWORDS) {
      expect(keywords.has(keyword), keyword).toBe(false);
    }
    expect(keywords.has("$schema")).toBe(false);
    expect(keywords.has("anyOf")).toBe(true);
  });

  it("meets Groq's strict rules: closed objects with every property required", () => {
    const objects = nodes.filter(([, node]) => node.type === "object");
    expect(objects.length).toBeGreaterThan(10);
    for (const [path, node] of objects) {
      expect(node.additionalProperties, path).toBe(false);
      const properties = Object.keys((node.properties ?? {}) as Node).sort();
      expect([...((node.required ?? []) as string[])].sort(), path).toEqual(properties);
    }
  });

  it("names each proposal type's fields as approval policies list them (@earshot/core)", () => {
    // A rule's `alwaysReview` may list only its type's fields (`checkPolicyRules`), so a field the
    // extractor adds or renames must reach PROPOSAL_TYPE_FIELDS too, or no policy could name it.
    const fieldsByType: Record<string, string[]> = {};
    for (const [, node] of nodes) {
      const properties = node.properties as Node | undefined;
      const type = (properties?.type as Node | undefined)?.const;
      const fields = (properties?.fields as Node | undefined)?.properties as Node | undefined;
      if (typeof type === "string" && fields) fieldsByType[type] = Object.keys(fields);
    }
    expect(fieldsByType).toEqual(
      Object.fromEntries(
        Object.entries(PROPOSAL_TYPE_FIELDS).map(([type, fields]) => [type, [...fields]]),
      ),
    );
  });

  it("makes optional fields a union with null", () => {
    const task = nodes.find(
      ([, node]) => (node.properties as Node | undefined)?.dueDate !== undefined,
    )?.[1];
    if (!task) throw new Error("no proposal type with a dueDate");
    const dueDate = (task.properties as Node).dueDate as Node;
    expect((dueDate.anyOf as Node[]).map((branch) => branch.type)).toEqual(["object", "null"]);
  });
});

const taskWith = (fields: Record<string, unknown>) => ({
  proposals: [
    {
      type: "task",
      target: null,
      fields: { title: { value: "Send it", quote: "send it" }, dueDate: null, ...fields },
    },
  ],
});

describe("submitProposalsInput", () => {
  it("accepts an empty list and a well-formed proposal", () => {
    expect(submitProposalsInput.safeParse({ proposals: [] }).success).toBe(true);
    expect(submitProposalsInput.safeParse(taskWith({})).success).toBe(true);
  });

  it("refuses a date that isn't a calendar date as YYYY-MM-DD, naming the path", () => {
    for (const value of ["Thursday", "2026-11-31", "11/12/2026"]) {
      const result = submitProposalsInput.safeParse(
        taskWith({ dueDate: { value, quote: "by Thursday" } }),
      );
      expect(result.success, value).toBe(false);
      if (!result.success) {
        expect(describeIssues(result.error)).toEqual([
          "proposals.0.fields.dueDate.value: expected a calendar date as YYYY-MM-DD",
        ]);
      }
    }
  });

  it("refuses a negative or non-finite amount, and too many proposals", () => {
    const amount = (value: number) => ({
      proposals: [
        {
          type: "deal_update",
          target: null,
          fields: { stage: null, amount: { value, quote: "x" }, closeDate: null },
        },
      ],
    });
    expect(submitProposalsInput.safeParse(amount(-5)).success).toBe(false);
    expect(submitProposalsInput.safeParse(amount(12000)).success).toBe(true);
    const many = {
      proposals: Array.from(
        { length: MAX_PROPOSALS_PER_TURN + 1 },
        () => taskWith({}).proposals[0],
      ),
    };
    expect(submitProposalsInput.safeParse(many).success).toBe(false);
  });

  it("refuses unknown types, extra keys, and missing quotes, as structure", () => {
    expect(
      submitProposalsInput.safeParse({ proposals: [{ type: "lunch", target: null, fields: {} }] })
        .success,
    ).toBe(false);
    expect(submitProposalsInput.safeParse({ proposals: [], note: "hi" }).success).toBe(false);
    const missing = submitProposalsInput.safeParse(taskWith({ title: { value: "Send it" } }));
    expect(missing.success).toBe(false);
    if (!missing.success)
      expect(describeIssues(missing.error)[0]).toMatch(/^proposals\.0\.fields\.title\.quote: /);
  });

  it("takes a target as the words that named a record, with a kind and an optional company", () => {
    const target = (value: unknown) =>
      submitProposalsInput.safeParse({
        proposals: [{ ...taskWith({}).proposals[0], target: value }],
      });
    expect(target({ quote: "Dana Lee", kind: "contact", company: { quote: "Acme" } }).success).toBe(
      true,
    );
    expect(target({ quote: "Acme", kind: "company", company: null }).success).toBe(true);
    // v1's bare name, an unknown kind, and a missing company are all refused.
    expect(target("Acme Corp").success).toBe(false);
    expect(target({ quote: "Acme", kind: "account", company: null }).success).toBe(false);
    expect(target({ quote: "Acme", kind: "company" }).success).toBe(false);
    const long = target({ quote: "x".repeat(201), kind: "company", company: null });
    expect(long.success).toBe(false);
    if (!long.success) {
      expect(describeIssues(long.error)).toEqual(["proposals.0.target.quote: quote is too long"]);
    }
  });

  it("gives a contact no target: its record is the person it names", () => {
    const contact = {
      type: "contact",
      fields: {
        name: { value: "Dana Lee", quote: "Dana Lee" },
        title: null,
        company: null,
        email: null,
        phone: null,
      },
    };
    expect(submitProposalsInput.safeParse({ proposals: [contact] }).success).toBe(true);
    expect(
      submitProposalsInput.safeParse({ proposals: [{ ...contact, target: null }] }).success,
    ).toBe(false);
  });

  it("takes a meeting, with its date as YYYY-MM-DD and its time as HH:MM", () => {
    const meeting = (time: unknown) => ({
      proposals: [
        {
          type: "meeting",
          target: null,
          fields: {
            title: { value: "Kickoff", quote: "kickoff" },
            date: { value: "2026-12-07", quote: "December 7th" },
            time,
            attendees: null,
          },
        },
      ],
    });
    expect(submitProposalsInput.safeParse(meeting(null)).success).toBe(true);
    expect(
      submitProposalsInput.safeParse(meeting({ value: "15:00", quote: "at 3pm" })).success,
    ).toBe(true);
    for (const value of ["3pm", "24:00", "9:30", "15:00:00"]) {
      const result = submitProposalsInput.safeParse(meeting({ value, quote: "at 3pm" }));
      expect(result.success, value).toBe(false);
      if (!result.success) {
        expect(describeIssues(result.error)).toEqual([
          "proposals.0.fields.time.value: expected a time as HH:MM on a 24-hour clock",
        ]);
      }
    }
  });

  it("lists at most ten problems, and says how many more there were", () => {
    const bad = {
      proposals: Array.from(
        { length: 12 },
        () => taskWith({ dueDate: { value: "soon", quote: "soon" } }).proposals[0],
      ),
    };
    const result = submitProposalsInput.safeParse(bad);
    if (result.success) throw new Error("expected failure");
    const lines = describeIssues(result.error);
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toBe("and 2 more problems");
  });
});
