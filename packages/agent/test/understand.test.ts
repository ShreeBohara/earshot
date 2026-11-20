// The understanding step (Phase 4 spec §4.3, WP8 step 3) with a fake extractor: drafts written
// by hand, as tool schema v2 shapes them, through `understand` against the whole demo CRM. It
// covers the target's decisions (linked, ask, new, none, implied, and an unquoted target), contact
// proposals, deals named by their company, the fields' checks, and what a turn passes on.
import {
  type EntityRef,
  ProposalCreatedV2,
  type RiskFlagV2,
  type UtteranceFinalV2,
} from "@earshot/core";
import { companies, contacts, deals } from "@earshot/demo-crm";
import { buildLinkIndex, type LinkIndex } from "@earshot/understanding/link";
import { describe, expect, it } from "vitest";
import type { ToolProposal, ToolTarget } from "../src/schema";
import { DEMO_ENTITIES, DEMO_UTTERANCES } from "../src/testing/scenarios";
import {
  type LinkSession,
  MAX_RECENT_LINKS,
  type ProposalDraft,
  understand,
  understandTurn,
  withRecentLinks,
} from "../src/understand";

/** The demo CRM as a session holds it, each contact and deal with its company. */
const ENTITIES: readonly EntityRef[] = [
  ...companies.map((row) => ({
    id: row.id,
    kind: "company" as const,
    name: row.name,
    aliases: row.aliases,
  })),
  ...contacts.map((row) => ({
    id: row.id,
    kind: "contact" as const,
    name: `${row.firstName} ${row.lastName}`,
    aliases: [],
    parentId: row.companyId,
  })),
  ...deals.map((row) => ({
    id: row.id,
    kind: "deal" as const,
    name: row.name,
    aliases: [],
    parentId: row.companyId,
  })),
];
const INDEX = buildLinkIndex(ENTITIES);

/** Tuesday 2026-11-17, 14:20 in Los Angeles. */
const CALL_TIME = "2026-11-17T22:20:00.000Z";
const TIME_ZONE = "America/Los_Angeles";

function session(overrides: Partial<LinkSession> = {}, index: LinkIndex = INDEX): LinkSession {
  return { index, focusEntityId: null, recent: [], ...overrides };
}

