// The ground truth behind the hand-made cassettes: the demo session's seven turns, a few edge
// cases, and each provider's response to them in its own wire format. scripts/gen-cassettes.ts
// runs the real adapters against these responses to record what they send; the tests replay the
// result. No byte here came from a provider.
import type { EntityRef, LlmProvider, TurnOutcome, UtteranceFinalV2 } from "@earshot/core";
import { LLM_MODELS } from "../extractor";
import type { ToolProposal } from "../schema";

/**
 * The key the scenarios run with. Cassettes never hold a key, so any string of the right shape
 * replays them. It looks like no provider's key, so it trips no key-shape check.
 */
export const SCENARIO_API_KEY = "earshot-test-key-0000-not-a-provider-key";

/** The demo session (`@earshot/events` fixtures/demo-session.jsonl): when and where it happened. */
export const DEMO_CALL_TIME = "2026-11-10T19:15:00.000Z";
export const DEMO_TIME_ZONE = "America/Los_Angeles";

/** The demo's targets, with the ids its `proposal.created` events use. */
export const DEMO_COMPANY_ID = "01a0f831-ac00-75a0-a2b2-cb79eb1835bf";
export const DEMO_DEAL_ID = "01a0f831-afe8-7fff-84cf-71639949085b";

/**
 * The session's entities: Acme Corp and its deal, and look-alikes from `@earshot/demo-crm`'s
 * confusable groups, so a sloppy target can't land by luck.
 */
export const DEMO_ENTITIES: readonly EntityRef[] = [
  { id: DEMO_COMPANY_ID, kind: "company", name: "Acme Corp", aliases: ["Acme"] },
  { id: DEMO_DEAL_ID, kind: "deal", name: "Acme Corp - Security Platform", aliases: [] },
  { id: "co_044", kind: "company", name: "Akme Dynamics", aliases: ["Akme"] },
  { id: "co_040", kind: "company", name: "Acmi Dynamics", aliases: ["Acmi"] },
  { id: "ct_112", kind: "contact", name: "Donna Lee", aliases: [] },
  { id: "ct_145", kind: "contact", name: "Dana Li", aliases: [] },
];

/** The demo session's seven utterances, as `utterance.final` v2 (the first is upcast from v1). */
export const DEMO_UTTERANCES: readonly UtteranceFinalV2[] = [
  {
    utteranceId: "01a1c6e2-af90-75b5-a79c-eb5ca2f0a104",
    text: "Just got out of the meeting with Acme Corp. Met Dana Lee, their new VP of Operations.",
    confidence: 0.93,
    startMs: 1200,
    endMs: 6900,
    words: [
      { w: "Just", startMs: 1200, endMs: 1470, confidence: 0.91 },
      { w: "got", startMs: 1540, endMs: 1740, confidence: 0.96 },
      { w: "out", startMs: 1800, endMs: 2000, confidence: 0.92 },
      { w: "of", startMs: 2070, endMs: 2210, confidence: 0.9 },
      { w: "the", startMs: 2270, endMs: 2470, confidence: 0.91 },
      { w: "meeting", startMs: 2540, endMs: 3010, confidence: 0.96 },
      { w: "with", startMs: 3080, endMs: 3350, confidence: 0.92 },
      { w: "Acme", startMs: 3410, endMs: 3680, confidence: 0.9 },
      { w: "Corp", startMs: 3750, endMs: 4020, confidence: 0.92 },
      { w: "Met", startMs: 4150, endMs: 4350, confidence: 0.97 },
      { w: "Dana", startMs: 4420, endMs: 4690, confidence: 0.88 },
      { w: "Lee", startMs: 4750, endMs: 4960, confidence: 0.81 },
      { w: "their", startMs: 5090, endMs: 5420, confidence: 0.99 },
      { w: "new", startMs: 5490, endMs: 5690, confidence: 0.93 },
      { w: "VP", startMs: 5760, endMs: 5890, confidence: 0.88 },
      { w: "of", startMs: 5960, endMs: 6100, confidence: 0.99 },
      { w: "Operations", startMs: 6160, endMs: 6830, confidence: 0.99 },
    ],
    witness: "biased",
  },
  {
    utteranceId: "01a1c6e2-c67e-707a-8cdc-465b25f35f48",
    text: "She's taking over the evaluation, so she's our main contact now.",
    confidence: 0.95,
    startMs: 7600,
    endMs: 12800,
    witness: "biased",
  },
  {
    utteranceId: "01a1c6e2-e118-77dc-97e5-3339cf89cd64",
    text: "They want a revised proposal with the security add-on, so move the deal to the proposal stage.",
    confidence: 0.91,
    startMs: 13500,
    endMs: 19600,
    witness: "biased",
  },
  {
    utteranceId: "01a1c6e2-f5b8-7d83-a268-13560deb2986",
    text: "I need to send Dana the pricing breakdown by Thursday.",
    confidence: 0.92,
    startMs: 20300,
    endMs: 24900,
    words: [
      { w: "I", startMs: 20300, endMs: 20390, confidence: 0.99 },
      { w: "need", startMs: 20470, endMs: 20810, confidence: 0.88 },
      { w: "to", startMs: 20900, endMs: 21070, confidence: 0.97 },
      { w: "send", startMs: 21150, endMs: 21490, confidence: 0.87 },
      { w: "Dana", startMs: 21580, endMs: 21920, confidence: 0.91 },
      { w: "the", startMs: 22000, endMs: 22260, confidence: 0.9 },
      { w: "pricing", startMs: 22340, endMs: 22940, confidence: 0.91 },
      { w: "breakdown", startMs: 23030, endMs: 23790, confidence: 0.92 },
      { w: "by", startMs: 23880, endMs: 24050, confidence: 0.93 },
      { w: "Thursday", startMs: 24130, endMs: 24810, confidence: 0.96 },
    ],
    witness: "biased",
  },
  {
    utteranceId: "01a1c6e3-112e-7bc9-9802-5fe7f409b5cf",
    text: "Overall the pilot's going well. Their main concern is how long SSO setup takes.",
    confidence: 0.89,
    startMs: 25700,
    endMs: 31900,
    witness: "biased",
  },
  {
    utteranceId: "01a1c6e3-2952-7155-aed2-dfa3cd7d1e9d",
    text: "Maybe we could run a security workshop with their IT team next month.",
    confidence: 0.92,
    startMs: 32600,
    endMs: 38100,
    witness: "biased",
  },
  {
    utteranceId: "01a1c6e3-2fe2-7a5c-8954-a73ca8be730d",
    text: "That's it.",
    confidence: 0.97,
    startMs: 38900,
    endMs: 39800,
    witness: "biased",
  },
];

