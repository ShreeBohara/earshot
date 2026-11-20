// A scripted model for the smoke eval's tests: a `fetch` that answers a script's turns in the
// provider's wire format, with the drafts and the usage a test chooses, and records what was
// asked. It finds each request's turn by the transcript the request carries, so the extractor's
// retries get the same turn. Nothing reaches a network.
import type { ToolProposal } from "@earshot/agent";
import { anthropicError } from "@earshot/agent/testing";
import type { DebriefScript } from "../src/schema";
import { LIVE_LABELS } from "../src/smoke";
import { understandingDrafts, understandingUtterances } from "../src/understanding";

export interface ScriptedUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export interface ScriptedModelOptions {
  /**
   * A turn's tool input proposals (any JSON, so a test can send invalid ones), by attempt (1 for
   * the turn's first request). The ground truth by default: a perfect model.
   */
  readonly drafts?: (script: DebriefScript, turnIndex: number, attempt: number) => unknown[];
  /** What each answer reports; 2,000 in and 200 out by default. */
  readonly usage?: ScriptedUsage;
  /** Answer every request with this HTTP status instead (Anthropic's error body). */
  readonly status?: number;
  /** Throw this instead of answering. */
  readonly throws?: () => unknown;
}

export interface ScriptedModel {
  readonly fetchFor: (script: DebriefScript) => typeof globalThis.fetch;
  /** Every request's parsed body, in order, across scripts. */
  readonly requests: Record<string, unknown>[];
}

/** A perfect model's drafts: each turn's ground truth, as the cassettes' generator writes them. */
export function perfectDrafts(script: DebriefScript, turnIndex: number): ToolProposal[] {
  return understandingDrafts(script, turnIndex, LIVE_LABELS);
}

/** An Anthropic Messages response with one `submit_proposals` call and the given usage. */
function anthropicAnswer(proposals: readonly unknown[], usage: ScriptedUsage, id: string) {
  return {
    id: `msg_smoke_${id}`,
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [
      { type: "tool_use", id: `toolu_smoke_${id}`, name: "submit_proposals", input: { proposals } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_creation_input_tokens: usage.cacheWrite ?? 0,
      cache_read_input_tokens: usage.cacheRead ?? 0,
    },
  };
}

/** The user message's text in an Anthropic request body. */
function userText(body: Record<string, unknown>): string {
  const messages = body.messages as { content: unknown }[] | undefined;
  const content = messages?.[0]?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((part) => (part as { text?: string }).text ?? "").join("");
  return "";
}

/** A scripted Anthropic model (the smoke eval's default provider). */
export function scriptedAnthropic(options: ScriptedModelOptions = {}): ScriptedModel {
  const requests: Record<string, unknown>[] = [];
  const drafts = options.drafts ?? perfectDrafts;
  const usage = options.usage ?? { input: 2_000, output: 200 };
  return {
    requests,
    fetchFor: (script) => {
      const attempts = new Map<number, number>();
      return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        requests.push(body);
        if (options.throws) throw options.throws();
        if (options.status !== undefined) {
          const error = anthropicError(options.status, "api_error", "scripted failure");
          return new Response(JSON.stringify(error.body), {
            status: error.status,
            headers: error.headers,
          });
        }
        const said = userText(body);
        const index = script.turns.findIndex((_, at) =>
          said.includes(understandingUtterances(script, at).biased.text),
        );
        if (index < 0) throw new Error(`no turn of ${script.id} in the request`);
        const attempt = (attempts.get(index) ?? 0) + 1;
        attempts.set(index, attempt);
        const answer = anthropicAnswer(
          drafts(script, index, attempt),
          usage,
          `${script.id}_${index}_${attempt}`,
        );
        return new Response(JSON.stringify(answer), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof globalThis.fetch;
    },
  };
}

/** A clock that only moves when something waits on it. */
export function instantClock() {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
    },
  };
}
