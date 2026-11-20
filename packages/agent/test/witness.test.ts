// The second witness's comparison for a turn (Phase 4 spec §4.6, WP9): proposals understood from
// a biased transcript, then compared with an unbiased one through `witnessTurn`, with the link
// context `understandTurn` hands on, as SessionDO runs them.
import { type EntityRef, ProposalFlaggedV1, type UtteranceFinalV2, type Word } from "@earshot/core";
import { companies, contacts, deals } from "@earshot/demo-crm";
import { buildLinkIndex } from "@earshot/understanding/link";
import { describe, expect, it } from "vitest";
import type { ToolProposal } from "../src/schema";
import { DEMO_ENTITIES, DEMO_FOCUS_ID } from "../src/testing/scenarios";
import { linkerMention, type ProposalDraft, understandTurn } from "../src/understand";
import { type ProposalLink, witnessTurn } from "../src/witness";

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
const ATMOS = "co_009";
const CALL_TIME = "2026-11-19T22:10:00.000Z";
const TIME_ZONE = "America/Denver";

/** Words for `text`, 300 ms each with a 50 ms gap, from `startMs`. */
function timed(text: string, startMs: number): Word[] {
  return text.split(" ").map((w, i) => ({
    w,
    startMs: startMs + i * 350,
    endMs: startMs + i * 350 + 300,
    confidence: 0.9,
  }));
}

function utterance(
  text: string,
  witness: "biased" | "unbiased",
  options: { n?: number; startMs?: number; words?: boolean } = {},
): UtteranceFinalV2 {
  const startMs = options.startMs ?? 2_000;
  const words = options.words === false ? undefined : timed(text, startMs);
  return {
    utteranceId: `01a1c6e6-0000-7000-8000-${(options.n ?? 1).toString(16).padStart(12, "0")}`,
    text,
    confidence: 0.9,
    ...(words ? { words } : {}),
    startMs,
    endMs: words?.at(-1)?.endMs ?? startMs + 4_000,
    witness,
  };
}

const SAID =
  "Debrief from Atmos Industrial. Raj Patel says finance wants to restart the onboarding package.";
const note: ToolProposal = {
  type: "note",
  target: { quote: "Atmos Industrial", kind: "company", company: null },
  fields: {
    body: {
      value: "Finance wants to restart the onboarding package.",
      quote: "finance wants to restart the onboarding package",
    },
  },
};

/** One turn understood from `biased`, as SessionDO's turn would leave it. */
function turnOf(
  drafts: readonly ToolProposal[],
  biased: UtteranceFinalV2,
  options: { focusEntityId?: string | null; index?: typeof INDEX } = {},
) {
  const index = options.index ?? INDEX;
  const focusEntityId = options.focusEntityId === undefined ? ATMOS : options.focusEntityId;
  const understood = understandTurn(drafts, {
    utterances: [biased],
    session: { index, focusEntityId, recent: [] },
    callTime: CALL_TIME,
    timeZone: TIME_ZONE,
  });
  const links: ProposalLink[] = understood.proposals.map((proposal: ProposalDraft, i) => {
    const link = understood.links[i];
    if (!link) throw new Error("a proposal without its link");
    return {
      proposalId: `01a1c6e6-1111-7000-8000-${(i + 1).toString(16).padStart(12, "0")}`,
      target: proposal.target,
      ...link,
    };
  });
  return {
    links,
    compare: (unbiased: UtteranceFinalV2) =>
      witnessTurn({ links, utterances: [biased], unbiased, session: { index, focusEntityId } }),
  };
}