function utteranceAt(index: number): UtteranceFinalV2 {
  const utterance = DEMO_UTTERANCES[index];
  if (!utterance) throw new RangeError(`no demo utterance ${index}`);
  return utterance;
}

/** A UUIDv7-shaped turn id from a small number. */
export function demoTurnId(n: number): string {
  return `01a1c6e2-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** What the "model" drafts for each demo turn: one turn per utterance, as in the fixture. */
const DEMO_DRAFTS: readonly (readonly ToolProposal[])[] = [
  [
    {
      type: "contact",
      target: null,
      fields: {
        name: { value: "Dana Lee", quote: "Dana Lee" },
        title: { value: "VP of Operations", quote: "VP of Operations" },
        company: { value: "Acme Corp", quote: "Acme Corp" },
        email: null,
        phone: null,
      },
    },
  ],
  [],
  [
    {
      type: "deal_update",
      target: "Acme Corp - Security Platform",
      fields: {
        stage: { value: "proposal", quote: "move the deal to the proposal stage" },
        amount: null,
        closeDate: null,
      },
    },
  ],
  [
    {
      type: "task",
      target: "Acme Corp",
      fields: {
        title: {
          value: "Send Dana the pricing breakdown",
          quote: "send Dana the pricing breakdown",
        },
        dueDate: { value: "2026-11-12", quote: "by Thursday" },
      },
    },
  ],
  [
    {
      type: "note",
      target: "Acme Corp",
      fields: {
        body: {
          value: "The pilot is going well; their main concern is how long SSO setup takes.",
          quote: "the pilot's going well. Their main concern is how long SSO setup takes",
        },
      },
    },
  ],
  [
    {
      type: "commitment",
      target: "Acme Corp",
      fields: {
        text: {
          value: "Run a security workshop with Acme Corp's IT team",
          quote: "run a security workshop with their IT team",
        },
        counterpart: { value: "Acme Corp's IT team", quote: "their IT team" },
        dueDate: null,
      },
    },
  ],
  [],
];

/**
 * Groq's drafts differ in two quotes, to replay the lenient matches: a lowercase quote (case and
 * whitespace) in turn 1, and an added comma (punctuation at word edges) in turn 5.
 */
function groqDemoDrafts(turn: number): readonly ToolProposal[] {
  const drafts = DEMO_DRAFTS[turn] ?? [];
  if (turn === 0) {
    const [contact] = drafts;
    if (contact?.type !== "contact") return drafts;
    return [
      {
        ...contact,
        fields: {
          ...contact.fields,
          title: { value: "VP of Operations", quote: "vp of operations" },
        },
      },
    ];
  }
  if (turn === 4) {
    const [note] = drafts;
    if (note?.type !== "note") return drafts;
    return [
      {
        ...note,
        fields: {
          body: {
            value: note.fields.body.value,
            quote:
              "Overall, the pilot's going well. Their main concern is how long SSO setup takes",
          },
        },
      },
    ];
  }
  return drafts;
}

// --- Wire formats -----------------------------------------------------------------------------

/** A scripted HTTP response, in the provider's wire format. */
export interface ScriptedResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
}

interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly reasoning?: number;
}

/** An Anthropic Messages API response with one `submit_proposals` call. */
export function anthropicToolUse(input: unknown, tokens: Tokens, id = "01"): ScriptedResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      id: `msg_earshot_${id}`,
      type: "message",
      role: "assistant",
      model: LLM_MODELS.anthropic,
      content: [{ type: "tool_use", id: `toolu_earshot_${id}`, name: "submit_proposals", input }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

export function anthropicError(
  status: number,
  type: string,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): ScriptedResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: { type: "error", error: { type, message } },
  };
}

/** A Groq chat completion with one `submit_proposals` call; `args` is sent as given if a string. */
export function groqToolCall(args: unknown, tokens: Tokens, id = "01"): ScriptedResponse {
  return groqCompletion(
    {
      role: "assistant",
      reasoning: "The rep listed CRM changes; submitting them with quotes.",
      tool_calls: [
        {
          id: `fc_earshot_${id}`,
          type: "function",
          function: {
            name: "submit_proposals",
            arguments: typeof args === "string" ? args : JSON.stringify(args),
          },
        },
      ],
    },
    "tool_calls",
    tokens,
    id,
  );
}

export function groqText(text: string, tokens: Tokens, id = "01"): ScriptedResponse {
  return groqCompletion({ role: "assistant", content: text }, "stop", tokens, id);
}

function groqCompletion(
  message: Record<string, unknown>,
  finishReason: string,
  tokens: Tokens,
  id: string,
): ScriptedResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      id: `chatcmpl-earshot-${id}`,
      object: "chat.completion",
      created: 1_762_802_100,
      model: LLM_MODELS.groq,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: tokens.input,
        completion_tokens: tokens.output,
        total_tokens: tokens.input + tokens.output,
        completion_tokens_details: { reasoning_tokens: tokens.reasoning ?? 0 },
      },
    },
  };
}

export function groqError(
  status: number,
  error: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {},
): ScriptedResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body: { error } };
}

// --- Scenarios --------------------------------------------------------------------------------

export interface ScenarioTurn {
  readonly turnId: string;
  readonly utterances: readonly UtteranceFinalV2[];
  readonly entities: readonly EntityRef[];
  readonly callTime: string;
  readonly timeZone: string;
}

export interface Scenario {
  /** The cassette's name, unique per provider. */
  readonly name: string;
  readonly description: string;
  readonly provider: LlmProvider;
  readonly turn: ScenarioTurn;
  /** The responses, in the order the adapter's requests get them. */
  readonly responses: readonly ScriptedResponse[];
  /** What `runTurn` must make of them; generation fails otherwise. */
  readonly expect: { readonly outcome: TurnOutcome; readonly attempts: number };
}

function demoTurn(index: number): ScenarioTurn {
  return {
    turnId: demoTurnId(index + 1),
    utterances: [utteranceAt(index)],
    entities: DEMO_ENTITIES,
    callTime: DEMO_CALL_TIME,
    timeZone: DEMO_TIME_ZONE,
  };
}

/** Token counts per demo turn, roughly what the prompt and each answer would take. */
const DEMO_TOKENS: readonly Tokens[] = [
  { input: 1_492, output: 214, reasoning: 61 },
  { input: 1_471, output: 31, reasoning: 38 },
  { input: 1_486, output: 118, reasoning: 54 },
  { input: 1_474, output: 142, reasoning: 47 },
  { input: 1_481, output: 121, reasoning: 52 },
  { input: 1_480, output: 156, reasoning: 66 },
  { input: 1_463, output: 29, reasoning: 33 },
];

function demoScenarios(provider: LlmProvider): Scenario[] {
  return DEMO_UTTERANCES.map((_, index) => {
    const tokens = DEMO_TOKENS[index] ?? { input: 1_400, output: 100 };
    const proposals = provider === "groq" ? groqDemoDrafts(index) : (DEMO_DRAFTS[index] ?? []);
    const id = `demo_${index + 1}`;
    const response =
      provider === "anthropic"
        ? anthropicToolUse({ proposals }, { input: tokens.input, output: tokens.output }, id)
        : groqToolCall(
            { proposals },
            {
              input: tokens.input,
              output: tokens.output + (tokens.reasoning ?? 0),
              reasoning: tokens.reasoning ?? 0,
            },
            id,
          );
    return {
      name: `demo-turn-${index + 1}`,
      description: `Demo session, turn ${index + 1}: "${utteranceAt(index).text}"`,
      provider,
      turn: demoTurn(index),
      responses: [response],
      expect: { outcome: proposals.length > 0 ? "proposals" : "nothing_to_propose", attempts: 1 },
    };
  });
}

/** The task turn ("send Dana the pricing breakdown by Thursday"), which the edge cases reuse. */
const TASK_TURN_INDEX = 3;
const TASK = DEMO_DRAFTS[TASK_TURN_INDEX] ?? [];
const TASK_WITH_WEEKDAY_DATE: readonly ToolProposal[] = TASK.map((proposal) =>
  proposal.type === "task" && proposal.fields.dueDate
    ? {
        ...proposal,
        fields: { ...proposal.fields, dueDate: { ...proposal.fields.dueDate, value: "Thursday" } },
      }
    : proposal,
);
const TASK_MISSING_QUOTE = {
  proposals: [
    {
      type: "task",
      target: "Acme Corp",
      fields: { title: { value: "Send Dana the pricing breakdown" }, dueDate: null },
    },
  ],
};
const EDGE_TURN_ID = demoTurnId(0x100);
const EDGE_TOKENS: Tokens = { input: 1_474, output: 142, reasoning: 47 };
const RETRY_TOKENS: Tokens = { input: 1_538, output: 139, reasoning: 41 };

function edgeScenario(
  provider: LlmProvider,
  name: string,
  description: string,
  responses: readonly ScriptedResponse[],
  expect: Scenario["expect"],
): Scenario {
  return {
    name,
    description,
    provider,
    turn: { ...demoTurn(TASK_TURN_INDEX), turnId: EDGE_TURN_ID },
    responses,
    expect,
  };
}

function anthropicEdgeScenarios(): Scenario[] {
  const valid = anthropicToolUse({ proposals: TASK }, RETRY_TOKENS, "retry");
  const weekday = anthropicToolUse({ proposals: TASK_WITH_WEEKDAY_DATE }, EDGE_TOKENS, "weekday");
  const rateLimited = anthropicError(
    429,
    "rate_limit_error",
    "Number of request tokens has exceeded your per-minute rate limit.",
    { "retry-after": "1" },
  );
  const overloaded = anthropicError(529, "overloaded_error", "Overloaded");
  return [
    edgeScenario(
      "anthropic",
      "invalid-then-valid",
      "The first answer's due date is a weekday, not YYYY-MM-DD; the retry, told so, is valid.",
      [weekday, valid],
      { outcome: "proposals", attempts: 2 },
    ),
    edgeScenario(
      "anthropic",
      "invalid-twice",
      "Both answers give the due date as a weekday: invalid output.",
      [weekday, anthropicToolUse({ proposals: TASK_WITH_WEEKDAY_DATE }, RETRY_TOKENS, "again")],
      { outcome: "invalid_output", attempts: 2 },
    ),
    edgeScenario(
      "anthropic",
      "rate-limited-then-ok",
      "A 429 with retry-after: 1, then a valid answer.",
      [rateLimited, anthropicToolUse({ proposals: TASK }, EDGE_TOKENS, "after_429")],
      { outcome: "proposals", attempts: 2 },
    ),
    edgeScenario(
      "anthropic",
      "rate-limited-throughout",
      "429 on all three attempts: the turn ends rate limited.",
      [rateLimited, rateLimited, rateLimited],
      { outcome: "rate_limited", attempts: 3 },
    ),
    edgeScenario(
      "anthropic",
      "overloaded-throughout",
      "529 overloaded on all three attempts: a provider error.",
      [overloaded, overloaded, overloaded],
      { outcome: "provider_error", attempts: 3 },
    ),
    edgeScenario(
      "anthropic",
      "key-rejected",
      "401: the key is refused, and there's no retry.",
      [anthropicError(401, "authentication_error", "invalid x-api-key")],
      { outcome: "provider_error", attempts: 1 },
    ),
    edgeScenario(
      "anthropic",
      "bad-request",
      "400 invalid_request_error: a provider error, not retried.",
      [anthropicError(400, "invalid_request_error", "tools.0.input_schema: invalid schema")],
      { outcome: "provider_error", attempts: 1 },
    ),
    edgeScenario(
      "anthropic",
      "refusal",
      "stop_reason refusal with no tool call: the model declined, which isn't retried.",
      [
        {
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            id: "msg_earshot_refusal",
            type: "message",
            role: "assistant",
            model: LLM_MODELS.anthropic,
            content: [],
            stop_reason: "refusal",
            stop_sequence: null,
            usage: { input_tokens: 1_474, output_tokens: 3 },
          },
        },
      ],
      { outcome: "provider_error", attempts: 1 },
    ),
  ];
}

function groqEdgeScenarios(): Scenario[] {
  const valid = groqToolCall({ proposals: TASK }, RETRY_TOKENS, "retry");
  const missingQuote = groqToolCall(TASK_MISSING_QUOTE, EDGE_TOKENS, "missing_quote");
  const toolUseFailed = groqError(400, {
    message:
      "Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.",
    type: "invalid_request_error",
    code: "tool_use_failed",
    failed_generation: JSON.stringify({
      name: "submit_proposals",
      arguments: { proposals: TASK_WITH_WEEKDAY_DATE },
    }),
  });
  return [
    edgeScenario(
      "groq",
      "invalid-then-valid",
      "The first call leaves out a quote; the retry, told so, is valid.",
      [missingQuote, valid],
      { outcome: "proposals", attempts: 2 },
    ),
    edgeScenario(
      "groq",
      "tool-use-failed-then-valid",
      "Groq refuses the call itself (400 tool_use_failed, a weekday as the due date); the retry is valid.",
      [toolUseFailed, valid],
      { outcome: "proposals", attempts: 2 },
    ),
    edgeScenario(
      "groq",
      "text-then-valid",
      "The first answer is text with no tool call; the retry calls the tool.",
      [groqText("I'll submit the proposals now.", EDGE_TOKENS, "text"), valid],
      { outcome: "proposals", attempts: 2 },
    ),
    edgeScenario(
      "groq",
      "invalid-twice",
      "A missing quote, then a 400 tool_use_failed: invalid output.",
      [missingQuote, toolUseFailed],
      { outcome: "invalid_output", attempts: 2 },
    ),
    edgeScenario(
      "groq",
      "rate-limited-then-ok",
      "A 429 with retry-after: 1, then a valid answer.",
      [
        groqError(
          429,
          {
            message: "Rate limit reached for model `openai/gpt-oss-20b`. Please try again in 1s.",
            type: "tokens",
            code: "rate_limit_exceeded",
          },
          { "retry-after": "1" },
        ),
        groqToolCall({ proposals: TASK }, EDGE_TOKENS, "after_429"),
      ],
      { outcome: "proposals", attempts: 2 },
    ),
    edgeScenario(
      "groq",
      "unavailable-then-ok",
      "A 503, then a valid answer after a backoff.",
      [
        groqError(503, { message: "Service Unavailable", type: "internal_server_error" }),
        groqToolCall({ proposals: TASK }, EDGE_TOKENS, "after_503"),
      ],
      { outcome: "proposals", attempts: 2 },
    ),
    edgeScenario(
      "groq",
      "key-rejected",
      "401 invalid_api_key: the key is refused, and there's no retry.",
      [
        groqError(401, {
          message: "Invalid API Key",
          type: "invalid_request_error",
          code: "invalid_api_key",
        }),
      ],
      { outcome: "provider_error", attempts: 1 },
    ),
  ];
}

/** Every scenario, per provider, in cassette order. */
export const SCENARIOS: Readonly<Record<LlmProvider, readonly Scenario[]>> = {
  anthropic: [...demoScenarios("anthropic"), ...anthropicEdgeScenarios()],
  groq: [...demoScenarios("groq"), ...groqEdgeScenarios()],
};

export function scenario(provider: LlmProvider, name: string): Scenario {
  const found = SCENARIOS[provider].find((candidate) => candidate.name === name);
  if (!found) throw new RangeError(`no ${provider} scenario ${name}`);
  return found;
}
