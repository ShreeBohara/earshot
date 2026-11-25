// The one tool the model calls each turn, `submit_proposals`, and how its input is validated.
//
// Tool schema v2 (Phase 4 spec, WP8 step 1). The model no longer sees the CRM list, so it can't
// name a record by id or copy a name from a list. Instead each proposal's `target` holds the words
// that named the record, exactly as transcribed, what kind of record they name, and the company
// said in the same breath; the entity linker in SessionDO resolves them (`understand`, ADR-0027).
// A contact proposal has no `target`: its record is the person in its `name` field, with its
// `company` field as context (spec §4.3). v2 adds the `meeting` type.
//
// The JSON Schema sent to both providers is generated from the Zod schema below and has to pass
// two sets of rules (Phase 3 spec, WP5 step 4):
// - Anthropic's strict tool use, which rejects numeric, string-length, pattern, and array-size
//   keywords and takes `anyOf` but not `oneOf`;
// - Groq's strict rules, so the same schema could move to strict mode later: every property
//   required, `additionalProperties: false`, and optional fields as a union with `null`.
// So the wire schema carries types, literals, enums, and nullability only. Everything else (date
// and time formats, lengths, limits) is checked by `submitProposalsInput`'s refinement, which runs
// on every attempt and drives the retry.
import { z } from "zod";

/** The tool's name, as the prompt and the forced tool choice spell it. */
export const SUBMIT_PROPOSALS = "submit_proposals";

/** The most proposals one turn may draft (target). More fails validation. */
export const MAX_PROPOSALS_PER_TURN = 20;
/** The longest field value or quote, in UTF-16 code units: one utterance's cap on the socket. */
export const MAX_FIELD_CHARS = 4_000;
/** The longest quote that names a record, or its company: the socket's cap on an entity name. */
export const MAX_TARGET_CHARS = 200;

const QUOTE_DESCRIPTION =
  "The exact words from the transcript that the value comes from, copied from one line character for character.";

function quoted<V extends z.ZodString | z.ZodNumber>(value: V, description: string) {
  return z.strictObject({
    value: value.describe(description),
    quote: z.string().describe(QUOTE_DESCRIPTION),
  });
}

const text = (description: string) => quoted(z.string(), description);
const date = (description: string) => quoted(z.string(), `${description} As YYYY-MM-DD.`);
const time = (description: string) =>
  quoted(z.string(), `${description} As HH:MM on a 24-hour clock.`);
const usd = (description: string) => quoted(z.number(), `${description} In US dollars.`);

/** The record kinds a target can name: `@earshot/core`'s `EntityKind`. */
const TargetKind = z.enum(["company", "contact", "deal"]);

/** A target: the words that named a record, as transcribed, never corrected. */
const Target = z
  .strictObject({
    quote: z
      .string()
      .describe(
        "The exact words of the transcript that named the record, copied character for character. Never correct a spelling.",
      ),
    kind: TargetKind.describe(
      "What those words name: a company, a contact (a person), or a deal (an opportunity).",
    ),
    company: z
      .strictObject({
        quote: z
          .string()
          .describe("The company's name as the transcript has it, character for character."),
      })
      .nullable()
      .describe(
        "The company said with a contact or a deal, even inside the deal's name (“Dana Lee at Acme”, “the Acme renewal”), or null.",
      ),
  })
  .nullable()
  .describe(
    "The CRM record the change belongs to, as the rep named it in this turn, or null if they didn't name one.",
  );

const Contact = z
  .strictObject({
    type: z.literal("contact"),
    fields: z.strictObject({
      name: text("The person's full name, as said."),
      title: text("Their job title.").nullable(),
      company: text("Their company, as said.").nullable(),
      email: text("Their email address.").nullable(),
      phone: text("Their phone number.").nullable(),
    }),
  })
  .describe("A new person, or new details about a person; the record is the person named.");

const Task = z
  .strictObject({
    type: z.literal("task"),
    target: Target,
    fields: z.strictObject({
      title: text("What the rep has to do, as a short imperative."),
      dueDate: date("When it's due.").nullable(),
    }),
  })
  .describe("Something the rep has to do.");

const Note = z
  .strictObject({
    type: z.literal("note"),
    target: Target,
    fields: z.strictObject({
      body: text("What to record, in a sentence or two."),
    }),
  })
  .describe("Something worth recording: what was discussed, a concern, how a deal stands.");

const DealUpdate = z
  .strictObject({
    type: z.literal("deal_update"),
    target: Target,
    fields: z.strictObject({
      stage: text("The stage the deal moves to, as the rep named it.").nullable(),
      amount: usd("The deal's new amount.").nullable(),
      closeDate: date("The deal's new close date.").nullable(),
    }),
  })
  .describe("A change to a deal: its stage, amount, or close date.");

const Commitment = z
  .strictObject({
    type: z.literal("commitment"),
    target: Target,
    fields: z.strictObject({
      text: text("The promise, as a short sentence."),
      counterpart: text("Who it was made to, or who made it, as said.").nullable(),
      dueDate: date("When it's due.").nullable(),
    }),
  })
  .describe("A promise the rep or the customer made.");

const Meeting = z
  .strictObject({
    type: z.literal("meeting"),
    target: Target,
    fields: z.strictObject({
      title: text("What the meeting is, in a few words."),
      date: date("The day it's on.").nullable(),
      time: time("When it starts.").nullable(),
      attendees: text("Who will be there, as said.").nullable(),
    }),
  })
  .describe("A meeting the rep set up or agreed to.");

