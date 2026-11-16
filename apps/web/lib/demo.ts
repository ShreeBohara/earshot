// The replay demo's view model: a recorded session log, replayed with the same event store and
// projections production uses (@earshot/events), shaped for reading.
import type { FieldValue } from "@earshot/core";
import {
  defaultProjections,
  fromJsonl,
  type ProposalStatus,
  replay,
  type SessionView,
} from "@earshot/events";

export type DemoUtterance = {
  id: string;
  seq: number;
  /** Offset from the start of the session, `m:ss`. */
  at: string;
  witness: string;
  text: string;
  confidence: number;
};

export type DemoField = {
  name: string;
  value: FieldValue;
  /** The reviewer's value, when they edited this field. */
  editedTo?: FieldValue;
  evidence: {
    utteranceId: string;
    /** The words the value came from: the evidence span of the utterance's text. */
    quote: string;
    at: string;
    confidence: number;
  } | null;
};

export type DemoProposal = {
  id: string;
  seq: number;
  type: string;
  status: ProposalStatus;
  riskFlags: { kind: string; field?: string | undefined }[];
  fields: DemoField[];
};

export type DemoEvent = { seq: number; type: string; at: string; schemaVersion: number };

export type Demo = {
  session: SessionView;
  utterances: DemoUtterance[];
  proposals: DemoProposal[];
  events: DemoEvent[];
};

/** `m:ss` (or `m:ss.s` with tenths) from milliseconds. */
export function clock(ms: number, tenths = false): string {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  const text = tenths
    ? seconds.toFixed(1).padStart(4, "0")
    : String(Math.floor(seconds)).padStart(2, "0");
  return `${minutes}:${text}`;
}

/** Replays a JSONL session log into the demo's view model. Deterministic: same file, same view. */
export function buildDemo(jsonl: string): Demo {
  const events = fromJsonl(jsonl);
  const state = replay(events, defaultProjections);
  if (!state.session) throw new Error("The demo log has no session.started event");
  const startedAt = Date.parse(state.session.startedAt);
  const byId = new Map(state.utterances.map((utterance) => [utterance.utteranceId, utterance]));

  return {
    session: state.session,
    utterances: state.utterances.map((utterance) => ({
      id: utterance.utteranceId,
      seq: utterance.seq,
      at: clock(utterance.startMs),
      witness: utterance.witness,
      text: utterance.text,
      confidence: utterance.confidence,
    })),
    proposals: state.proposals.map((proposal) => ({
      id: proposal.proposalId,
      seq: proposal.seq,
      type: proposal.type,
      status: proposal.status,
      riskFlags: proposal.riskFlags,
      fields: Object.entries(proposal.fields).map(([name, field]) => {
        const source = byId.get(field.evidence.utteranceId);
        const edit = proposal.review?.editDiff?.[name];
        return {
          name,
          value: field.value,
          ...(edit ? { editedTo: edit.after } : {}),
          evidence: source
            ? {
                utteranceId: source.utteranceId,
                quote: source.text.slice(field.evidence.span[0], field.evidence.span[1]),
                at: clock(field.evidence.audioMs[0], true),
                confidence: field.evidence.confidence,
              }
            : null,
        };
      }),
    })),
    events: events.map((event) => ({
      seq: event.seq,
      type: event.type,
      schemaVersion: event.schemaVersion,
      at: clock(Date.parse(event.ts) - startedAt, true),
    })),
  };
}
