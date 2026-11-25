// Story data for the inbox: a debrief about Acme Corp with a card in every state a card has, a
// debrief that's still finishing, and a decision and a snooze from earlier. Stories only.
import type { Evidence, TargetV2 } from "@earshot/core";
import type { InboxData, InboxEntity, InboxProposal, InboxSession } from "@/lib/inbox/types";

const UTTERANCES = {
  one: "01a1c6e2-0000-7000-8000-00000000c001",
  two: "01a1c6e2-0000-7000-8000-00000000c002",
  three: "01a1c6e2-0000-7000-8000-00000000c003",
} as const;

const SAID: Record<string, string> = {
  [UTTERANCES.one]: "Just met Dana at Acme Corp, she's their new VP of Operations.",
  [UTTERANCES.two]:
    "Move the Acme platform deal to proposal at forty thousand, and send Sean the deck next Friday.",
  [UTTERANCES.three]: "Pier Logistics asked for a security review before they sign.",
};

function evidence(utteranceId: string, words: string): Evidence {
  const text = SAID[utteranceId] ?? "";
  const start = text.indexOf(words);
  if (start < 0) throw new Error(`"${words}" isn't in the fixture`);
  return { utteranceId, span: [start, start + words.length], audioMs: [0, 900], confidence: 0.92 };
}

export const ENTITY_IDS = {
  acme: "01a1c6e2-0000-7000-8000-0000000e0001",
  akme: "01a1c6e2-0000-7000-8000-0000000e0002",
  pier: "01a1c6e2-0000-7000-8000-0000000e0003",
  dana: "01a1c6e2-0000-7000-8000-0000000e0004",
  danaLi: "01a1c6e2-0000-7000-8000-0000000e0005",
  sean: "01a1c6e2-0000-7000-8000-0000000e0006",
  deal: "01a1c6e2-0000-7000-8000-0000000e0007",
} as const;

export const ENTITIES: Record<string, InboxEntity> = {
  [ENTITY_IDS.acme]: {
    id: ENTITY_IDS.acme,
    kind: "company",
    name: "Acme Corp",
    accountId: ENTITY_IDS.acme,
    values: {},
  },
  [ENTITY_IDS.akme]: {
    id: ENTITY_IDS.akme,
    kind: "company",
    name: "Akme Dynamics",
    accountId: ENTITY_IDS.akme,
    values: {},
  },
  [ENTITY_IDS.pier]: {
    id: ENTITY_IDS.pier,
    kind: "company",
    name: "Pier Logistics",
    accountId: ENTITY_IDS.pier,
    values: {},
  },
  [ENTITY_IDS.dana]: {
    id: ENTITY_IDS.dana,
    kind: "contact",
    name: "Dana Lee",
    accountId: ENTITY_IDS.acme,
    values: { title: "Director of Operations" },
  },
  [ENTITY_IDS.danaLi]: {
    id: ENTITY_IDS.danaLi,
    kind: "contact",
    name: "Dana Li",
    accountId: ENTITY_IDS.akme,
    values: {},
  },
  [ENTITY_IDS.sean]: {
    id: ENTITY_IDS.sean,
    kind: "contact",
    name: "Sean Murphy",
    accountId: ENTITY_IDS.acme,
    values: {},
  },
  [ENTITY_IDS.deal]: {
    id: ENTITY_IDS.deal,
    kind: "deal",
    name: "Acme Corp - Platform",
    accountId: ENTITY_IDS.acme,
    values: { stage: "presentationscheduled", amount: 32_000 },
  },
};

function target(overrides: Partial<TargetV2>): TargetV2 {
  return {
    decision: "linked",
    entityId: null,
    kind: null,
    basis: "exact",
    p: 0.99,
    mention: null,
    company: null,
    candidates: [],
    ...overrides,
  };
}

