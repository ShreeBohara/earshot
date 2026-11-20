// The recap's one tool, `submit_recap` (Phase 5 spec §4.9; ADR-0037), forced on both providers
// through the same adapters as extraction:
//
//   { sentences: [{ kind: "headline" | "next_step" | "commitment", text, quotes: string[] }],
//     lens: { fields: [{ field, quote: string | null }] } | null }
//
// As with `submit_proposals`, the wire schema carries types, literals, enums, and nullability only,
// so Anthropic's strict tool use takes it and Groq's strict rules would too (every property
// required, no extra ones). The limits it can't carry (1–12 sentences, 1–4 quotes of at most 200
// characters, a sentence of at most 400, a headline) are checked by `submitRecapInput`'s
// refinement on every attempt, and drive the one retry. Whether each quote is really in the
// transcript is the checks' job (`./checks.ts`), not validation's: a sentence with no located
// quote is dropped, never retried.
import {
  MAX_RECAP_EVIDENCE,
  MAX_RECAP_QUOTE_CHARS,
  MAX_RECAP_SENTENCE_CHARS,
  MAX_RECAP_SENTENCES,
} from "@earshot/core";
import { z } from "zod";
import { toToolSchema } from "../schema";

/** The tool's name, as the prompt and the forced tool choice spell it. */
export const SUBMIT_RECAP = "submit_recap";

const QUOTES_DESCRIPTION = `1 to ${MAX_RECAP_EVIDENCE} runs of the rep's exact words this sentence comes from, each copied from one line of the transcript character for character, at most ${MAX_RECAP_QUOTE_CHARS} characters.`;

const Sentence = z.strictObject({
  kind: z
    .enum(["headline", "next_step", "commitment"])
    .describe(
      "headline: the call's outcome in one sentence. next_step: something the rep said they'll do. commitment: a promise the rep or the customer made.",
    ),
  text: z
    .string()
    .describe("The sentence, in plain words. Say nothing the rep didn't say in the quotes."),
  quotes: z.array(z.string()).describe(QUOTES_DESCRIPTION),
});

const LensField = z.strictObject({
  field: z.string().describe("The lens field's id, exactly as listed."),
  quote: z
    .string()
    .nullable()
    .describe(
      `The rep's exact words about this field, copied from one line of the transcript, at most ${MAX_RECAP_QUOTE_CHARS} characters; or null if the rep didn't mention it.`,
    ),
});

const SubmitRecapWire = z.strictObject({
  sentences: z
    .array(Sentence)
    .describe(
      `The headline first, then each next step and commitment in the order the rep said them; at most ${MAX_RECAP_SENTENCES} in all.`,
    ),
  lens: z
    .strictObject({
      fields: z.array(LensField).describe("Every field of the lens, in the order listed."),
    })
    .nullable()
    .describe("The lens's fields, when the instructions list a lens; otherwise null."),
});
export type SubmitRecapInput = z.infer<typeof SubmitRecapWire>;
/** One sentence as the model writes it: its kind, its text, and the words it quotes. */
export type RecapToolSentence = SubmitRecapInput["sentences"][number];

/**
 * The tool's input with every check its JSON Schema can't carry. Issues name the path and the
 * problem, never the value, because they go back to the model in the retry.
 */
export const submitRecapInput = SubmitRecapWire.superRefine((input, ctx) => {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  if (input.sentences.length === 0) issue(["sentences"], "write at least the headline");
  if (input.sentences.length > MAX_RECAP_SENTENCES) {
    issue(["sentences"], `at most ${MAX_RECAP_SENTENCES} sentences`);
  }
  if (
    input.sentences.length > 0 &&
    !input.sentences.some((sentence) => sentence.kind === "headline")
  ) {
    issue(["sentences"], "write one headline");
  }
  input.sentences.forEach((sentence, index) => {
    const at = ["sentences", index];
    if (sentence.text.trim() === "") issue([...at, "text"], "text is empty");
    if (sentence.text.length > MAX_RECAP_SENTENCE_CHARS) {
      issue([...at, "text"], `text is longer than ${MAX_RECAP_SENTENCE_CHARS} characters`);
    }
    if (sentence.quotes.length === 0) issue([...at, "quotes"], "quote at least one run of words");
    if (sentence.quotes.length > MAX_RECAP_EVIDENCE) {
      issue([...at, "quotes"], `at most ${MAX_RECAP_EVIDENCE} quotes`);
    }
    sentence.quotes.forEach((quote, q) => {
      if (quote.trim() === "") issue([...at, "quotes", q], "quote is empty");
      if (quote.length > MAX_RECAP_QUOTE_CHARS) {
        issue([...at, "quotes", q], `quote is longer than ${MAX_RECAP_QUOTE_CHARS} characters`);
      }
    });
  });
  input.lens?.fields.forEach((field, index) => {
    if (field.quote !== null && field.quote.length > MAX_RECAP_QUOTE_CHARS) {
      issue(
        ["lens", "fields", index, "quote"],
        `quote is longer than ${MAX_RECAP_QUOTE_CHARS} characters`,
      );
    }
  });
});

/** The JSON Schema both adapters send as the tool's input schema. */
export const SUBMIT_RECAP_JSON_SCHEMA = toToolSchema(
  z.toJSONSchema(SubmitRecapWire, { target: "draft-7", io: "input", unrepresentable: "throw" }),
) as { [key: string]: unknown };

export const SUBMIT_RECAP_DESCRIPTION =
  "Submit the debrief's recap: a headline, then its next steps and commitments, every sentence quoting the rep's exact words. Call it exactly once.";