function utterance(text: string, n = 1): UtteranceFinalV2 {
  return {
    utteranceId: `01a1c6e5-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
    text,
    confidence: 0.92,
    startMs: 1_000 * n,
    endMs: 1_000 * n + 4_000,
    witness: "biased",
  };
}

function run(draft: ToolProposal, text: string, linking: Partial<LinkSession> = {}) {
  return understand(draft, {
    utterances: [utterance(text)],
    session: session(linking),
    callTime: CALL_TIME,
    timeZone: TIME_ZONE,
  });
}

/** Every draft must be a valid `proposal.created` v2 payload once it has an id. */
function valid(draft: ProposalDraft | null) {
  if (!draft) throw new Error("expected a draft");
  return ProposalCreatedV2.parse({ proposalId: "01a1c6e5-0000-7000-8000-000000000001", ...draft });
}

function note(target: ToolTarget | null, body: string): ToolProposal {
  return { type: "note", target, fields: { body: { value: body, quote: body } } };
}

const company = (quote: string): ToolTarget => ({ quote, kind: "company", company: null });
const deal = (quote: string): ToolTarget => ({ quote, kind: "deal", company: null });
const onTarget = (kind: RiskFlagV2["kind"]): RiskFlagV2 => ({ kind, field: "target" });

describe("understand: the target", () => {
  it("links a record named exactly, with the words' evidence and the linker's version", () => {
    const text = "Tidewater Biotech wants to phase the expansion";
    const proposal = valid(run(note(company("Tidewater Biotech"), text), text));
    expect(proposal.target).toMatchObject({
      decision: "linked",
      entityId: "co_017",
      kind: "company",
      basis: "exact",
      mention: { quote: "Tidewater Biotech", evidence: { span: [0, 17] } },
      company: null,
    });
    expect(proposal.target.p).toBeGreaterThan(0.9);
    expect(proposal.target.candidates[0]).toMatchObject({ entityId: "co_017" });
    expect(proposal.riskFlags).toEqual([]);
    expect(proposal).toMatchObject({ linker: "linker.v1", supersedes: null });
  });

  it("asks when sound-alikes tie and nothing separates them, and links once the account is open", () => {
    const text = "Northwind wants a route planning pilot";
    const draft = note(company("Northwind"), text);
    const asked = valid(run(draft, text));
    expect(asked.target).toMatchObject({ decision: "ask", entityId: null, basis: null });
    expect(
      asked.target.candidates
        .map((candidate) => candidate.entityId)
        .filter((id) => id !== null)
        .sort(),
    ).toEqual(["co_010", "co_021", "co_036"]);
    expect(asked.riskFlags).toEqual([onTarget("ambiguous_target")]);

    const open = valid(run(draft, text, { focusEntityId: "co_036" }));
    expect(open.target).toMatchObject({ decision: "linked", entityId: "co_036", basis: "context" });
  });

  it("proposes a new record for a company like none in the CRM", () => {
    const text = "Zebulon Quarries called about a pilot";
    const proposal = valid(run(note(company("Zebulon Quarries"), text), text));
    expect(proposal.target).toMatchObject({ decision: "new", entityId: null, kind: "company" });
    expect(proposal.target.candidates[0]).toEqual({ entityId: null, p: proposal.target.p });
    expect(proposal.riskFlags).toEqual([onTarget("new_entity")]);
  });

  it("never links a target whose words aren't in the transcript", () => {
    const text = "Summit Ridge wants the starter plan";
    const proposal = valid(run(note(company("Summit Ridge Capital"), text), text));
    expect(proposal.target).toEqual({
      decision: "none",
      entityId: null,
      kind: "company",
      basis: null,
      p: null,
      mention: null,
      company: null,
      candidates: [],
    });
    expect(proposal.riskFlags).toEqual([onTarget("unsupported")]);
  });

  it("implies the open account when no record is named, and has no target without one", () => {
    const text = "They want to phase the expansion";
    const implied = valid(run(note(null, text), text, { focusEntityId: "co_017" }));
    expect(implied.target).toEqual({
      decision: "linked",
      entityId: "co_017",
      kind: null,
      basis: "focus",
      p: null,
      mention: null,
      company: null,
      candidates: [],
    });
    expect(implied.riskFlags).toEqual([onTarget("implied_target")]);

    const none = valid(run(note(null, text), text));
    expect(none.target).toMatchObject({ decision: "none", entityId: null, mention: null });
    expect(none.riskFlags).toEqual([]);
  });

  it("gives a deal update with no named deal the open account's only deal, or nothing", () => {
    const text = "move it to contract sent";
    const update: ToolProposal = {
      type: "deal_update",
      target: null,
      fields: { stage: { value: "contract sent", quote: text }, amount: null, closeDate: null },
    };
    expect(valid(run(update, text, { focusEntityId: "co_005" })).target).toMatchObject({
      decision: "linked",
      entityId: "deal_013",
      basis: "focus",
    });
    // Summit Ridge Capital has no deal in the demo CRM.
    expect(valid(run(update, text, { focusEntityId: "co_019" })).target.decision).toBe("none");
  });

  it("resolves a deal named by its company to that company's only deal", () => {
    const text = "Atlas Freight wants fifteen trucks on the pilot";
    const update: ToolProposal = {
      type: "deal_update",
      target: deal("Atlas Freight"),
      fields: { stage: { value: "pilot", quote: "the pilot" }, amount: null, closeDate: null },
    };
    expect(valid(run(update, text)).target).toMatchObject({
      decision: "linked",
      entityId: "deal_013",
      kind: "deal",
      basis: "context",
    });
  });

  it("asks between a company's deals when it has several, and never proposes a new deal", () => {
    const entities: EntityRef[] = [
      { id: "co_x", kind: "company", name: "Quillfeather Labs", aliases: ["Quillfeather"] },
      {
        id: "deal_a",
        kind: "deal",
        name: "Quillfeather Labs - Expansion",
        aliases: [],
        parentId: "co_x",
      },
      {
        id: "deal_b",
        kind: "deal",
        name: "Quillfeather Labs - Renewal",
        aliases: [],
        parentId: "co_x",
      },
    ];
    const index = buildLinkIndex(entities);
    const update = (target: ToolTarget, text: string) =>
      valid(
        understand(
          {
            type: "deal_update",
            target,
            fields: {
              stage: { value: "closing", quote: "close in March" },
              amount: null,
              closeDate: null,
            },
          },
          {
            utterances: [utterance(text)],
            session: session({}, index),
            callTime: CALL_TIME,
            timeZone: TIME_ZONE,
          },
        ),
      );
    const asked = update(deal("Quillfeather"), "Quillfeather wants to close in March");
    expect(asked.target.decision).toBe("ask");
    expect(asked.target.candidates.map((candidate) => candidate.entityId).sort()).toEqual([
      "deal_a",
      "deal_b",
    ]);
    expect(update(deal("Grimsby"), "Grimsby wants to close in March").target.decision).toBe("none");
  });

  it("links a contact on its name, with the company said beside it as context", () => {
    const text = "Kathryn Moore from Blue Harbor is our new champion";
    const contact: ToolProposal = {
      type: "contact",
      fields: {
        name: { value: "Kathryn Moore", quote: "Kathryn Moore" },
        title: { value: "champion", quote: "champion" },
        company: { value: "Blue Harbor", quote: "Blue Harbor" },
        email: null,
        phone: null,
      },
    };
    const proposal = valid(run(contact, text));
    expect(proposal.target).toMatchObject({
      decision: "linked",
      entityId: "ct_064",
      kind: "contact",
      mention: { quote: "Kathryn Moore", evidence: { span: [0, 13] } },
      company: { quote: "Blue Harbor", entityId: "co_037", evidence: { span: [19, 30] } },
    });
    // Without the company, three Moores sound the same.
    const alone = valid(run({ ...contact, fields: { ...contact.fields, company: null } }, text));
    expect(alone.target.decision).toBe("ask");
  });

  it("asks rather than call a near-homophone new: the demo's Dana Lee", () => {
    const [first] = DEMO_UTTERANCES;
    if (!first) throw new Error("no demo utterance");
    const proposal = valid(
      understand(
        {
          type: "contact",
          fields: {
            name: { value: "Dana Lee", quote: "Dana Lee" },
            title: null,
            company: null,
            email: null,
            phone: null,
          },
        },
        {
          utterances: [first],
          session: session({}, buildLinkIndex(DEMO_ENTITIES)),
          callTime: CALL_TIME,
          timeZone: TIME_ZONE,
        },
      ),
    );
    expect(proposal.target.decision).toBe("ask");
    expect(proposal.target.candidates.map((candidate) => candidate.entityId)).toEqual([
      "ct_112",
      "ct_145",
      null,
    ]);
  });
});

describe("understand: the fields", () => {
  const text = "I owe Tidewater Biotech a revised quote by Friday";
  const task = (dueDate: { value: string; quote: string } | null): ToolProposal => ({
    type: "task",
    target: company("Tidewater Biotech"),
    fields: {
      title: { value: "Send Tidewater Biotech a revised quote", quote: "a revised quote" },
      dueDate,
    },
  });

  it("keeps a date its quote reads the same way, unflagged", () => {
    const proposal = valid(run(task({ value: "2026-11-20", quote: "by Friday" }), text));
    expect(proposal.fields.dueDate).toMatchObject({ value: "2026-11-20" });
    expect(proposal.fields.dueDate).not.toHaveProperty("norm");
    expect(proposal.riskFlags).toEqual([]);
  });

  it("replaces a date its quote reads otherwise, keeping the model's value in norm", () => {
    const proposal = valid(run(task({ value: "2026-11-21", quote: "by Friday" }), text));
    expect(proposal.fields.dueDate).toMatchObject({
      value: "2026-11-20",
      norm: { llmValue: "2026-11-21" },
      evidence: { span: [40, 49] },
    });
    expect(proposal.riskFlags).toEqual([{ kind: "value_mismatch", field: "dueDate" }]);
  });

  it("drops a field whose quote isn't in the turn, flagged unsupported, and an empty proposal", () => {
    const proposal = valid(run(task({ value: "2026-11-24", quote: "by Tuesday" }), text));
    expect(Object.keys(proposal.fields)).toEqual(["title"]);
    expect(proposal.riskFlags).toEqual([{ kind: "unsupported", field: "dueDate" }]);
    expect(run(note(company("Tidewater Biotech"), "renewal is at risk"), text)).toBeNull();
  });

  it("treats an empty value with an empty quote as not said", () => {
    const sentence = "Paloma Ruiz runs operations now";
    const proposal = valid(
      run(
        {
          type: "contact",
          fields: {
            name: { value: "Paloma Ruiz", quote: "Paloma Ruiz" },
            title: { value: "", quote: "" },
            company: null,
            email: { value: " ", quote: "" },
            phone: null,
          },
        },
        sentence,
      ),
    );
    expect(Object.keys(proposal.fields)).toEqual(["name"]);
    expect(proposal.target.decision).toBe("new");
    expect(proposal.riskFlags).toEqual([onTarget("new_entity")]);
  });

  it("flags evidence heard with low confidence, and records an amount's currency", () => {
    const amount: UtteranceFinalV2 = {
      ...utterance("Tidewater Biotech wants $50k for it."),
      confidence: 0.8,
      words: [
        { w: "Tidewater", startMs: 900, endMs: 1200, confidence: 0.95 },
        { w: "Biotech", startMs: 1210, endMs: 1240, confidence: 0.95 },
        { w: "wants", startMs: 1250, endMs: 1500, confidence: 0.95 },
        { w: "fifty", startMs: 1550, endMs: 1900, confidence: 0.6 },
        { w: "thousand", startMs: 1950, endMs: 2400, confidence: 0.55 },
        { w: "for", startMs: 2500, endMs: 2700, confidence: 0.95 },
        { w: "it", startMs: 2750, endMs: 3000, confidence: 0.95 },
      ],
    };
    const proposal = valid(
      understand(
        {
          type: "deal_update",
          target: deal("Tidewater Biotech"),
          fields: { stage: null, amount: { value: 50000, quote: "wants $50k" }, closeDate: null },
        },
        { utterances: [amount], session: session(), callTime: CALL_TIME, timeZone: TIME_ZONE },
      ),
    );
    expect(proposal.fields.amount).toMatchObject({
      value: 50000,
      norm: { currency: "USD" },
      evidence: { audioMs: [1250, 2400], confidence: 0.55 },
    });
    // No more `number` or `date` on every such value: the normalizers check it (ADR-0030). The
    // deal was named by its company alone, a link by context, so it's worth a look too.
    expect(proposal.riskFlags).toEqual([
      { kind: "low_confidence", field: "amount" },
      onTarget("link_uncertain"),
    ]);
    expect(proposal.target).toMatchObject({
      decision: "linked",
      entityId: "deal_017",
      basis: "context",
    });
  });

  it("checks a meeting's date and time, and its title as free text", () => {
    const sentence = "Set up a kickoff with Tidewater Biotech on December 7th at 3pm";
    const proposal = valid(
      run(
        {
          type: "meeting",
          target: company("Tidewater Biotech"),
          fields: {
            title: { value: "Kickoff", quote: "kickoff" },
            date: { value: "2026-12-07", quote: "December 7th" },
            time: { value: "15:00", quote: "3pm" },
            attendees: null,
          },
        },
        sentence,
      ),
    );
    expect(proposal.type).toBe("meeting");
    expect(proposal.fields).toMatchObject({
      date: { value: "2026-12-07" },
      time: { value: "15:00" },
    });
    expect(proposal.riskFlags).toEqual([]);
  });

  it("flags a negated quote", () => {
    const sentence = "Tidewater Biotech won't renew the support plan";
    const proposal = valid(
      run(note(company("Tidewater Biotech"), "won't renew the support plan"), sentence),
    );
    expect(proposal.riskFlags).toEqual([{ kind: "negation", field: "body" }]);
  });
});

describe("understandTurn", () => {
  const task = (target: ToolTarget): ToolProposal => ({
    type: "task",
    target,
    fields: { title: { value: "Send the order form", quote: "the order form" }, dueDate: null },
  });
  const contact = (quote: string): ToolTarget => ({ quote, kind: "contact", company: null });

  it("lets each proposal hear the turn's companies, and passes the links on", () => {
    const text =
      "Blue Harbor Analytics wants to start in January. Kathryn Moore needs the order form";
    const turn = understandTurn(
      [
        note(company("Blue Harbor Analytics"), "wants to start in January"),
        task(contact("Kathryn Moore")),
      ],
      {
        utterances: [utterance(text)],
        session: session(),
        callTime: CALL_TIME,
        timeZone: TIME_ZONE,
      },
    );
    expect(turn.proposals.map((proposal) => proposal.target.entityId)).toEqual([
      "co_037",
      "ct_064",
    ]);
    expect(turn.recent).toEqual(["ct_064", "co_037"]);
  });

  it("reads a record linked earlier in the session as context", () => {
    const context = {
      utterances: [utterance("Kathryn Moore needs the order form")],
      callTime: CALL_TIME,
      timeZone: TIME_ZONE,
    };
    const drafts = [task(contact("Kathryn Moore"))];
    expect(
      understandTurn(drafts, { ...context, session: session() }).proposals[0]?.target,
    ).toMatchObject({
      decision: "ask",
    });
    expect(
      understandTurn(drafts, { ...context, session: session({ recent: ["ct_078"] }) }).proposals[0]
        ?.target,
    ).toMatchObject({ decision: "linked", entityId: "ct_078", basis: "context" });
  });
});

describe("withRecentLinks", () => {
  const linked = (entityId: string, basis: "exact" | "focus" = "exact", companyId?: string) =>
    ({
      target: {
        decision: "linked",
        entityId,
        kind: null,
        basis,
        p: null,
        mention: null,
        company: companyId ? { quote: "x", evidence: null, entityId: companyId } : null,
        candidates: [],
      },
    }) as unknown as Pick<ProposalDraft, "target">;

  it("puts the latest first, without repeats, skipping implied targets, at most 20", () => {
    expect(
      withRecentLinks(["a", "b"], [linked("b"), linked("c", "focus"), linked("d", "exact", "e")]),
    ).toEqual(["d", "e", "b", "a"]);
    const recent = withRecentLinks(
      [],
      Array.from({ length: 30 }, (_, n) => linked(`r${n}`)),
    );
    expect(recent).toHaveLength(MAX_RECENT_LINKS);
    expect(recent[0]).toBe("r29");
  });
});
