// Properties of the understanding step under fuzzed model output (Phase 4 spec §6, G2): whatever
// the model drafts, every field that survives carries evidence for words that are really in the
// turn, a target links only when its words were found (or the open account stands in), and every
// payload is a valid `proposal.created` v2. Seeded, so a failure reproduces.
import { ProposalCreatedV2, type UtteranceFinalV2 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { locateQuote } from "../src/evidence";
import type { ToolProposal, ToolTarget } from "../src/schema";
import { DEMO_COMPANY_ID, DEMO_SESSION, DEMO_UTTERANCES } from "../src/testing/scenarios";
import { understand } from "../src/understand";

/** mulberry32, as the evals' simulator seeds it. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const UTTERANCES: readonly UtteranceFinalV2[] = DEMO_UTTERANCES.slice(0, 6);
const JUNK = ["Atmas Group", "by Friday", "Zebulon", "fifty grand", "", "  ", "Acme", "the deal"];
const KINDS = ["company", "contact", "deal"] as const;

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

/** A run of whole words from one utterance, often recased, or junk the turn doesn't hold. */
function quoteOf(random: () => number): string {
  if (random() < 0.3) return pick(random, JUNK);
  const words = pick(random, UTTERANCES).text.split(" ");
  const start = Math.floor(random() * words.length);
  const length = 1 + Math.floor(random() * 4);
  const quote = words.slice(start, start + length).join(" ");
  return random() < 0.2 ? quote.toLowerCase() : quote;
}

function field(random: () => number, value?: string | number) {
  if (random() < 0.2) return null;
  const quote = quoteOf(random);
  return { value: value ?? (random() < 0.8 ? quote : pick(random, JUNK)), quote };
}

function target(random: () => number): ToolTarget | null {
  if (random() < 0.25) return null;
  return {
    quote: quoteOf(random),
    kind: pick(random, KINDS),
    company: random() < 0.3 ? { quote: quoteOf(random) } : null,
  };
}

function draft(random: () => number): ToolProposal {
  const date = random() < 0.5 ? "2026-11-12" : "2026-11-13";
  const required = () => field(random) ?? { value: "Send it", quote: quoteOf(random) };
  switch (pick(random, ["note", "task", "contact", "deal_update", "commitment", "meeting"])) {
    case "note":
      return { type: "note", target: target(random), fields: { body: required() } };
    case "task":
      return {
        type: "task",
        target: target(random),
        fields: { title: required(), dueDate: field(random, date) },
      };
    case "contact":
      return {
        type: "contact",
        fields: {
          name: required(),
          title: field(random),
          company: field(random),
          email: field(random),
          phone: field(random),
        },
      };
    case "deal_update":
      return {
        type: "deal_update",
        target: target(random),
        fields: {
          stage: field(random),
          amount: field(random, 50_000),
          closeDate: field(random, date),
        },
      };
    case "commitment":
      return {
        type: "commitment",
        target: target(random),
        fields: { text: required(), counterpart: field(random), dueDate: field(random, date) },
      };
    default:
      return {
        type: "meeting",
        target: target(random),
        fields: {
          title: required(),
          date: field(random, date),
          time: field(random, "15:00"),
          attendees: field(random),
        },
      };
  }
}

describe("understand, under fuzzed drafts", () => {
  it("gives every surviving field evidence of words in the turn, and never links unheard names", () => {
    const random = rng(20261120);
    let checked = 0;
    for (let run = 0; run < 400; run++) {
      const proposal = draft(random);
      const result = understand(proposal, {
        utterances: UTTERANCES,
        session: { ...DEMO_SESSION, focusEntityId: random() < 0.5 ? DEMO_COMPANY_ID : null },
        callTime: "2026-11-10T19:15:00.000Z",
        timeZone: "America/Los_Angeles",
      });
      if (result === null) continue;
      checked += 1;
      const payload = ProposalCreatedV2.parse({
        proposalId: "01a1c6e5-0000-7000-8000-000000000001",
        ...result,
      });
      const drafted = proposal.fields as Record<string, { quote: string } | null>;
      for (const [name, value] of Object.entries(payload.fields)) {
        const utterance = UTTERANCES.find((u) => u.utteranceId === value.evidence.utteranceId);
        expect(utterance, name).toBeDefined();
        const [start, end] = value.evidence.span;
        expect(start).toBeLessThan(end);
        expect(end).toBeLessThanOrEqual(utterance?.text.length ?? 0);
        // The span is exactly where the drafted quote is found.
        const location = locateQuote(drafted[name]?.quote ?? "", UTTERANCES);
        expect(location?.span, name).toEqual([start, end]);
      }
      const { target: linked } = payload;
      expect(linked.entityId !== null).toBe(linked.decision === "linked");
      expect(linked.candidates.length).toBeLessThanOrEqual(4);
      for (const candidate of linked.candidates) {
        expect(candidate.p).toBeGreaterThanOrEqual(0);
        expect(candidate.p).toBeLessThanOrEqual(1);
      }
      if (linked.mention) {
        const utterance = UTTERANCES.find(
          (u) => u.utteranceId === linked.mention?.evidence.utteranceId,
        );
        const [start, end] = linked.mention.evidence.span;
        expect(utterance?.text.slice(start, end)).toBe(linked.mention.quote);
      } else {
        // No words: only the open account may stand in, or nothing.
        expect(linked.decision === "none" || linked.basis === "focus").toBe(true);
      }
      if (
        payload.riskFlags.some((flag) => flag.kind === "unsupported" && flag.field === "target")
      ) {
        expect(linked.decision).toBe("none");
      }
    }
    expect(checked).toBeGreaterThan(200);
  }, 120_000); // 400 fuzzed drafts: well under a second alone, far slower on CI's busy runners
});
