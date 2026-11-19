// How one eval run's turns compare with their script (spec WP11 step 4). The e2e test reads the
// session's events off its socket (every event the Durable Object commits is sent to the client),
// folds them into one result per push-to-talk press, and checks each against the script:
//
// - the outcome: `proposals`, or `nothing_to_propose` for a turn that expects none;
// - each proposal, in order: its type, its demo CRM target id, and its `KEY_FIELDS`, exactly.
//
// Free text (a note's body, a task's title) isn't compared: CI's cassettes reproduce it word for
// word, a live model won't, and Phase 4 scores it.
import type { EventEnvelope, ProposalType, TurnOutcome } from "@earshot/core";
import { type DebriefTurn, type ExpectedField, KEY_FIELDS } from "./schema";
import { turnTranscript } from "./session";

/** The parts of a `proposal.created` payload an eval compares. */
export interface ActualProposal {
  readonly type: ProposalType;
  readonly targetEntityId: string | null;
  readonly fields: Readonly<Record<string, { readonly value: unknown }>>;
}

/** `turn.measured`'s four stages, in ms on the client's clock. */
export interface TurnLatency {
  readonly totalMs: number;
  readonly speechEndToFinalMs: number;
  readonly finalToProposalMs: number;
  readonly proposalToPaintMs: number;
}

/** One press, as the session's events tell it. */
export interface ActualTurn {
  readonly turnId: string;
  /** The turn's finals, joined; null if it had none. */
  readonly transcript: string | null;
  readonly outcome: TurnOutcome;
  readonly proposals: readonly ActualProposal[];
  /** Null for a turn with no proposal card, which sends no marks. */
  readonly latency: TurnLatency | null;
}

type Payload = Record<string, unknown>;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const asNumber = (value: unknown): number => (typeof value === "number" ? value : Number.NaN);

/**
 * A session's turns, in the order they completed, from its events (deduplicated by id, so a
 * replay after a reconnect counts once). Turns that haven't completed yet aren't included.
 */
export function turnsFromEvents(events: Iterable<EventEnvelope>): ActualTurn[] {
  const byId = new Map<string, EventEnvelope>();
  for (const event of events) byId.set(event.id, event);
  const ordered = [...byId.values()].sort((a, b) => a.seq - b.seq);
  const texts = new Map<string, string>();
  const proposals = new Map<string, ActualProposal>();
  const latencies = new Map<string, TurnLatency>();
  const completed: Payload[] = [];
  for (const event of ordered) {
    const payload = event.payload as Payload;
    switch (event.type) {
      case "utterance.final": {
        const id = asString(payload.utteranceId);
        const text = asString(payload.text);
        if (id && text !== undefined) texts.set(id, text);
        break;
      }
      case "proposal.created": {
        const id = asString(payload.proposalId);
        if (id) {
          proposals.set(id, {
            type: payload.type as ProposalType,
            targetEntityId: asString(payload.targetEntityId) ?? null,
            fields: (payload.fields ?? {}) as ActualProposal["fields"],
          });
        }
        break;
      }
      case "turn.measured": {
        const id = asString(payload.turnId);
        if (id) {
          latencies.set(id, {
            totalMs: asNumber(payload.totalMs),
            speechEndToFinalMs: asNumber(payload.speechEndToFinalMs),
            finalToProposalMs: asNumber(payload.finalToProposalMs),
            proposalToPaintMs: asNumber(payload.proposalToPaintMs),
          });
        }
        break;
      }
      case "turn.completed":
        completed.push(payload);
        break;
    }
  }
  return completed.map((payload) => {
    const turnId = asString(payload.turnId) ?? "";
    const heard = asStrings(payload.utteranceIds)
      .map((id) => texts.get(id))
      .filter((text): text is string => text !== undefined);
    return {
      turnId,
      transcript: heard.length > 0 ? heard.join(" ") : null,
      outcome: payload.outcome as TurnOutcome,
      proposals: asStrings(payload.proposalIds)
        .map((id) => proposals.get(id))
        .filter((proposal): proposal is ActualProposal => proposal !== undefined),
      latency: latencies.get(turnId) ?? null,
    };
  });
}

function show(value: unknown): string {
  return value === undefined ? "missing" : JSON.stringify(value);
}

export interface TurnCheckOptions {
  /**
   * Compare the transcript with the script's text, word for word. The fake speech-to-text
   * adapter says exactly the script, so CI does; a live provider won't, so live runs don't.
   */
  readonly exactTranscript: boolean;
}

/** What's wrong with one turn, in words; empty when it went as the script says. */
export function turnProblems(
  turn: DebriefTurn,
  actual: ActualTurn | undefined,
  options: TurnCheckOptions,
): string[] {
  if (!actual) return ["never completed"];
  const problems: string[] = [];
  const said = turnTranscript(turn);
  if (options.exactTranscript && actual.transcript !== said) {
    problems.push(`heard ${show(actual.transcript)}, not ${show(said)}`);
  }
  const outcome: TurnOutcome = turn.expect.length > 0 ? "proposals" : "nothing_to_propose";
  if (actual.outcome !== outcome) problems.push(`ended as ${actual.outcome}, not ${outcome}`);
  if (actual.proposals.length !== turn.expect.length) {
    problems.push(`made ${actual.proposals.length} proposals, not ${turn.expect.length}`);
  }
  turn.expect.forEach((expected, n) => {
    const got = actual.proposals[n];
    if (!got) return;
    const where = `proposal ${n + 1}`;
    if (got.type !== expected.type) {
      problems.push(`${where} is a ${got.type}, not a ${expected.type}`);
      return;
    }
    if (got.targetEntityId !== expected.target) {
      problems.push(
        `${where} targets ${got.targetEntityId ?? "a new record"}, not ${expected.target ?? "a new record"}`,
      );
    }
    const fields = expected.fields as Readonly<Record<string, ExpectedField | undefined>>;
    for (const name of KEY_FIELDS[expected.type]) {
      const want = fields[name]?.value;
      const value = got.fields[name]?.value;
      if (value !== want) problems.push(`${where} ${name} is ${show(value)}, not ${show(want)}`);
    }
  });
  if (actual.outcome === "proposals" && actual.latency === null) {
    problems.push("has no turn.measured, so its latency is unknown");
  }
  return problems;
}