/** One proposal as the model drafts it: a type, the words that named its record, quoted fields. */
const ToolProposalSchema = z.discriminatedUnion("type", [
  Note,
  Task,
  Contact,
  DealUpdate,
  Commitment,
  Meeting,
]);
export type ToolProposal = z.infer<typeof ToolProposalSchema>;

/** A target as the model drafts it: the quote, the kind, and the company said with it. */
export type ToolTarget = NonNullable<z.infer<typeof Target>>;

/** A field as the model drafts it: the value, and the words it came from. */
export type ToolField = { value: string | number; quote: string };

const SubmitProposalsWire = z.strictObject({
  proposals: z
    .array(ToolProposalSchema)
    .describe("Every change this turn supports, in the order the rep said them. Empty if none."),
});
export type SubmitProposalsInput = z.infer<typeof SubmitProposalsWire>;

/** Fields whose value is a calendar date, `YYYY-MM-DD`. */
export const DATE_FIELDS: ReadonlySet<string> = new Set(["dueDate", "closeDate", "date"]);
/** Fields whose value is a time of day, `HH:MM` on a 24-hour clock. */
export const TIME_FIELDS: ReadonlySet<string> = new Set(["time"]);

/** The record kinds each proposal type can target (./link-context.ts, which the web app imports). */
export { TARGET_KINDS } from "./link-context";

/** A proposal's target, or null: contact proposals have none (their record is the `name`). */
export function toolTarget(proposal: ToolProposal): ToolTarget | null {
  return "target" in proposal ? proposal.target : null;
}

const IsoDate = z.iso.date();
/** `HH:MM`, 00:00 to 23:59. Anchored at both ends, so it runs in linear time. */
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * The tool's input with every check: the wire schema's structure, plus the rules that its JSON
 * Schema can't carry. Issues name the path and the problem, never the value, because they go
 * back to the model in the retry.
 */
export const submitProposalsInput = SubmitProposalsWire.superRefine((input, ctx) => {
  if (input.proposals.length > MAX_PROPOSALS_PER_TURN) {
    ctx.addIssue({
      code: "custom",
      path: ["proposals"],
      message: `at most ${MAX_PROPOSALS_PER_TURN} proposals per turn`,
    });
  }
  input.proposals.forEach((proposal, index) => {
    const at = ["proposals", index];
    const target = toolTarget(proposal);
    if (target !== null) {
      if (target.quote.length > MAX_TARGET_CHARS) {
        ctx.addIssue({
          code: "custom",
          path: [...at, "target", "quote"],
          message: "quote is too long",
        });
      }
      if (target.company !== null && target.company.quote.length > MAX_TARGET_CHARS) {
        ctx.addIssue({
          code: "custom",
          path: [...at, "target", "company", "quote"],
          message: "quote is too long",
        });
      }
    }
    for (const [name, field] of Object.entries(proposal.fields) as [string, ToolField | null][]) {
      if (field === null) continue;
      const path = [...at, "fields", name];
      if (typeof field.value === "string" && field.value.length > MAX_FIELD_CHARS) {
        ctx.addIssue({ code: "custom", path: [...path, "value"], message: "value is too long" });
      }
      if (field.quote.length > MAX_FIELD_CHARS) {
        ctx.addIssue({ code: "custom", path: [...path, "quote"], message: "quote is too long" });
      }
      if (typeof field.value === "number" && !(Number.isFinite(field.value) && field.value >= 0)) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "value"],
          message: "expected a non-negative number",
        });
      }
      // An empty value counts as not said, like null (`understand`).
      if (typeof field.value === "string" && field.value.trim() !== "") {
        if (DATE_FIELDS.has(name) && !IsoDate.safeParse(field.value).success) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "value"],
            message: "expected a calendar date as YYYY-MM-DD",
          });
        }
        if (TIME_FIELDS.has(name) && !CLOCK_TIME.test(field.value)) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "value"],
            message: "expected a time as HH:MM on a 24-hour clock",
          });
        }
      }
    }
  });
});

/**
 * Keywords Anthropic's strict tool use refuses, from its structured-output limits. The schema
 * test fails if one appears.
 */
export const STRICT_UNSUPPORTED_KEYWORDS: readonly string[] = [
  "oneOf",
  "not",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
];

type JsonSchemaNode = { [key: string]: unknown };

/**
 * Renames `oneOf` to `anyOf` everywhere and drops `$schema`: the shape both providers accept. The
 * recap's tool (`./recap/schema.ts`) goes through it too.
 */
export function toToolSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toToolSchema);
  if (typeof node !== "object" || node === null) return node;
  const out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    out[key === "oneOf" ? "anyOf" : key] = toToolSchema(value);
  }
  return out;
}

/** The JSON Schema both adapters send as the tool's input schema. */
export const SUBMIT_PROPOSALS_JSON_SCHEMA = toToolSchema(
  z.toJSONSchema(SubmitProposalsWire, { target: "draft-7", io: "input", unrepresentable: "throw" }),
) as JsonSchemaNode;

export const SUBMIT_PROPOSALS_DESCRIPTION =
  "Submit every CRM change this turn's words support, as proposals. Call it exactly once per turn, with an empty list when the turn supports none.";

/** One line per issue, `path: problem`, at most `limit` of them: the retry's feedback. */
export function describeIssues(error: z.ZodError, limit = 10): string[] {
  const lines = error.issues.slice(0, limit).map((issue) => {
    const path = issue.path.map(String).join(".");
    return path === "" ? issue.message : `${path}: ${issue.message}`;
  });
  if (error.issues.length > limit) lines.push(`and ${error.issues.length - limit} more problems`);
  return lines;
}