describe("witnessTurn", () => {
  it("turns a snapped name into a question: Atmos Industrial in the biased stream, Atmo Systems in the unbiased one", () => {
    const biased = utterance(SAID, "biased");
    const turn = turnOf([note], biased);
    expect(turn.links[0]?.target).toMatchObject({ decision: "linked", entityId: ATMOS });
    const unbiased = utterance(
      "Debrief from Atmo Systems. Raj Patel says finance wants to restart the onboarding package.",
      "unbiased",
      { n: 2 },
    );
    const result = turn.compare(unbiased);
    expect(result).toMatchObject({ compared: 1, unavailable: 0 });
    const [flagged] = result.flagged;
    expect(ProposalFlaggedV1.parse(flagged)).toEqual(flagged);
    expect(flagged).toMatchObject({
      proposalId: turn.links[0]?.proposalId,
      source: "witness",
      flags: [{ kind: "witness_conflict", field: "target" }],
      conflict: {
        field: "target",
        biased: { text: "Atmos Industrial", evidence: { utteranceId: biased.utteranceId } },
        unbiased: { text: "Atmo Systems", utteranceId: unbiased.utteranceId },
      },
    });
    // The downgrade keeps the old target first, then the unbiased reading's choice: a new record.
    const candidates = flagged?.target?.candidates ?? [];
    expect(flagged?.target?.decision).toBe("ask");
    expect(candidates[0]).toEqual({ entityId: ATMOS, p: turn.links[0]?.target.p });
    expect(candidates[1]?.entityId).toBeNull();
    expect(candidates.length).toBeLessThanOrEqual(4);
    // Read by time: the reading's window is its own words', on the session's clock.
    const [first, last] = flagged?.conflict?.unbiased?.audioMs ?? [];
    expect([first, last]).toEqual([unbiased.words?.[2]?.startMs, unbiased.words?.[3]?.endMs]);
  });

  it("leaves a target both witnesses heard alike untouched", () => {
    const biased = utterance(SAID, "biased");
    const result = turnOf([note], biased).compare(utterance(SAID, "unbiased", { n: 2 }));
    expect(result).toEqual({ flagged: [], compared: 1, unavailable: 0 });
  });

  it("calls a reading unavailable, never a conflict, when the witness heard nothing where the quote is", () => {
    const biased = utterance(SAID, "biased");
    // The unbiased words all come after the turn's: none overlaps the quote's window.
    const late = utterance("thank you", "unbiased", { n: 2, startMs: 30_000 });
    expect(turnOf([note], biased).compare(late)).toEqual({
      flagged: [],
      compared: 0,
      unavailable: 1,
    });
  });

  it("reads by alignment when the biased words have no timings, whatever the evidence's interpolated window", () => {
    const biased = utterance(SAID, "biased", { words: false });
    const unbiased = utterance(
      "Debrief from Atmo Systems. Raj Patel says finance wants to restart the onboarding package.",
      "unbiased",
      { n: 2, startMs: 9_000 }, // timed, but on a window the biased side never had
    );
    const [flagged] = turnOf([note], biased).compare(unbiased).flagged;
    expect(flagged?.conflict?.unbiased).toMatchObject({
      text: "Atmo Systems",
      audioMs: [unbiased.startMs, unbiased.endMs], // the whole utterance's span
    });
    expect(flagged?.target?.decision).toBe("ask");
  });

  it("flags an undecided target without a downgrade, and skips one no name was said for", () => {
    const said = "Met Dana Lee at Acme Corp. She wants the pricing breakdown.";
    const demo = buildLinkIndex(DEMO_ENTITIES);
    const drafts: ToolProposal[] = [
      {
        type: "task",
        target: { quote: "Dana Lee", kind: "contact", company: null },
        fields: { title: { value: "Send the pricing breakdown", quote: "the pricing breakdown" } },
      } as ToolProposal,
      {
        type: "note",
        target: null, // implied: the open account
        fields: {
          body: {
            value: "She wants the pricing breakdown.",
            quote: "She wants the pricing breakdown",
          },
        },
      },
    ];
    const turn = turnOf(drafts, utterance(said, "biased"), {
      focusEntityId: DEMO_FOCUS_ID,
      index: demo,
    });
    expect(turn.links.map((link) => link.target.decision)).toEqual(["ask", "linked"]);
    expect(turn.links[1]?.mention).toBeNull();
    const result = turn.compare(
      utterance("Met Gina Low at Acme Corp. She wants the pricing breakdown.", "unbiased", {
        n: 2,
      }),
    );
    expect(result.compared).toBe(1); // the implied target has no words to reread
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0]).toMatchObject({
      flags: [{ kind: "witness_conflict", field: "target" }],
      target: null,
      conflict: { biased: { text: "Dana Lee" }, unbiased: { text: "Gina Low" } },
    });
  });
});

describe("understandTurn's link context", () => {
  it("hands on what each target's linker read: its mention, kinds, earlier links, and the turn's other names", () => {
    const said =
      "Blue Harbor Analytics wants to start in January. Kathryn Moore needs the order form";
    const turn = understandTurn(
      [
        {
          type: "note",
          target: { quote: "Blue Harbor Analytics", kind: "company", company: null },
          fields: {
            body: { value: "wants to start in January", quote: "wants to start in January" },
          },
        },
        {
          type: "task",
          target: { quote: "Kathryn Moore", kind: "contact", company: null },
          fields: {
            title: { value: "Send the order form", quote: "the order form" },
            dueDate: null,
          },
        },
      ],
      {
        utterances: [utterance(said, "biased")],
        session: { index: INDEX, focusEntityId: null, recent: ["ct_001"] },
        callTime: CALL_TIME,
        timeZone: TIME_ZONE,
      },
    );
    expect(turn.links).toHaveLength(2);
    const [company, contact] = turn.links;
    expect(company).toEqual({
      mention: linkerMention("Blue Harbor Analytics", "company", null),
      kinds: ["company", "contact", "deal"],
      recent: ["ct_001"],
      turnMentions: [{ text: "Kathryn Moore", kind: "contact", companyText: null }],
    });
    // The second proposal saw the first one's link, as the linker did.
    expect(contact?.recent).toEqual(["co_037", "ct_001"]);
    expect(contact?.turnMentions).toEqual([
      { text: "Blue Harbor Analytics", kind: "company", companyText: null },
    ]);
  });
});