function proposal(n: number, overrides: Partial<InboxProposal>): InboxProposal {
  return {
    proposalId: `01a1c6e2-0000-7000-8000-0000000b${n.toString().padStart(4, "0")}`,
    type: "task",
    targetEntityId: null,
    target: target({}),
    status: "proposed",
    fields: {},
    riskFlags: [],
    conflicts: [],
    supersedes: null,
    supersededBy: null,
    snoozedUntil: null,
    followups: [],
    seq: n,
    ts: "2026-11-20T15:00:00.000Z",
    review: null,
    sync: null,
    ...overrides,
  };
}

/** Loud: the linker asked who "Dana" is. Its records are numbered 1 to 3. */
export const QUESTION = proposal(1, {
  type: "contact",
  target: target({
    decision: "ask",
    kind: "contact",
    basis: "sound",
    p: 0.52,
    mention: { quote: "Dana", evidence: evidence(UTTERANCES.one, "Dana") },
    candidates: [
      { entityId: ENTITY_IDS.dana, p: 0.52 },
      { entityId: ENTITY_IDS.danaLi, p: 0.36 },
      { entityId: null, p: 0.12 },
    ],
  }),
  fields: {
    name: { value: "Dana", evidence: evidence(UTTERANCES.one, "Dana") },
    title: { value: "VP of Operations", evidence: evidence(UTTERANCES.one, "VP of Operations") },
  },
  riskFlags: [{ kind: "ambiguous_target", field: "target" }],
});

/** Loud: the second witness heard the title another way. */
export const CONFLICT = proposal(2, {
  type: "contact",
  targetEntityId: ENTITY_IDS.dana,
  target: target({
    entityId: ENTITY_IDS.dana,
    kind: "contact",
    mention: { quote: "Dana", evidence: evidence(UTTERANCES.one, "Dana") },
    candidates: [{ entityId: ENTITY_IDS.dana, p: 0.97 }],
  }),
  fields: {
    title: { value: "VP of Operations", evidence: evidence(UTTERANCES.one, "VP of Operations") },
  },
  riskFlags: [{ kind: "witness_conflict", field: "title" }],
  conflicts: [
    {
      field: "title",
      biased: { text: "VP of Operations", evidence: evidence(UTTERANCES.one, "VP of Operations") },
      unbiased: { text: "VP of Operating", utteranceId: UTTERANCES.one, audioMs: [3000, 3900] },
    },
  ],
});

/** Unmarked: a deal update, the CRM's values as before. */
export const UPDATE = proposal(3, {
  type: "deal_update",
  targetEntityId: ENTITY_IDS.deal,
  target: target({
    entityId: ENTITY_IDS.deal,
    kind: "deal",
    mention: {
      quote: "the Acme platform deal",
      evidence: evidence(UTTERANCES.two, "the Acme platform deal"),
    },
    candidates: [
      { entityId: ENTITY_IDS.deal, p: 0.98 },
      { entityId: null, p: 0.02 },
    ],
  }),
  fields: {
    stage: { value: "proposal", evidence: evidence(UTTERANCES.two, "proposal") },
    amount: { value: 40_000, evidence: evidence(UTTERANCES.two, "forty thousand") },
  },
});

/**
 * Loud at review time (Phase 5 WP12): the same deal update after the CRM moved the deal's stage
 * from "Qualified to buy", where it was when the rep spoke, to "Presentation scheduled".
 */
export const CRM_CHANGED = proposal(13, {
  type: UPDATE.type,
  targetEntityId: UPDATE.targetEntityId,
  target: UPDATE.target,
  fields: UPDATE.fields,
  crm: {
    moved: { stage: { base: "qualifiedtobuy", changedAt: "2026-11-20T13:00:00.000Z" } },
    relink: null,
  },
});

/**
 * Loud at review time (Phase 5 WP12): a new record, "Pier Logistics", which reached the CRM after
 * the rep spoke, so the card offers it.
 */
