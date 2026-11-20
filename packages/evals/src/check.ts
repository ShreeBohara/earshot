// How one eval run's turns compare with their script (spec WP11 step 4). The e2e test reads the
// session's events off its socket (every event the Durable Object commits is sent to the client),
// folds them into one result per push-to-talk press, and checks each against the script:
//
// - the outcome: `proposals`, or `nothing_to_propose` for a turn that expects none;
// - each proposal, in order: its type, its target, and its `KEY_FIELDS`, exactly.
//
// The target is the linker's decision (Phase 4, WP8): linked to the script's demo CRM record,
// asked about with that record among the candidates, a new record, or none, as `expectedDecision`
// reads the script. `proposal.created` v1 events read as their upcast would (ADR-0027).
//
// Free text (a note's body, a task's title) isn't compared: CI's cassettes reproduce it word for
// word, a live model won't, and Phase 4 scores it.
import type {
  EntityRef,
  EventEnvelope,
  ProposalTypeV2,
  TargetDecision,
  TurnOutcome,
} from "@earshot/core";
import { type DebriefTurn, type ExpectedField, expectedDecision, KEY_FIELDS } from "./schema";
import { DEMO_SESSION_ENTITIES, turnTranscript } from "./session";

/** The parts of a `proposal.created` payload an eval compares. */
export interface ActualProposal {
  readonly type: ProposalTypeV2;
  /** The linked record (`target.entityId`), or null. */
  readonly targetEntityId: string | null;
  /** What the linker decided. */
  readonly decision: TargetDecision;
  /** The records an "ask" offers, most likely first; null is "new". */
  readonly candidates: readonly (string | null)[];
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
        if (id) proposals.set(id, actualProposal(payload));
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

const DECISIONS: readonly TargetDecision[] = ["linked", "ask", "new", "none"];

/**
 * A `proposal.created` payload, v2 or v1, as an eval compares it. A v1 payload reads as the
 * upcaster has it: a `targetEntityId` is linked; none is new when flagged `new_entity`, else none.
 */
function actualProposal(payload: Payload): ActualProposal {
  const fields = (payload.fields ?? {}) as ActualProposal["fields"];
  const type = payload.type as ProposalTypeV2;
  const target = payload.target as Payload | null | undefined;
  if (target && typeof target === "object") {
    const decision = DECISIONS.find((candidate) => candidate === target.decision) ?? "none";
    const candidates = Array.isArray(target.candidates)
      ? target.candidates.map((candidate) => asString((candidate as Payload)?.entityId) ?? null)
      : [];
    return {
      type,
      targetEntityId: asString(target.entityId) ?? null,
      decision,
      candidates,
      fields,
    };
  }
  const targetEntityId = asString(payload.targetEntityId) ?? null;
  const flags = Array.isArray(payload.riskFlags) ? (payload.riskFlags as Payload[]) : [];
  const decision: TargetDecision =
    targetEntityId !== null
      ? "linked"
      : flags.some((flag) => flag?.kind === "new_entity")
        ? "new"
        : "none";
  return { type, targetEntityId, decision, candidates: [], fields };
}

function show(value: unknown): string {
  return value === undefined ? "missing" : JSON.stringify(value);
}

/** A target in words: the record's id, or what the linker did instead. */
function describeTarget(decision: TargetDecision, entityId: string | null): string {
  switch (decision) {
    case "linked":
      return entityId ?? "no record";
    case "ask":
      return "a question";
    case "new":
      return "a new record";
    case "none":
      return "no record";
  }
}

export interface TurnCheckOptions {
  /**
   * Compare the transcript with the script's text, word for word. The fake speech-to-text
   * adapter says exactly the script, so CI does; a live provider won't, so live runs don't.
   */
  readonly exactTranscript: boolean;
  /**
   * The session's entity ids mapped to the ground truth's dataset ids. A live session carries the
   * demo CRM's database UUIDs (`crm_entities.id`), while the scripts name records by dataset id
   * (`co_011`); without the map every correct target would count as wrong. Fake mode's scenario
   * already uses dataset ids, so it needs none. See `datasetIdsFor`.
   */
  readonly targetIds?: ReadonlyMap<string, string>;
}

/**
 * Maps a session's entities to the demo CRM's dataset ids, by kind and name: the session entity
 * named like a dataset record of the same kind is that record. Names the dataset doesn't hold, or
 * holds twice for one kind, are left out, so they're compared as they are.
 */
export function datasetIdsFor(sessionEntities: readonly EntityRef[]): Map<string, string> {
  const byName = new Map<string, string | null>();
  for (const entity of DEMO_SESSION_ENTITIES) {
    const key = `${entity.kind}:${entity.name}`;
    byName.set(key, byName.has(key) ? null : entity.id);
  }
  const ids = new Map<string, string>();
  for (const entity of sessionEntities) {
    const datasetId = byName.get(`${entity.kind}:${entity.name}`);
    if (datasetId) ids.set(entity.id, datasetId);
  }
  return ids;
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
    const toDataset = (id: string | null) =>
      id === null ? null : (options.targetIds?.get(id) ?? id);
    const decision = expectedDecision(expected);
    const target = toDataset(got.targetEntityId);
    if (got.decision !== decision || (decision === "linked" && target !== expected.target)) {
      problems.push(
        `${where} targets ${describeTarget(got.decision, target)}, not ${describeTarget(decision, expected.target)}`,
      );
    } else if (
      decision === "ask" &&
      expected.target !== null &&
      !got.candidates.map(toDataset).includes(expected.target)
    ) {
      problems.push(`${where} asks without offering ${expected.target}`);
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
