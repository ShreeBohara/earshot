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

/** What the linker made of each line, as `proposal.created` v2 has it (Phase 4 WP8). */
function target(overrides: Record<string, unknown>) {
  return {
    decision: "none",
    entityId: null,
    kind: null,
    basis: null,
    p: null,
    mention: null,
    company: null,
    candidates: [],
    ...overrides,
  };
}

const PROPOSAL_PAYLOADS = [
  {
    // "Dana Lee" sounds like Dana Li, or may be someone new: the linker asks.
    proposalId: "01a1c6e2-b000-7000-8000-000000000001",
    type: "contact",
    target: target({
      decision: "ask",
      kind: "contact",
      p: 0.62,
      mention: { quote: "Dana Lee", evidence: span(0, "Dana Lee") },
      candidates: [
        { entityId: "ct_145", p: 0.62 },
        { entityId: null, p: 0.38 },
      ],
    }),
    fields: {
      name: { value: "Dana Lee", evidence: span(0, "Dana Lee") },
      title: { value: "VP of Operations", evidence: span(0, "VP of Operations") },
    },
    riskFlags: [
      { kind: "low_confidence", field: "name" },
      { kind: "ambiguous_target", field: "target" },
    ],
    supersedes: null,
    linker: "linker.v1",
  },
  {
    // "the deal" names nothing: the open account's only deal.
    proposalId: "01a1c6e2-b000-7000-8000-000000000002",
    type: "deal_update",
    target: target({
      decision: "linked",
      entityId: "01a0f831-afe8-7fff-84cf-71639949085b",
      basis: "focus",
    }),
    fields: {
      stage: { value: "Proposal", evidence: span(1, "move the deal to the proposal stage") },
    },
    riskFlags: [{ kind: "implied_target", field: "target" }],
    supersedes: null,
    linker: "linker.v1",
  },
  {
    // "Dana" linked by sound, and a due date its words read otherwise, replaced.
    proposalId: "01a1c6e2-b000-7000-8000-000000000003",
    type: "task",
    target: target({
      decision: "linked",
      entityId: "ct_145",
      kind: "contact",
      basis: "sound",
      p: 0.81,
      mention: { quote: "Dana", evidence: span(2, "Dana") },
      candidates: [{ entityId: "ct_145", p: 0.81 }],
    }),
    fields: {
      title: {
        value: "Send Dana the pricing breakdown",
        evidence: span(2, "send Dana the pricing breakdown"),
      },
      dueDate: {
        value: "2026-11-12",
        evidence: span(2, "by Thursday"),
        norm: { llmValue: "2026-11-13" },
      },
    },
    riskFlags: [
      { kind: "value_mismatch", field: "dueDate" },
      { kind: "link_uncertain", field: "target" },
    ],
    supersedes: null,
    linker: "linker.v1",
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
      schemaVersion: type === "utterance.final" || type === "proposal.created" ? 2 : 1,
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

/**
 * The task about "Dana" after the second witness heard "Donna" there (Phase 4 WP9): the link by
 * sound became a question, flagged, with the two readings.
 */
export const WITNESS_CONFLICT: ProposalView = (() => {
  const task = PROPOSALS[2];
  if (!task?.target.mention) throw new Error("the fixture's task has no mention");
  return {
    ...task,
    targetEntityId: null,
    target: {
      ...task.target,
      decision: "ask",
      entityId: null,
      candidates: [
        { entityId: "ct_145", p: 0.81 },
        { entityId: null, p: 0.6 },
      ],
    },
    riskFlags: [...task.riskFlags, { kind: "witness_conflict", field: "target" }],
    conflicts: [
      {
        field: "target",
        biased: { text: "Dana", evidence: task.target.mention.evidence },
        unbiased: {
          text: "Donna",
          utteranceId: "01a1c6e2-f5b8-7d83-a268-13560deb2999",
          audioMs: [2_100, 2_380],
        },
      },
    ],
  };
})();

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
