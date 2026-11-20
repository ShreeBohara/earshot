// The recap's test seams (Phase 5 WP10), for tests, evals, and the e2e edge Worker. Production code
// must not import them.
//
// - `recordRecap` runs a recap scenario through the real adapter and `runRecap` with a scripted
//   `fetch`, recording each request exactly as the adapter sends it: the recap cassettes are built
//   this way (`@earshot/evals`' recap eval, all 200 debriefs).
// - `scriptedRecapFetch` is a stand-in model for the runtime tests and the e2e Worker, whose
//   sessions say different things in each test, so no request-keyed cassette could answer them
//   all. It answers any `submit_recap` request from the transcript in that request: a headline
//   quoting its first sentence, a next step for each line where the rep says what they'll do, and
//   lens fields by a few keywords. It quotes the request's own words, so its recaps pass the checks
//   in code, as a well-behaved model's would; `mode` makes it misbehave on purpose.
import type { LlmProvider, RecapLensId, UtteranceFinalV2 } from "@earshot/core";
import type { RecapProposal } from "../recap/prompt";
import { createRecapper, type RecapResult, runRecap } from "../recap/run";
import { SUBMIT_RECAP, type SubmitRecapInput } from "../recap/schema";
import {
  type Cassette,
  type CassetteInteraction,
  type FetchInput,
  readCassetteRequest,
} from "./cassette";
import {
  anthropicError,
  anthropicToolUse,
  groqError,
  groqToolCall,
  SCENARIO_API_KEY,
  type ScriptedResponse,
  type Tokens,
} from "./scenarios";

/** A recap request's inputs: what `SessionDO` hands `runRecap` at the end of a session. */
export interface RecapScenarioInput {
  readonly utterances: readonly UtteranceFinalV2[];
  readonly proposals: readonly RecapProposal[];
  readonly lens: RecapLensId | null;
}

export interface RecapScenario {
  /** The cassette's name, unique per provider. */
  readonly name: string;
  readonly description: string;
  readonly provider: LlmProvider;
  readonly input: RecapScenarioInput;
  /** The responses, in the order the adapter's requests get them. */
  readonly responses: readonly ScriptedResponse[];
  /** What `runRecap` must make of them; generation fails otherwise. */
  readonly expect: {
    readonly outcome: RecapResult["recap"]["outcome"];
    readonly attempts: number;
  };
}

/** The model's answer to a recap request, in the provider's wire format. */
export function recapResponse(
  provider: LlmProvider,
  input: unknown,
  tokens: Tokens,
  id: string,
): ScriptedResponse {
  return provider === "anthropic"
    ? anthropicToolUse(input, { input: tokens.input, output: tokens.output }, id, SUBMIT_RECAP)
    : groqToolCall(
        input,
        {
          input: tokens.input,
          output: tokens.output + (tokens.reasoning ?? 0),
          reasoning: tokens.reasoning ?? 0,
        },
        id,
        SUBMIT_RECAP,
      );
}

/** Deterministic ids for generated runs. */
function counterIds(): () => string {
  let n = 0;
  return () => `01a1c6e7-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`;
}

/**
 * Runs one recap scenario and returns its cassette and the result. Throws if the run doesn't
 * match the scenario, so a generator can't record a cassette that replays differently.
 */
export async function recordRecap(
  scenario: RecapScenario,
): Promise<{ readonly cassette: Cassette; readonly result: RecapResult }> {
  const interactions: CassetteInteraction[] = [];
  let next = 0;
  const scripted = async (input: FetchInput, init?: RequestInit) => {
    const request = await readCassetteRequest(input, init);
    const response = scenario.responses[next++];
    if (!response) {
      throw new Error(`${scenario.provider}/${scenario.name} sent more requests than scripted`);
    }
    const recorded = {
      status: response.status,
      headers: response.headers ?? {},
      body: response.body,
    };
    interactions.push({
      key: request.key,
      request: { method: request.method, path: request.path, excerpt: request.excerpt },
      response: recorded,
    });
    const body = typeof recorded.body === "string" ? recorded.body : JSON.stringify(recorded.body);
    return new Response(body, { status: recorded.status, headers: new Headers(recorded.headers) });
  };
  const result = await runRecap({
    recapper: createRecapper({
      provider: scenario.provider,
      fetch: scripted as typeof fetch,
      now: () => 0,
    }),
    ...scenario.input,
    apiKey: SCENARIO_API_KEY,
    signal: new AbortController().signal,
    now: () => 0,
    sleep: async () => {},
    newId: counterIds(),
    random: () => 0.5,
  });
  const label = `${scenario.provider}/${scenario.name}`;
  if (next !== scenario.responses.length) {
    throw new Error(`${label} used ${next} of ${scenario.responses.length} scripted responses`);
  }
  if (result.recap.outcome !== scenario.expect.outcome) {
    throw new Error(`${label} ended ${result.recap.outcome}, not ${scenario.expect.outcome}`);
  }
  if (result.attempts !== scenario.expect.attempts) {
    throw new Error(`${label} made ${result.attempts} attempts, not ${scenario.expect.attempts}`);
  }
  return {
    cassette: { name: scenario.name, description: scenario.description, interactions },
    result,
  };
}

