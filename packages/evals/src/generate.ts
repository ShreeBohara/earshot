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
  type LinkSession,
  LLM_MODELS,
  runTurn,
  type ToolProposal,
  type ToolTarget,
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
import { buildLinkIndex, type LinkIndex } from "@earshot/understanding/link";
import { DEBRIEFS } from "./debriefs";
import {
  type DebriefScript,
  type ExpectedField,
  type ExpectedProposal,
  heardText,
  namedOf,
} from "./schema";
import { DEMO_SESSION_ENTITIES, demoEntity, sessionContext, turnTranscript } from "./session";

export const EVAL_PROVIDERS: readonly LlmProvider[] = ["anthropic", "groq"];

/** A UUIDv7-shaped id from a script number, a turn number, and a kind (1 utterance, 2 turn). */
function evalId(script: DebriefScript, turnIndex: number, kind: number): string {
  const n = Number(script.id.slice(1));
  const tail = `${kind}${n.toString(16).padStart(5, "0")}${(turnIndex + 1).toString(16).padStart(6, "0")}`;
  return `01a1c6e5-0000-7000-8000-${tail}`;
}

/**
 * A turn's final as the fake adapter delivers it: one utterance with what the production stream
 * heard (`heard.biased`, the turn's text unless the script says otherwise). Only the text reaches
 * the request, so the timing here is a plain stand-in.
 */
export function evalUtterance(script: DebriefScript, turnIndex: number): UtteranceFinalV2 {
  const turn = script.turns[turnIndex];
  if (!turn) throw new RangeError(`${script.id} has no turn ${turnIndex + 1}`);
  const startMs = turnIndex * 15_000;
  return {
    utteranceId: evalId(script, turnIndex, 1),
    text: turnTranscript({ text: heardText(turn, "biased") }),
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

/** The demo CRM's link index, which every eval session shares: built once, on first use. */
let evalIndex: LinkIndex | undefined;
function demoIndex(): LinkIndex {
  evalIndex ??= buildLinkIndex(DEMO_SESSION_ENTITIES);
  return evalIndex;
}

/** A script's session as the linker sees it at its start: the demo CRM, its account, no links. */
export function evalSession(script: DebriefScript): LinkSession {
  return { index: demoIndex(), focusEntityId: script.focusEntityId ?? null, recent: [] };
}

/**
 * The target as tool schema v2 drafts it: the words the rep named the record with, exactly as
 * said, their kind, and the company said with them; null when the turn names no record.
 */
function toolTarget(expected: ExpectedProposal): ToolTarget | null {
  const named = namedOf(expected);
  if (named === null) return null;
  const id = expected.target.id;
  const kind = named.kind ?? (id === null ? null : demoEntity(id).kind);
  if (kind === null) throw new TypeError("a named record that isn't in the CRM needs a kind");
  return {
    quote: named.quote,
    kind,
    company: named.company === undefined ? null : { quote: named.company },
  };
}

/**
 * The proposal as the model would draft it with tool schema v2: the words that named its record
 * (a contact's record is its `name`), and every field of the type present, `null` when the rep
 * didn't mention it.
 */
export function toolProposal(expected: ExpectedProposal): ToolProposal {
  const target = toolTarget(expected);
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
    case "meeting":
      return {
        type: "meeting",
        target,
        fields: {
          title: text(expected.fields.title),
          date: textOrNull(expected.fields.date),
          time: textOrNull(expected.fields.time),
          attendees: textOrNull(expected.fields.attendees),
        },
      };
  }
}

/**
 * Plausible token counts, not measurements: prompt v2 and the tool schema are about 2,000 tokens,
 * the 250-record list Phase 3 sent (about 1,600) gone, plus the transcript; the answer grows with
 * its proposals.
 */
function tokens(script: DebriefScript, turnIndex: number, proposals: number) {
  const transcript = script.turns[turnIndex]?.text ?? "";
  return {
    input: 2_000 + Math.ceil(transcript.length / 4),
    output: 24 + 64 * proposals,
    reasoning: 36 + 12 * proposals,
  };
}

/** The model's answer to one turn, in the provider's wire format: the proposals as its tool input. */
export function evalResponse(
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
      session: evalSession(script),
      callTime: context.callTime,
      timeZone: context.timeZone,
    },
    responses: [evalResponse(provider, script, turnIndex, proposals)],
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
 * `SessionDO` does in an e2e run, each turn seeing the links the turns before it made, and returns
 * each turn's result plus whatever the cassette couldn't answer. The tests use it to check the
 * cassettes yield the scripts' proposals.
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
  let session = evalSession(script);
  for (let index = 0; index < script.turns.length; index++) {
    const result = await runTurn({
      extractor,
      turnId: evalTurnId(script, index),
      utterances: [evalUtterance(script, index)],
      session,
      callTime: context.callTime,
      timeZone: context.timeZone,
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
      sleep: async () => {},
      newId: () => `01a1c6e6-0000-7000-8000-${(++ids).toString(16).padStart(12, "0")}`,
      random: () => 0.5,
    });
    results.push(result);
    session = { ...session, recent: result.recent };
  }
  return { results, misses: fetch.misses.length, unplayed: fetch.remaining() };
}