export const RELINK = proposal(14, {
  type: "note",
  target: target({
    decision: "new",
    kind: "company",
    basis: null,
    p: 0.9,
    mention: {
      quote: "Pier Logistics",
      evidence: evidence(UTTERANCES.three, "Pier Logistics"),
    },
    candidates: [{ entityId: null, p: 0.9 }],
  }),
  fields: {
    body: {
      value: "Asked for a security review before they sign",
      evidence: evidence(UTTERANCES.three, "asked for a security review before they sign"),
    },
  },
  riskFlags: [{ kind: "new_entity", field: "target" }],
  crm: { moved: {}, relink: ENTITY_IDS.pier },
});

/** Loud: "next Friday" has two readings. */
export const AMBIGUOUS = proposal(4, {
  type: "task",
  targetEntityId: ENTITY_IDS.sean,
  target: target({
    entityId: ENTITY_IDS.sean,
    kind: "contact",
    mention: { quote: "Sean", evidence: evidence(UTTERANCES.two, "Sean") },
    candidates: [{ entityId: ENTITY_IDS.sean, p: 0.95 }],
  }),
  fields: {
    title: {
      value: "Send Sean the deck",
      evidence: evidence(UTTERANCES.two, "send Sean the deck"),
    },
    dueDate: {
      value: "2026-11-27",
      evidence: evidence(UTTERANCES.two, "next Friday"),
      norm: { readings: ["2026-11-27", "2026-12-04"] },
    },
  },
  riskFlags: [{ kind: "ambiguous_value", field: "dueDate" }],
});

/** Quiet: no account was named, so the open one was assumed. */
export const QUIET = proposal(5, {
  type: "note",
  targetEntityId: ENTITY_IDS.acme,
  target: target({
    entityId: ENTITY_IDS.acme,
    kind: "company",
    basis: "focus",
    p: null,
    candidates: [{ entityId: ENTITY_IDS.acme, p: 0.9 }],
  }),
  fields: {
    body: {
      value: "Dana is their new VP of Operations.",
      evidence: evidence(UTTERANCES.one, "she's their new VP of Operations"),
    },
  },
  riskFlags: [{ kind: "implied_target", field: "target" }],
});

/** Quiet by the name: linked in context, not by its exact name. */
export const NAME_NOTE = proposal(6, {
  type: "task",
  targetEntityId: ENTITY_IDS.pier,
  target: target({
    entityId: ENTITY_IDS.pier,
    kind: "company",
    basis: "context",
    p: 0.91,
    mention: { quote: "Pier Logistics", evidence: evidence(UTTERANCES.three, "Pier Logistics") },
    candidates: [
      { entityId: ENTITY_IDS.pier, p: 0.91 },
      { entityId: ENTITY_IDS.acme, p: 0.06 },
    ],
  }),
  fields: {
    title: {
      value: "Arrange a security review",
      evidence: evidence(UTTERANCES.three, "a security review"),
    },
  },
  riskFlags: [{ kind: "link_uncertain", field: "target" }],
});

/** Loud: the record's name isn't in what was said, so there's no record to accept it for. */
export const NO_RECORD = proposal(7, {
  type: "commitment",
  target: target({ decision: "none", kind: "company", basis: null, p: null }),
  fields: {
    text: {
      value: "Review before signing",
      evidence: evidence(UTTERANCES.three, "before they sign"),
    },
  },
  riskFlags: [{ kind: "unsupported", field: "target" }],
});

/** Plain: an exact link, nothing to mark. */
export const PLAIN = proposal(8, {
  type: "task",
  targetEntityId: ENTITY_IDS.sean,
  target: target({
    entityId: ENTITY_IDS.sean,
    kind: "contact",
    mention: { quote: "Sean", evidence: evidence(UTTERANCES.two, "Sean") },
    candidates: [{ entityId: ENTITY_IDS.sean, p: 0.98 }],
  }),
  fields: {
    title: {
      value: "Send Sean the deck",
      evidence: evidence(UTTERANCES.two, "send Sean the deck"),
    },
  },
});