// ─── The scripted recap model ─────────────────────────────────────────────────────────────────

/**
 * How the scripted model behaves:
 * - `quotes`: answers well, from the request's own words;
 * - `unlocatable`: the same, plus a next step whose quote isn't in the transcript (dropped);
 * - `invalid`: no sentences, so validation fails twice;
 * - `error`: HTTP 500 to every request;
 * - `rate_limited`: HTTP 429, with a `retry-after` past the deadline;
 * - `slow`: answers well, after `delayMs` (abortably): past the deadline, a timeout.
 */
export type ScriptedRecapMode =
  | "quotes"
  | "unlocatable"
  | "invalid"
  | "error"
  | "rate_limited"
  | "slow";

export interface ScriptedRecapOptions {
  readonly provider: LlmProvider;
  readonly mode?: ScriptedRecapMode;
  /** For `slow`: how long to wait before answering. 20 s by default, past the 15 s deadline. */
  readonly delayMs?: number;
}

export interface ScriptedRecapFetch {
  (input: FetchInput, init?: RequestInit): Promise<Response>;
  /** Requests answered so far. */
  readonly requests: number;
}

/** The text of a message's content: a string, or text parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part as { text?: unknown }).text ?? "").join("");
  }
  return "";
}

/** The system prompt and the user message of an Anthropic or Groq request body. */
function readPrompt(body: Record<string, unknown>): { system: string; user: string } {
  const messages = (body.messages as { role?: string; content?: unknown }[] | undefined) ?? [];
  const system =
    textOf(body.system) +
    messages
      .filter((message) => message.role === "system")
      .map((message) => textOf(message.content))
      .join("\n");
  const user = textOf(messages.find((message) => message.role === "user")?.content);
  return { system, user };
}

