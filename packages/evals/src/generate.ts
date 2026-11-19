// Builds the eval cassettes (spec WP11 step 7): for every script and turn, the response each LLM
// adapter would get if the model drafted exactly the ground truth, in that provider's wire format
// (Anthropic tool use, Groq's OpenAI-style tool calls). Each turn runs through the real adapter
// and `runTurn` with `@earshot/agent/testing`'s `recordScenario`, so the recorded requests are
// byte for byte what the adapters send, in WP5's cassette format. No network is involved.
//
// scripts/gen-cassettes.ts writes the result to cassettes/<provider>.json; a test regenerates it
// in memory and fails on any drift, and another replays every turn and checks the proposals that
// come out against the scripts.
//
// Production code must not import this module: it pulls in the AI SDK through the adapters.
import {
  createProposalExtractor,
  LLM_MODELS,
  runTurn,
  type ToolProposal,
  type TurnResult,
} from "@earshot/agent";
import {
  anthropicToolUse,
  CASSETTE_VERSION,
  type Cassette,
  type CassetteFile,
  createCassetteFetch,
  groqToolCall,
  recordScenario,
  SCENARIO_API_KEY,
  type Scenario,
  type ScriptedResponse,
} from "@earshot/agent/testing";
import type { LlmProvider, UtteranceFinalV2 } from "@earshot/core";
import { DEBRIEFS } from "./debriefs";
import type { DebriefScript, ExpectedField, ExpectedProposal } from "./schema";
import { demoEntity, sessionContext, turnTranscript } from "./session";

export const EVAL_PROVIDERS: readonly LlmProvider[] = ["anthropic", "groq"];

/** A UUIDv7-shaped id from a script number, a turn number, and a kind (1 utterance, 2 turn). */
function evalId(script: DebriefScript, turnIndex: number, kind: number): string {
  const n = Number(script.id.slice(1));
  const tail = `${kind}${n.toString(16).padStart(5, "0")}${(turnIndex + 1).toString(16).padStart(6, "0")}`;
  return `01a1c6e5-0000-7000-8000-${tail}`;
}

/**
 * A turn's final as the fake adapter delivers it: one utterance with the turn's text. Only the
 * text reaches the request, so the timing here is a plain stand-in.
 */
export function evalUtterance(script: DebriefScript, turnIndex: number): UtteranceFinalV2 {
  const turn = script.turns[turnIndex];
  if (!turn) throw new RangeError(`${script.id} has no turn ${turnIndex + 1}`);
  const startMs = turnIndex * 15_000;
  return {
    utteranceId: evalId(script, turnIndex, 1),
    text: turnTranscript(turn),
    confidence: 0.95,
    startMs,
    endMs: startMs + Math.max(1, turn.text.split(" ").length) * 400,
    witness: "biased",
  };
}

export function evalTurnId(script: DebriefScript, turnIndex: number): string {
  return evalId(script, turnIndex, 2);
}

function text(value: ExpectedField): { value: string; quote: string } {
  if (typeof value.value !== "string") throw new TypeError("expected a text field");
  return { value: value.value, quote: value.quote };
}

function textOrNull(value: ExpectedField | undefined): { value: string; quote: string } | null {
  return value ? text(value) : null;
}

function amountOrNull(value: ExpectedField | undefined): { value: number; quote: string } | null {
  if (!value) return null;
  if (typeof value.value !== "number") throw new TypeError("expected an amount");
  return { value: value.value, quote: value.quote };
}

/**
 * The proposal as the model would draft it: the target by its exact name in the session's
 * entities, and every field of the type present, `null` when the rep didn't mention it.
 */
export function toolProposal(expected: ExpectedProposal): ToolProposal {
  const target = expected.target === null ? null : demoEntity(expected.target).name;
  switch (expected.type) {
    case "note":
      return { type: "note", target, fields: { body: text(expected.fields.body) } };
    case "task":
      return {
        type: "task",
        target,
        fields: {
          title: text(expected.fields.title),
          dueDate: textOrNull(expected.fields.dueDate),
        },
      };
    case "contact":
      return {
        type: "contact",
        target,
        fields: {
          name: text(expected.fields.name),
          title: textOrNull(expected.fields.title),
          company: textOrNull(expected.fields.company),
          email: textOrNull(expected.fields.email),
          phone: textOrNull(expected.fields.phone),
        },
      };
    case "deal_update":
      return {
        type: "deal_update",
        target,
        fields: {
          stage: textOrNull(expected.fields.stage),
          amount: amountOrNull(expected.fields.amount),
          closeDate: textOrNull(expected.fields.closeDate),
        },
      };
    case "commitment":
      return {
        type: "commitment",
        target,
        fields: {
          text: text(expected.fields.text),
          counterpart: textOrNull(expected.fields.counterpart),
          dueDate: textOrNull(expected.fields.dueDate),
        },
      };
  }
}