const ACCEPTED = proposal(9, {
  ...PLAIN,
  proposalId: "01a1c6e2-0000-7000-8000-0000000b0009",
  status: "approved",
  review: {
    reviewId: "01a1c6e2-0000-7000-8000-0000000f0001",
    decision: "approved",
    target: null,
    mode: "single",
    batchId: null,
    undoes: null,
    // Far ahead, so the story's Undo stays Undo.
    syncEligibleAt: "2099-01-01T00:00:00.000Z",
    ts: "2026-11-20T15:10:00.000Z",
  },
});

/**
 * Approved by the workspace's approval policy as it was made (Phase 5 WP11): a note linked by the
 * account's exact name, nothing to mark, so the "notes" rule took it. Reviewed shows it with Undo.
 */
export const AUTO_APPROVED = proposal(12, {
  type: "note",
  targetEntityId: ENTITY_IDS.acme,
  target: target({
    entityId: ENTITY_IDS.acme,
    kind: "company",
    mention: { quote: "Acme", evidence: evidence(UTTERANCES.one, "Acme") },
    candidates: [{ entityId: ENTITY_IDS.acme, p: 0.99 }],
  }),
  fields: {
    body: {
      value: "Dana is their new VP of Operations.",
      evidence: evidence(UTTERANCES.one, "she's their new VP of Operations"),
    },
  },
  status: "approved",
  review: {
    reviewId: "01a1c6e2-0000-7000-8000-0000000f0012",
    decision: "approved",
    target: null,
    mode: "policy",
    batchId: null,
    policy: { id: "01a1c6f2-7d10-7a3b-9c4d-5e6f7a8b9c0d", version: 2, rule: "notes" },
    undoes: null,
    // Far ahead, so the story's Undo stays Undo.
    syncEligibleAt: "2099-01-01T00:00:00.000Z",
    ts: "2026-11-20T14:15:00.000Z",
  },
});

const SNOOZED = proposal(10, {
  ...QUIET,
  proposalId: "01a1c6e2-0000-7000-8000-0000000b0010",
  snoozedUntil: "2099-01-01T09:00:00.000Z",
});

export const SESSION: InboxSession = {
  sessionId: "01a1c6e2-0000-7000-8000-0000000a0001",
  startedAt: "2026-11-20T14:14:00.000Z",
  endedAt: "2026-11-20T14:16:00.000Z",
  sealedAt: "2026-11-20T14:17:00.000Z",
  focusEntityId: ENTITY_IDS.acme,
  proposals: [QUESTION, UPDATE, PLAIN, QUIET, ACCEPTED, SNOOZED],
};

export const FINISHING: InboxSession = {
  sessionId: "01a1c6e2-0000-7000-8000-0000000a0002",
  startedAt: "2026-11-20T15:40:00.000Z",
  endedAt: "2026-11-20T15:42:00.000Z",
  sealedAt: null,
  focusEntityId: ENTITY_IDS.pier,
  proposals: [{ ...NAME_NOTE, proposalId: "01a1c6e2-0000-7000-8000-0000000b0011" }],
};

export const QUOTES: Record<string, string> = SAID;

/** The inbox: one debrief to review, one finishing, a decision with Undo, and a snooze. */
export const INBOX: InboxData = {
  sessions: [FINISHING, SESSION],
  entities: ENTITIES,
  quotes: QUOTES,
  older: null,
  loadedAt: "2026-11-20T16:00:00.000Z",
};

/** A debrief whose policy approved one note as it was made, with one card left to review. */
export const POLICY_INBOX: InboxData = {
  sessions: [{ ...SESSION, proposals: [PLAIN, AUTO_APPROVED] }],
  entities: ENTITIES,
  quotes: QUOTES,
  older: null,
  loadedAt: "2026-11-20T16:00:00.000Z",
};

/** A new workspace's inbox. */
export const EMPTY_INBOX: InboxData = {
  sessions: [],
  entities: {},
  quotes: {},
  older: null,
  loadedAt: "2026-11-20T16:00:00.000Z",
};
