// The recap (Phase 5 spec WP10 step 2, §4.9): the forced tool's schema and validation, the prompt,
// the checks in code (located quotes, drops, weak support, one headline, "not mentioned"), and
// `runRecap` on both adapters with scripted responses: priced usage, the retry, every failure as
// an outcome, and the deadline.
import {
  RecapCreatedV1,
  RecapLensFieldId,
  UsageRecordedV1,
  type UtteranceFinalV2,
} from "@earshot/core";
import { recapProblem } from "@earshot/events";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { llmCostUsd } from "../src/prices";
import {
  buildRecapPrompt,
  checkRecap,
  createRecapper,
  lensMentioned,
  RECAP_LENS_LIST,
  RECAP_LENSES,
  type RecapProposal,
  recapLens,
  recapProposals,
  runRecap,
  SUBMIT_RECAP_JSON_SCHEMA,
  type SubmitRecapInput,
  submitRecapInput,
} from "../src/recap";
import { STRICT_UNSUPPORTED_KEYWORDS } from "../src/schema";
import {
  anthropicError,
  DEMO_UTTERANCES,
  groqError,
  type RecapScenario,
  recapResponse,
  recordRecap,
  SCENARIO_API_KEY,
  scriptedRecapFetch,
  scriptedRecapInput,
} from "../src/testing";
import { counter } from "./helpers";

type Node = { [key: string]: unknown };

function* walk(node: unknown, path = "$"): Generator<[string, Node]> {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) yield* walk(item, `${path}[${index}]`);
  } else if (node !== null && typeof node === "object") {
    yield [path, node as Node];
    for (const [key, value] of Object.entries(node)) yield* walk(value, `${path}.${key}`);
  }
}