/** The transcript lines between `<transcript>` and `</transcript>`. */
function transcriptLines(user: string): string[] {
  const start = user.indexOf("<transcript>\n");
  const end = user.indexOf("\n</transcript>");
  if (start < 0 || end < start) return [];
  return user
    .slice(start + "<transcript>\n".length, end)
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/** The lens field ids the system prompt lists (`- economic_buyer (Economic buyer): …`). */
function lensFields(system: string): string[] {
  const at = system.indexOf("\nLens: ");
  if (at < 0) return [];
  return system
    .slice(at)
    .split("\n")
    .flatMap((line) => {
      const match = /^- ([a-z][a-z0-9_]*) \(/.exec(line);
      return match?.[1] ? [match[1]] : [];
    });
}

/** The sentences of a line, each without its final period. */
function sentencesOf(line: string): string[] {
  return line
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.replace(/[.!?]+$/u, "").trim())
    .filter((sentence) => sentence !== "");
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Where the rep says what they'll do, and how the step reads in the third person. */
const STEP_MARKERS: readonly [RegExp, string][] = [
  [/\bI owe\b/u, "Send"],
  [/\bI need to\b/u, ""],
  [/\bI have to\b/u, ""],
  [/\bI'll\b/u, ""],
  [/\bI will\b/u, ""],
  [/\bI'm going to\b/u, ""],
];

/** Which sentences answer which lens fields, by a keyword or two. */
const LENS_KEYWORDS: Readonly<Record<string, RegExp>> = {
  economic_buyer: /\b(CFO|budget holder|signs? off|approves?)\b/iu,
  authority: /\b(CFO|decides|signs? off|approves?)\b/iu,
  decision_process: /\b(evaluation|decide|decision)\b/iu,
  decision: /\b(evaluation|decide|decision)\b/iu,
  identified_pain: /\b(concern|problem|pain|frustrat\w*)\b/iu,
  pain: /\b(concern|problem|pain|frustrat\w*)\b/iu,
  need: /\b(concern|problem|need|wants?)\b/iu,
  champion: /\b(main contact|champion)\b/iu,
  budget: /\b(budget|dollars|\$\d)/iu,
  timeline: /\b(next month|next quarter|by (?:Monday|Tuesday|Wednesday|Thursday|Friday))\b/iu,
  critical_event: /\b(deadline|renewal|next quarter)\b/iu,
};

/** The scripted model's recap of a transcript: what a careful model would write from it. */
export function scriptedRecapInput(
  lines: readonly string[],
  fields: readonly string[],
  mode: ScriptedRecapMode = "quotes",
): SubmitRecapInput {
  if (mode === "invalid") return { sentences: [], lens: null };
  const sentences: SubmitRecapInput["sentences"] = [];
  const first = lines.flatMap(sentencesOf)[0];
  if (first) sentences.push({ kind: "headline", text: `${capitalize(first)}.`, quotes: [first] });
  for (const line of lines) {
    for (const sentence of sentencesOf(line)) {
      for (const [marker, verb] of STEP_MARKERS) {
        const match = marker.exec(sentence);
        if (!match) continue;
        const rest = sentence.slice(match.index + match[0].length).trim();
        if (rest === "" || sentences.length >= 11) break;
        sentences.push({
          kind: "next_step",
          text: `${capitalize(verb ? `${verb} ${rest}` : rest)}.`,
          quotes: [sentence.slice(match.index)],
        });
        break;
      }
    }
  }
  if (mode === "unlocatable") {
    sentences.push({
      kind: "next_step",
      text: "Send the signed contract by Monday.",
      quotes: ["they'll sign the contract by Monday"],
    });
  }
  const all = lines.flatMap(sentencesOf);
  const lens =
    fields.length === 0
      ? null
      : {
          fields: fields.map((field) => {
            const keyword = LENS_KEYWORDS[field];
            const quote = keyword ? (all.find((sentence) => keyword.test(sentence)) ?? null) : null;
            return { field, quote };
          }),
        };
  return { sentences, lens };
}

function abortableDelay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** A `fetch` that answers recap requests as `ScriptedRecapOptions` say; nothing reaches a network. */
export function scriptedRecapFetch(options: ScriptedRecapOptions): ScriptedRecapFetch {
  const mode = options.mode ?? "quotes";
  let requests = 0;
  const answer = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const signal = init?.signal ?? request.signal;
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    requests += 1;
    const respond = (scripted: ScriptedResponse) =>
      new Response(
        typeof scripted.body === "string" ? scripted.body : JSON.stringify(scripted.body),
        { status: scripted.status, headers: new Headers(scripted.headers ?? {}) },
      );
    if (mode === "error") {
      return respond(
        options.provider === "anthropic"
          ? anthropicError(500, "api_error", "Internal server error")
          : groqError(500, { message: "Internal server error", type: "internal_server_error" }),
      );
    }
    if (mode === "rate_limited") {
      const headers = { "retry-after": "60" };
      return respond(
        options.provider === "anthropic"
          ? anthropicError(429, "rate_limit_error", "Rate limited", headers)
          : groqError(429, { message: "Rate limited", type: "rate_limit_exceeded" }, headers),
      );
    }
    if (mode === "slow") await abortableDelay(options.delayMs ?? 20_000, signal);
    const prompt = readPrompt(body);
    const output = scriptedRecapInput(
      transcriptLines(prompt.user),
      lensFields(prompt.system),
      mode,
    );
    const tokens = {
      input: Math.ceil((prompt.system.length + prompt.user.length) / 4) + 400,
      output: 60 + 40 * output.sentences.length,
      reasoning: 120,
    };
    return respond(recapResponse(options.provider, output, tokens, `recap_${requests}`));
  };
  return Object.defineProperties(answer, {
    requests: { get: () => requests },
  }) as ScriptedRecapFetch;
}
