// Story data for the capture components: a short debrief about Acme Corp, folded through a real
// SessionStore so the panels get exactly what the live screen gets. Stories only.
import type { EntityRef } from "@earshot/core";
import type { ProposalView } from "@earshot/events";
import { SessionStore } from "@earshot/voice/session";
import type { ActivityRow } from "@/lib/capture/activity";

export const SESSION_ID = "01a1c6e2-9320-7deb-a57a-ba62dc02df02";

export const ENTITIES: readonly EntityRef[] = [
  {
    id: "01a0f831-ac00-75a0-a2b2-cb79eb1835bf",
    kind: "company",
    name: "Acme Corp",
    aliases: ["Acme"],
  },
  {
    id: "01a0f831-afe8-7fff-84cf-71639949085b",
    kind: "deal",
    name: "Acme Corp - Security Platform",
    aliases: [],
  },
  { id: "ct_145", kind: "contact", name: "Dana Li", aliases: [] },
];

const LINES = [
  "Just got out of the meeting with Acme Corp. Met Dana Lee, their new VP of Operations.",
  "They want a revised proposal with the security add-on, so move the deal to the proposal stage.",
  "I need to send Dana the pricing breakdown by Thursday.",
] as const;

const UTTERANCE_IDS = [
  "01a1c6e2-af90-75b5-a79c-eb5ca2f0a104",
  "01a1c6e2-e118-77dc-97e5-3339cf89cd64",
  "01a1c6e2-f5b8-7d83-a268-13560deb2986",
] as const;

function span(line: number, quote: string) {
  const text = LINES[line] ?? "";
  const start = text.indexOf(quote);
  return {
    utteranceId: UTTERANCE_IDS[line] ?? "",
    span: [start, start + quote.length] as [number, number],
    audioMs: [1_000 * line, 1_000 * line + 900] as [number, number],
    confidence: 0.92,
  };
}

const PROPOSAL_PAYLOADS = [
  {
    proposalId: "01a1c6e2-b000-7000-8000-000000000001",
    type: "contact",
    targetEntityId: null,
    fields: {
      name: { value: "Dana Lee", evidence: span(0, "Dana Lee") },
      title: { value: "VP of Operations", evidence: span(0, "VP of Operations") },
    },
    riskFlags: [{ kind: "new_entity" }, { kind: "low_confidence", field: "name" }],
  },
  {
    proposalId: "01a1c6e2-b000-7000-8000-000000000002",
    type: "deal_update",
    targetEntityId: "01a0f831-afe8-7fff-84cf-71639949085b",
    fields: {
      stage: { value: "Proposal", evidence: span(1, "move the deal to the proposal stage") },
    },
    riskFlags: [],
  },
  {
    proposalId: "01a1c6e2-b000-7000-8000-000000000003",
    type: "task",
    targetEntityId: "01a0f831-ac00-75a0-a2b2-cb79eb1835bf",
    fields: {
      title: {
        value: "Send Dana the pricing breakdown",
        evidence: span(2, "send Dana the pricing breakdown"),
      },
      dueDate: { value: "2026-11-12", evidence: span(2, "by Thursday") },
    },
    riskFlags: [{ kind: "date", field: "dueDate" }],
  },
] as const;

/** A session state after the three lines and their proposals, with costs and one review. */
export function demoState(options: { reviewed?: boolean; lines?: number } = {}) {
  const lineCount = options.lines ?? LINES.length;
  let seq = 0;
  let clock = 0;
  const store = new SessionStore(SESSION_ID, { now: () => (clock += 400) });
  const event = (type: string, payload: unknown) =>
    store.applyEvent({
      id: `01a1c6e2-9348-7bf1-9633-${String(seq).padStart(12, "0")}`,
      sessionId: SESSION_ID,
      seq: seq++,
      type,
      schemaVersion: type === "utterance.final" ? 2 : 1,
      ts: new Date(Date.UTC(2026, 10, 10, 19, 15, seq)).toISOString(),
      payload,
    });
  event("session.started", {
    engine: "cascaded",
    mode: "debrief",
    providers: {
      llm: { model: "openai/gpt-oss-20b", provider: "groq" },
      speechToText: { model: "universal-streaming-english", provider: "assemblyai" },
    },
    startedAt: "2026-11-10T19:15:00.000Z",
  });
  LINES.slice(0, lineCount).forEach((text, index) => {
    event("utterance.final", {
      utteranceId: UTTERANCE_IDS[index],
      text,
      confidence: 0.92,
      startMs: 1_000 * index,
      endMs: 1_000 * index + 900,
      witness: "biased",
    });
    const proposal = PROPOSAL_PAYLOADS[index];
    if (proposal) event("proposal.created", proposal);
    event("usage.recorded", {
      usageId: `01a1c6e2-c000-7000-8000-00000000000${index}`,
      kind: "llm",
      provider: "groq",
      model: "openai/gpt-oss-20b",
      inputTokens: 1_480,
      outputTokens: 180,
      costUsd: 0.00021,
      priceTable: "2026-11-15",
    });
  });
  if (options.reviewed) {
    event("proposal.reviewed", {
      proposalId: PROPOSAL_PAYLOADS[1].proposalId,
      decision: "approved",
      reviewerMs: 2_400,
    });
  }
  return store.getState();
}

export const PROPOSALS: readonly ProposalView[] = demoState().projections.proposals;

export const QUOTES: ReadonlyMap<string, string> = new Map(
  LINES.map((text, index) => [UTTERANCE_IDS[index] ?? "", text]),
);

export const TRANSCRIPT = LINES.map((text, index) => ({ id: UTTERANCE_IDS[index] ?? "", text }));

export const ACTIVITY: readonly ActivityRow[] = [
  { id: "1", kind: "response", text: "Proposed a contact.", at: 1 },
  { id: "2", kind: "connection", text: "Connection lost. Reconnecting…", at: 2 },
  { id: "3", kind: "connection", text: "Reconnected. Nothing was lost.", at: 3 },
  {
    id: "4",
    kind: "error",
    text: "The model provider failed, so that turn got no proposals.",
    at: 4,
  },
  { id: "5", kind: "action", text: "Hands-free on.", at: 5 },
  { id: "working", kind: "action", text: "Working…", at: 6, transient: true },
];