/**
 * Plausible token counts, not measurements: the system prompt with all 250 demo entities and the
 * tool schema is about 3,600 tokens, plus the transcript; the answer grows with its proposals.
 */
function tokens(script: DebriefScript, turnIndex: number, proposals: number) {
  const transcript = script.turns[turnIndex]?.text ?? "";
  return {
    input: 3_600 + Math.ceil(transcript.length / 4),
    output: 24 + 64 * proposals,
    reasoning: 36 + 12 * proposals,
  };
}

function response(
  provider: LlmProvider,
  script: DebriefScript,
  turnIndex: number,
  proposals: readonly ToolProposal[],
): ScriptedResponse {
  const id = `${script.id}_t${turnIndex + 1}`;
  const count = tokens(script, turnIndex, proposals.length);
  return provider === "anthropic"
    ? anthropicToolUse({ proposals }, { input: count.input, output: count.output }, id)
    : groqToolCall(
        { proposals },
        {
          input: count.input,
          output: count.output + count.reasoning,
          reasoning: count.reasoning,
        },
        id,
      );
}

/** One turn as a WP5 scenario: its session, its utterance, and the ground truth as the answer. */
export function evalScenario(
  provider: LlmProvider,
  script: DebriefScript,
  turnIndex: number,
): Scenario {
  const turn = script.turns[turnIndex];
  if (!turn) throw new RangeError(`${script.id} has no turn ${turnIndex + 1}`);
  const proposals = turn.expect.map(toolProposal);
  const context = sessionContext(script);
  return {
    name: `${script.id}-turn-${turnIndex + 1}`,
    description: `${script.id}, turn ${turnIndex + 1}: "${turnTranscript(turn)}"`,
    provider,
    turn: {
      turnId: evalTurnId(script, turnIndex),
      utterances: [evalUtterance(script, turnIndex)],
      entities: context.entities,
      callTime: context.callTime,
      timeZone: context.timeZone,
    },
    responses: [response(provider, script, turnIndex, proposals)],
    expect: { outcome: proposals.length > 0 ? "proposals" : "nothing_to_propose", attempts: 1 },
  };
}

/** A script's cassette for one provider: one interaction per turn, in turn order. */
export async function scriptCassette(
  provider: LlmProvider,
  script: DebriefScript,
): Promise<Cassette> {
  const interactions = [];
  for (let index = 0; index < script.turns.length; index++) {
    const recorded = await recordScenario(evalScenario(provider, script, index));
    interactions.push(...recorded.interactions);
  }
  return { name: script.id, description: script.title, interactions };
}

/** Every provider's eval cassettes, as cassettes/<provider>.json should hold them. */
export async function generateEvalCassettes(
  scripts: readonly DebriefScript[] = DEBRIEFS,
): Promise<Record<LlmProvider, CassetteFile>> {
  const build = async (provider: LlmProvider): Promise<CassetteFile> => {
    const cassettes: Record<string, Cassette> = {};
    for (const script of scripts) cassettes[script.id] = await scriptCassette(provider, script);
    return {
      version: CASSETTE_VERSION,
      provider,
      model: LLM_MODELS[provider],
      source: "hand-made",
      cassettes,
    };
  };
  return { anthropic: await build("anthropic"), groq: await build("groq") };
}

/**
 * Replays a script's cassette through the real adapter and `runTurn`, turn by turn, as
 * `SessionDO` will in an e2e run, and returns each turn's result plus whatever the cassette
 * couldn't answer. The tests use it to check the cassettes yield the scripts' proposals.
 */
export async function replayScript(
  provider: LlmProvider,
  script: DebriefScript,
  cassette: Cassette,
): Promise<{ results: TurnResult[]; misses: number; unplayed: number }> {
  const fetch = createCassetteFetch(cassette);
  const extractor = createProposalExtractor({ provider, fetch: fetch as typeof globalThis.fetch });
  const context = sessionContext(script);
  const results: TurnResult[] = [];
  let ids = 0;
  for (let index = 0; index < script.turns.length; index++) {
    results.push(
      await runTurn({
        extractor,
        turnId: evalTurnId(script, index),
        utterances: [evalUtterance(script, index)],
        entities: context.entities,
        callTime: context.callTime,
        timeZone: context.timeZone,
        apiKey: SCENARIO_API_KEY,
        signal: new AbortController().signal,
        sleep: async () => {},
        newId: () => `01a1c6e6-0000-7000-8000-${(++ids).toString(16).padStart(12, "0")}`,
        random: () => 0.5,
      }),
    );
  }
  return { results, misses: fetch.misses.length, unplayed: fetch.remaining() };
}