const utterance = (n: number, text: string, witness = "biased"): UtteranceFinalV2 => ({
  utteranceId: `01a1c6e8-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  text,
  confidence: 0.9,
  startMs: n * 5_000,
  endMs: n * 5_000 + 4_000,
  witness: witness as "biased" | "unbiased",
});

const SESSION: readonly UtteranceFinalV2[] = [
  utterance(1, "Just left Acme Dynamics. Dana Lee wants to expand the rollout to two more plants."),
  utterance(2, "I owe Dana Lee a revised quote by Friday."),
  utterance(3, "She promised to bring their CFO to the next call."),
];

const PROPOSALS: readonly RecapProposal[] = [
  {
    type: "task",
    record: "Dana Lee",
    fields: { title: "Send Dana Lee a revised quote", dueDate: "2026-11-20" },
  },
];

/** A well-behaved answer for SESSION. */
const ANSWER: SubmitRecapInput = {
  sentences: [
    {
      kind: "headline",
      text: "Dana Lee wants to expand the rollout to two more plants.",
      quotes: ["Dana Lee wants to expand the rollout to two more plants"],
    },
    {
      kind: "next_step",
      text: "Send Dana Lee a revised quote by Friday.",
      quotes: ["owe Dana Lee a revised quote", "by Friday"],
    },
    {
      kind: "commitment",
      text: "Dana will bring the CFO to the next call.",
      quotes: ["promised to bring their CFO to the next call"],
    },
  ],
  lens: null,
};

const TOKENS = { input: 1_800, output: 350, reasoning: 400 };

function scenarioOf(
  provider: "anthropic" | "groq",
  responses: RecapScenario["responses"],
  expect: RecapScenario["expect"],
  input: Partial<RecapScenario["input"]> = {},
): RecapScenario {
  return {
    name: "recap",
    description: "a test recap",
    provider,
    input: { utterances: SESSION, proposals: PROPOSALS, lens: null, ...input },
    responses,
    expect,
  };
}

describe("the submit_recap JSON Schema", () => {
  const nodes = [...walk(SUBMIT_RECAP_JSON_SCHEMA)];

  it("uses no keyword Anthropic's strict tool use refuses", () => {
    const keywords = new Set(nodes.flatMap(([, node]) => Object.keys(node)));
    for (const keyword of STRICT_UNSUPPORTED_KEYWORDS) {
      expect(keywords.has(keyword), keyword).toBe(false);
    }
    expect(keywords.has("$schema")).toBe(false);
  });

  it("meets Groq's strict rules: closed objects with every property required", () => {
    const objects = nodes.filter(([, node]) => node.type === "object");
    expect(objects.length).toBeGreaterThanOrEqual(4);
    for (const [path, node] of objects) {
      expect(node.additionalProperties, path).toBe(false);
      const properties = Object.keys((node.properties ?? {}) as Node).sort();
      expect([...((node.required ?? []) as string[])].sort(), path).toEqual(properties);
    }
  });
});

describe("submitRecapInput", () => {
  const sentence = ANSWER.sentences[1] as SubmitRecapInput["sentences"][number];
  const headline = ANSWER.sentences[0] as SubmitRecapInput["sentences"][number];
  const problems = (input: unknown) => {
    const parsed = submitRecapInput.safeParse(input);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  };

  it("takes a recap within the limits", () => {
    expect(problems(ANSWER)).toEqual([]);
    expect(problems({ ...ANSWER, sentences: [headline, ...Array(11).fill(sentence)] })).toEqual([]);
  });

  it("refuses no sentences, more than 12, or none a headline", () => {
    expect(problems({ sentences: [], lens: null })).toContain("write at least the headline");
    expect(problems({ ...ANSWER, sentences: [headline, ...Array(12).fill(sentence)] })).toContain(
      "at most 12 sentences",
    );
    expect(problems({ ...ANSWER, sentences: [sentence] })).toContain("write one headline");
  });

  it("refuses empty or long text, no quotes or more than four, and long quotes", () => {
    const one = (patch: Record<string, unknown>) => ({
      ...ANSWER,
      sentences: [headline, { ...sentence, ...patch }],
    });
    expect(problems(one({ text: "  " }))).toContain("text is empty");
    expect(problems(one({ text: "x".repeat(401) }))).toContain(
      "text is longer than 400 characters",
    );
    expect(problems(one({ quotes: [] }))).toContain("quote at least one run of words");
    expect(problems(one({ quotes: ["a", "b", "c", "d", "e"] }))).toContain("at most 4 quotes");
    expect(problems(one({ quotes: ["y".repeat(201)] }))).toContain(
      "quote is longer than 200 characters",
    );
    expect(
      problems({ ...ANSWER, lens: { fields: [{ field: "budget", quote: "z".repeat(201) }] } }),
    ).toContain("quote is longer than 200 characters");
  });

  it("never quotes a value in its issues, since they go back to the model", () => {
    const secret = "a value that must not be echoed".padEnd(420, "!");
    const parsed = submitRecapInput.safeParse({
      ...ANSWER,
      sentences: [headline, { ...sentence, text: secret }],
    });
    expect(JSON.stringify(parsed.error?.issues)).not.toContain("must not be echoed");
  });
});

describe("the lens files", () => {
  const LensFile = z.strictObject({
    id: z.enum(["meddic", "spiced", "bant"]),
    label: z.string().min(1),
    fields: z
      .array(
        z.strictObject({
          id: RecapLensFieldId,
          label: z.string().min(1),
          describe: z.string().min(10).max(120),
        }),
      )
      .min(1)
      .max(8),
  });

  it("hold MEDDIC's six fields, SPICED's five, and BANT's four, each id once", () => {
    for (const lens of RECAP_LENS_LIST) {
      LensFile.parse(lens);
      expect(new Set(lens.fields.map((field) => field.id)).size, lens.id).toBe(lens.fields.length);
    }
    expect(RECAP_LENSES.meddic.fields.map((field) => field.id)).toEqual([
      "metrics",
      "economic_buyer",
      "decision_criteria",
      "decision_process",
      "identified_pain",
      "champion",
    ]);
    expect(RECAP_LENSES.spiced.fields.map((field) => field.id)).toEqual([
      "situation",
      "pain",
      "impact",
      "critical_event",
      "decision",
    ]);
    expect(RECAP_LENSES.bant.fields.map((field) => field.id)).toEqual([
      "budget",
      "authority",
      "need",
      "timeline",
    ]);
    expect(recapLens(null)).toBeNull();
    expect(recapLens("bant")?.label).toBe("BANT");
  });
});

describe("buildRecapPrompt", () => {
  it("puts the rules and the lens in the instructions, and the transcript and proposals after", () => {
    const prompt = buildRecapPrompt({
      utterances: SESSION,
      proposals: PROPOSALS,
      lens: RECAP_LENSES.bant,
    });
    expect(prompt.instructions).toContain("Call submit_recap once.");
    expect(prompt.instructions).toContain("Lens: BANT.");
    expect(prompt.instructions).toContain("- authority (Authority): ");
    expect(prompt.transcript).toContain(
      "<transcript>\nJust left Acme Dynamics. Dana Lee wants to expand the rollout to two more plants.\nI owe Dana Lee a revised quote by Friday.\nShe promised to bring their CFO to the next call.\n</transcript>",
    );
    // Field names sorted, strings quoted, and nothing about ids or evidence.
    expect(prompt.transcript).toContain(
      '- task, Dana Lee: dueDate "2026-11-20"; title "Send Dana Lee a revised quote"',
    );
    expect(prompt.transcript).not.toMatch(/01a1c6e8|utteranceId|audioMs/);
  });

  it("is the same whatever order a proposal's fields come in, and says when there are none", () => {
    const flipped = [
      {
        ...PROPOSALS[0],
        fields: { dueDate: "2026-11-20", title: "Send Dana Lee a revised quote" },
      },
    ] as RecapProposal[];
    expect(buildRecapPrompt({ utterances: SESSION, proposals: flipped, lens: null })).toEqual(
      buildRecapPrompt({ utterances: SESSION, proposals: PROPOSALS, lens: null }),
    );
    const none = buildRecapPrompt({ utterances: SESSION, proposals: [], lens: null });
    expect(none.transcript).toContain("<proposals>\n(none)\n</proposals>");
    expect(none.instructions).not.toContain("Lens:");
  });

  it("keeps each utterance on one line", () => {
    const prompt = buildRecapPrompt({
      utterances: [utterance(1, "Line one\n\nstill line one")],
      proposals: [],
      lens: null,
    });
    expect(prompt.transcript).toContain("<transcript>\nLine one still line one\n</transcript>");
  });
});

describe("checkRecap", () => {
  it("keeps sentences whose quotes it finds, with their evidence, in the model's order", () => {
    const checked = checkRecap(ANSWER, SESSION, null);
    expect(checked.dropped).toBe(0);
    expect(checked.sentences.map((s) => s.kind)).toEqual(["headline", "next_step", "commitment"]);
    const [, step] = checked.sentences;
    expect(step?.evidence).toHaveLength(2);
    expect(step?.evidence[0]).toMatchObject({
      utteranceId: SESSION[1]?.utteranceId,
      span: [2, 30],
    });
    expect(checked.trace.map((t) => t.fate)).toEqual(["kept", "kept", "kept"]);
  });

  it("drops a sentence with no located quote, and counts it", () => {
    const invented = {
      kind: "next_step" as const,
      text: "Send the signed contract by Monday.",
      quotes: ["they'll sign the contract by Monday"],
    };
    const paraphrased = {
      kind: "commitment" as const,
      text: "Dana will bring the CFO.",
      quotes: ["Dana promised she'd bring the CFO"],
    };
    const checked = checkRecap(
      { ...ANSWER, sentences: [...ANSWER.sentences, invented, paraphrased] },
      SESSION,
      null,
    );
    expect(checked.sentences).toHaveLength(3);
    expect(checked.dropped).toBe(2);
    expect(checked.trace.slice(3).map((t) => [t.fate, t.located])).toEqual([
      ["no_quote", 0],
      ["no_quote", 0],
    ]);
  });

  it("keeps a sentence with one located quote of two, with that quote's evidence only", () => {
    const sentence = {
      kind: "next_step" as const,
      text: "Send Dana Lee a revised quote.",
      quotes: ["owe Dana Lee a revised quote", "the CEO signs by Monday"],
    };
    const checked = checkRecap(
      { ...ANSWER, sentences: [ANSWER.sentences[0], sentence] as SubmitRecapInput["sentences"] },
      SESSION,
      null,
    );
    expect(checked.sentences[1]?.evidence).toHaveLength(1);
    expect(checked.trace[1]).toMatchObject({ fate: "kept", located: 1, quotes: 2 });
  });

  it("marks weak support under 0.5 overlap, and keeps the sentence", () => {
    const weak = {
      kind: "next_step" as const,
      text: "Escalate pricing approval with procurement leadership tomorrow.",
      quotes: ["by Friday"],
    };
    const checked = checkRecap(
      { ...ANSWER, sentences: [ANSWER.sentences[0], weak] as SubmitRecapInput["sentences"] },
      SESSION,
      null,
    );
    expect(checked.sentences[1]?.weakSupport).toBe(true);
    expect(checked.sentences[0]?.weakSupport).toBe(false);
  });

  it("keeps only the first kept headline, first, whatever the model's order", () => {
    const [headline, step, promise] = ANSWER.sentences as SubmitRecapInput["sentences"];
    const unbacked = { kind: "headline" as const, text: "A great call.", quotes: ["a great call"] };
    const second = { ...headline, text: "Dana wants two more plants." } as typeof headline;
    const checked = checkRecap(
      {
        ...ANSWER,
        sentences: [step, unbacked, headline, promise, second] as SubmitRecapInput["sentences"],
      },
      SESSION,
      null,
    );
    expect(checked.sentences.map((s) => s.kind)).toEqual(["headline", "next_step", "commitment"]);
    expect(checked.sentences[0]?.text).toBe(headline?.text);
    expect(checked.dropped).toBe(1);
    expect(checked.trace.map((t) => t.fate)).toEqual([
      "kept",
      "no_quote",
      "kept",
      "kept",
      "extra_headline",
    ]);
  });

  it("drops a sentence whose text is shaped like a key, which no utterance can hold", () => {
    const keyed = {
      kind: "next_step" as const,
      text: "Use the key sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx for the quote.",
      quotes: ["owe Dana Lee a revised quote"],
    };
    const checked = checkRecap(
      { ...ANSWER, sentences: [...ANSWER.sentences, keyed] },
      SESSION,
      null,
    );
    expect(checked.sentences).toHaveLength(3);
    expect(checked.dropped).toBe(1);
    expect(checked.trace.at(-1)?.fate).toBe("key_shaped");
  });

  it("finds quotes only in the biased stream's words", () => {
    const withWitness = [...SESSION, utterance(4, "The witness heard Akme Dynamics.", "unbiased")];
    const checked = checkRecap(
      {
        ...ANSWER,
        sentences: [
          ...ANSWER.sentences,
          { kind: "next_step", text: "Akme.", quotes: ["heard Akme Dynamics"] },
        ],
      },
      withWitness,
      null,
    );
    expect(checked.dropped).toBe(1);
  });

  it("keeps each span once, and at most four pieces of evidence", () => {
    const sentence = {
      kind: "next_step" as const,
      text: "Send Dana Lee a revised quote by Friday.",
      quotes: ["by Friday", "by Friday", "a revised quote", "Dana Lee", "owe"],
    };
    const checked = checkRecap(
      { sentences: [ANSWER.sentences[0], sentence] as SubmitRecapInput["sentences"], lens: null },
      SESSION,
      null,
    );
    expect(checked.sentences[1]?.evidence).toHaveLength(4);
    expect(new Set(checked.sentences[1]?.evidence.map((e) => e.span.join())).size).toBe(4);
  });

  it("maps a lens: located quotes, everything else not mentioned, in the file's order", () => {
    const checked = checkRecap(
      {
        ...ANSWER,
        lens: {
          fields: [
            { field: "need", quote: "wants to expand the rollout" },
            { field: "authority", quote: "the CFO signs off" },
            { field: "unknown", quote: "Acme" },
            { field: "need", quote: "two more plants" },
          ],
        },
      },
      SESSION,
      RECAP_LENSES.bant,
    );
    expect(checked.lens?.id).toBe("bant");
    expect(checked.lens?.fields.map((f) => [f.field, f.quote])).toEqual([
      ["budget", null],
      ["authority", null],
      ["need", "wants to expand the rollout"],
      ["timeline", null],
    ]);
    expect(checked.lens?.fields[2]?.evidence?.utteranceId).toBe(SESSION[0]?.utteranceId);
    expect(lensMentioned(checked.lens ?? { fields: [] })).toBe(1);
  });

  it("stores the transcript's own words for a lens quote found ignoring case", () => {
    const checked = checkRecap(
      { ...ANSWER, lens: { fields: [{ field: "need", quote: "WANTS TO EXPAND" }] } },
      SESSION,
      RECAP_LENSES.bant,
    );
    expect(checked.lens?.fields[2]?.quote).toBe("wants to expand");
  });

  it("gives every field as not mentioned when the model left the lens out, and no lens unasked", () => {
    expect(checkRecap(ANSWER, SESSION, RECAP_LENSES.meddic).lens?.fields).toHaveLength(6);
    expect(
      checkRecap(ANSWER, SESSION, RECAP_LENSES.meddic).lens?.fields.every((f) => f.quote === null),
    ).toBe(true);
    const filled = { ...ANSWER, lens: { fields: [{ field: "need", quote: "two more plants" }] } };
    expect(checkRecap(filled, SESSION, null).lens).toBeNull();
  });
});

describe("recapProposals", () => {
  it("leaves out rejected and superseded proposals, and names records by the CRM or the words", () => {
    const target = (decision: "linked" | "ask" | "new" | "none", entityId: string | null) => ({
      decision,
      entityId,
      mention: decision === "none" ? null : { quote: "Akme" },
    });
    const fields = { body: { value: "They like it." } };
    const proposals = recapProposals(
      [
        { type: "note", status: "proposed", target: target("linked", "co_1"), fields },
        { type: "note", status: "rejected", target: target("linked", "co_1"), fields },
        { type: "note", status: "superseded", target: target("linked", "co_1"), fields },
        { type: "note", target: target("ask", null), fields },
        { type: "note", status: "approved", target: target("none", null), fields },
      ],
      (id) => (id === "co_1" ? "Acme Dynamics" : null),
    );
    expect(proposals.map((p) => p.record)).toEqual(["Acme Dynamics", "Akme", null]);
    expect(proposals[0]?.fields).toEqual({ body: "They like it." });
  });
});

describe("runRecap", () => {
  for (const provider of ["anthropic", "groq"] as const) {
    it(`${provider}: writes a recap the checks keep, and prices its usage`, async () => {
      const { result, cassette } = await recordRecap(
        scenarioOf(provider, [recapResponse(provider, ANSWER, TOKENS, "1")], {
          outcome: "created",
          attempts: 1,
        }),
      );
      RecapCreatedV1.parse(result.recap);
      expect(recapProblem(result.recap)).toBeNull();
      expect(result.recap).toMatchObject({
        outcome: "created",
        reason: null,
        llm: { provider },
        dropped: 0,
        lens: null,
      });
      expect(result.recap.sentences).toHaveLength(3);
      const usage = UsageRecordedV1.parse(result.usage);
      const row = createRecapper({ provider }).price;
      const output = provider === "groq" ? TOKENS.output + TOKENS.reasoning : TOKENS.output;
      expect(usage).toMatchObject({
        kind: "llm",
        provider,
        inputTokens: 1_800,
        outputTokens: output,
      });
      expect(usage.costUsd).toBe(
        llmCostUsd(
          {
            inputTokens: 1_800,
            outputTokens: output,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
          row,
        ),
      );
      // The forced tool, and nothing in the recorded request but the transcript and options.
      const excerpt = JSON.stringify(cassette.interactions[0]?.request.excerpt);
      expect(excerpt).toContain("submit_recap");
      expect(excerpt).not.toContain(SCENARIO_API_KEY);
    });
  }

  it("retries once when the output fails validation, with the problems, and keeps the second", async () => {
    const { result, cassette } = await recordRecap(
      scenarioOf(
        "anthropic",
        [
          recapResponse("anthropic", { sentences: [], lens: null }, TOKENS, "1"),
          recapResponse("anthropic", ANSWER, TOKENS, "2"),
        ],
        { outcome: "created", attempts: 2 },
      ),
    );
    expect(result.recap.sentences).toHaveLength(3);
    expect(JSON.stringify(cassette.interactions[1]?.request.excerpt)).toContain(
      "Your previous submit_recap call was rejected",
    );
    expect(result.usage?.inputTokens).toBe(3_600);
  });

  it("fails as invalid_output after two invalid answers", async () => {
    const bad = recapResponse("groq", { sentences: [], lens: null }, TOKENS, "1");
    const { result } = await recordRecap(
      scenarioOf("groq", [bad, bad], { outcome: "failed", attempts: 2 }),
    );
    expect(result.recap).toMatchObject({ outcome: "failed", reason: "invalid_output" });
    expect(recapProblem(result.recap)).toBeNull();
    expect(result.usage).not.toBeNull();
  });

  it("tries a 5xx once more, then fails as provider_error; a 429 past the deadline isn't retried", async () => {
    const error = anthropicError(500, "api_error", "boom");
    const { result } = await recordRecap(
      scenarioOf("anthropic", [error, error], { outcome: "failed", attempts: 2 }),
    );
    expect(result.recap.reason).toBe("provider_error");
    expect(result.failure).toEqual({ code: "provider_error", detail: "http_500" });
    const limited = groqError(
      429,
      { message: "slow down", type: "rate_limit" },
      { "retry-after": "60" },
    );
    const throttled = await recordRecap(
      scenarioOf("groq", [limited], { outcome: "failed", attempts: 1 }),
    );
    expect(throttled.result.recap.reason).toBe("rate_limited");
    expect(throttled.result.usage).toBeNull();
  });

  it("fails as a timeout when the answer comes after the deadline", async () => {
    const result = await runRecap({
      recapper: createRecapper({
        provider: "anthropic",
        fetch: scriptedRecapFetch({
          provider: "anthropic",
          mode: "slow",
          delayMs: 5_000,
        }) as typeof fetch,
      }),
      utterances: SESSION,
      proposals: [],
      lens: null,
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
      policy: { maxAttempts: 2, deadlineMs: 50, baseDelayMs: 10, maxDelayMs: 10 },
    });
    expect(result.recap).toMatchObject({ outcome: "failed", reason: "timeout" });
    expect(result.failure?.detail).toBe("timeout");
  });

  it("skips with no_speech, and calls nothing, when no biased utterance has words", async () => {
    const fetch = scriptedRecapFetch({ provider: "anthropic" });
    const result = await runRecap({
      recapper: createRecapper({ provider: "anthropic", fetch: fetch as typeof globalThis.fetch }),
      utterances: [utterance(1, "   "), utterance(2, "The witness's words.", "unbiased")],
      proposals: [],
      lens: "meddic",
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
      newId: counter(),
    });
    expect(result.recap).toMatchObject({
      outcome: "skipped",
      reason: "no_speech",
      llm: { provider: "anthropic", model: "claude-haiku-5-5" },
      lens: null,
    });
    expect(recapProblem(result.recap)).toBeNull();
    expect(fetch.requests).toBe(0);
    expect(result.usage).toBeNull();
  });

  it("refuses an empty key without a call, and an unsupported model at creation", async () => {
    const fetch = scriptedRecapFetch({ provider: "groq" });
    const result = await runRecap({
      recapper: createRecapper({ provider: "groq", fetch: fetch as typeof globalThis.fetch }),
      utterances: SESSION,
      proposals: [],
      lens: null,
      apiKey: " ",
      signal: new AbortController().signal,
    });
    expect(result.recap).toMatchObject({ outcome: "failed", reason: "provider_error" });
    expect(fetch.requests).toBe(0);
    expect(() => createRecapper({ provider: "anthropic", model: "claude-opus-5-5" })).toThrow(
      RangeError,
    );
  });

  it("sends only the biased stream's words, and never puts the key in the result", async () => {
    const requests: string[] = [];
    const scripted = scriptedRecapFetch({ provider: "anthropic" });
    const recorder = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(await new Request(input, init).text());
      return scripted(input, init);
    };
    const key = "sk-ant-api03-recap-test-key-0000000000000000";
    const result = await runRecap({
      recapper: createRecapper({ provider: "anthropic", fetch: recorder as typeof fetch }),
      utterances: [...SESSION, utterance(9, "Akme Dynamix, said the witness.", "unbiased")],
      proposals: PROPOSALS,
      lens: "meddic",
      apiKey: key,
      signal: new AbortController().signal,
    });
    expect(result.recap.outcome).toBe("created");
    expect(requests.join("")).not.toContain("Akme Dynamix");
    expect(JSON.stringify(result)).not.toContain(key);
  });
});

describe("the scripted recap model", () => {
  const lines = DEMO_UTTERANCES.map((u) => u.text);

  it("writes a headline and the rep's next steps from the request's own words, which the checks keep", async () => {
    const input = scriptedRecapInput(
      lines,
      RECAP_LENSES.meddic.fields.map((f) => f.id),
    );
    expect(input.sentences[0]).toEqual({
      kind: "headline",
      text: "Just got out of the meeting with Acme Corp.",
      quotes: ["Just got out of the meeting with Acme Corp"],
    });
    expect(input.sentences.slice(1)).toEqual([
      {
        kind: "next_step",
        text: "Send Dana the pricing breakdown by Thursday.",
        quotes: ["I need to send Dana the pricing breakdown by Thursday"],
      },
    ]);
    const checked = checkRecap(input, DEMO_UTTERANCES, RECAP_LENSES.meddic);
    expect(checked.dropped).toBe(0);
    expect(checked.sentences).toHaveLength(2);
    expect(checked.lens?.fields.filter((f) => f.quote !== null).map((f) => f.field)).toEqual([
      "decision_process",
      "identified_pain",
      "champion",
    ]);
  });

  it("adds an unbacked sentence in `unlocatable` mode, which the checks drop", async () => {
    const result = await runRecap({
      recapper: createRecapper({
        provider: "groq",
        fetch: scriptedRecapFetch({ provider: "groq", mode: "unlocatable" }) as typeof fetch,
      }),
      utterances: DEMO_UTTERANCES,
      proposals: [],
      lens: null,
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
    });
    expect(result.recap).toMatchObject({ outcome: "created", dropped: 1 });
    expect(result.trace.at(-1)).toMatchObject({ fate: "no_quote" });
  });
});
