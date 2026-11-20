// Both adapters against the committed cassettes: the demo session's turns (valid output), invalid
// output then a retry, invalid output twice, rate limits, and how errors map to outcomes. The
// demo session runs with Acme Corp open, so turns that name no record target it.
import type { LlmProvider, RiskFlagV2, TargetDecision } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { DEMO_COMPANY_ID, DEMO_DEAL_ID, DEMO_UTTERANCES } from "../src/testing";
import { expectValidPayloads, replay } from "./helpers";

interface Expected {
  readonly outcome: "proposals" | "nothing_to_propose";
  readonly proposals: readonly {
    readonly type: string;
    readonly decision: TargetDecision;
    readonly entityId: string | null;
    readonly fields: readonly string[];
    readonly riskFlags: readonly RiskFlagV2[];
  }[];
}

const ASK: RiskFlagV2 = { kind: "ambiguous_target", field: "target" };
const IMPLIED: RiskFlagV2 = { kind: "implied_target", field: "target" };

const DEMO_EXPECTED: readonly Expected[] = [
  {
    // "Dana Lee" sounds like both Donna Lee and Dana Li: the linker asks.
    outcome: "proposals",
    proposals: [
      {
        type: "contact",
        decision: "ask",
        entityId: null,
        fields: ["name", "title", "company"],
        riskFlags: [ASK],
      },
    ],
  },
  { outcome: "nothing_to_propose", proposals: [] },
  {
    // "the deal" names nothing: the open account's only deal.
    outcome: "proposals",
    proposals: [
      {
        type: "deal_update",
        decision: "linked",
        entityId: DEMO_DEAL_ID,
        fields: ["stage"],
        riskFlags: [IMPLIED],
      },
    ],
  },
  {
    // "Dana" again: Donna Lee or Dana Li. The due date's reading agrees, so it isn't flagged.
    outcome: "proposals",
    proposals: [
      {
        type: "task",
        decision: "ask",
        entityId: null,
        fields: ["title", "dueDate"],
        riskFlags: [ASK],
      },
    ],
  },
  {
    outcome: "proposals",
    proposals: [
      {
        type: "note",
        decision: "linked",
        entityId: DEMO_COMPANY_ID,
        fields: ["body"],
        riskFlags: [IMPLIED],
      },
    ],
  },
  {
    outcome: "proposals",
    proposals: [
      {
        type: "commitment",
        decision: "linked",
        entityId: DEMO_COMPANY_ID,
        fields: ["text", "counterpart"],
        riskFlags: [IMPLIED],
      },
    ],
  },
  { outcome: "nothing_to_propose", proposals: [] },
];

const PROVIDERS: readonly LlmProvider[] = ["anthropic", "groq"];

describe.each(PROVIDERS)("%s adapter", (provider) => {
  describe("valid output: the demo session", () => {
    it.each(DEMO_EXPECTED.map((expected, index) => [index + 1, expected] as const))(
      "turn %i",
      async (turn, expected) => {
        const { result, working, sleeps } = await replay(provider, `demo-turn-${turn}`);
        expect(result.outcome).toBe(expected.outcome);
        expect(
          result.proposals.map((proposal) => ({
            type: proposal.type,
            decision: proposal.target.decision,
            entityId: proposal.target.entityId,
            fields: Object.keys(proposal.fields),
            riskFlags: proposal.riskFlags,
          })),
        ).toEqual(expected.proposals);
        for (const proposal of result.proposals) expect(proposal.linker).toBe("linker.v1");
        const utterance = DEMO_UTTERANCES[turn - 1];
        for (const proposal of result.proposals) {
          for (const field of Object.values(proposal.fields)) {
            expect(field.evidence.utteranceId).toBe(utterance?.utteranceId);
          }
        }
        expect(result.completed).toMatchObject({
          outcome: expected.outcome,
          utteranceIds: [utterance?.utteranceId],
          proposalIds: result.proposals.map((proposal) => proposal.proposalId),
          attempts: 1,
        });
        expect(result.usage).toMatchObject({ kind: "llm", provider, priceTable: "2026-11-15" });
        expect(result.error).toBeNull();
        expect(working).toEqual([{ state: "thinking" }]);
        expect(sleeps).toEqual([]);
        expectValidPayloads(result);
      },
    );

    it("keeps the evidence the transcript supports, word timings included", async () => {
      const { result } = await replay(provider, "demo-turn-1");
      expect(result.proposals[0]?.target).toMatchObject({
        decision: "ask",
        kind: "contact",
        mention: {
          quote: "Dana Lee",
          evidence: { span: [48, 56], audioMs: [4420, 4960], confidence: 0.81 },
        },
        // The company said with her links on its own: it's Acme Corp.
        company: { quote: "Acme Corp", entityId: DEMO_COMPANY_ID },
        candidates: [
          { entityId: "ct_112", p: 0.5 },
          { entityId: "ct_145", p: 0.5 },
          { entityId: null, p: 0 },
        ],
      });
      expect(result.proposals[0]?.fields).toMatchObject({
        name: {
          value: "Dana Lee",
          evidence: { span: [48, 56], audioMs: [4420, 4960], confidence: 0.81 },
        },
        title: {
          value: "VP of Operations",
          evidence: { span: [68, 84], audioMs: [5760, 6830], confidence: 0.88 },
        },
        company: {
          value: "Acme Corp",
          evidence: { span: [33, 42], audioMs: [3410, 4020], confidence: 0.9 },
        },
      });
    });
  });

  it("invalid output, then a valid retry: proposals after two calls, both billed", async () => {
    const { result, sleeps } = await replay(provider, "invalid-then-valid");
    expect(result.outcome).toBe("proposals");
    expect(result.completed.attempts).toBe(2);
    expect(result.proposals.map((proposal) => proposal.type)).toEqual(["task"]);
    expect(result.usage?.inputTokens).toBe(1474 + 1538);
    expect(sleeps).toEqual([]); // a validation retry doesn't wait
    expectValidPayloads(result);
  });

  it("invalid output twice: invalid_output, no proposals, the calls still billed", async () => {
    const { result } = await replay(provider, "invalid-twice");
    expect(result.outcome).toBe("invalid_output");
    expect(result.proposals).toEqual([]);
    expect(result.completed).toMatchObject({ attempts: 2, proposalIds: [] });
    expect(result.error).toBeNull();
    expect(result.failure).toEqual({ code: "invalid_output", detail: "validation_failed_twice" });
    expect(result.usage?.costUsd).toBeGreaterThan(0);
    expectValidPayloads(result);
  });

  it("a 429 with Retry-After: waits what the provider asked, says so, then succeeds", async () => {
    const { result, sleeps, working } = await replay(provider, "rate-limited-then-ok");
    expect(result.outcome).toBe("proposals");
    expect(result.completed.attempts).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(working).toEqual([{ state: "thinking" }, { state: "retrying", retryInMs: 1000 }]);
    expect(result.usage?.inputTokens).toBe(1474); // the 429 billed nothing
    expectValidPayloads(result);
  });

  it("a rejected key: provider_error with llm_key_rejected, and no retry", async () => {
    const { result, sleeps } = await replay(provider, "key-rejected");
    expect(result.outcome).toBe("provider_error");
    expect(result.completed.attempts).toBe(1);
    expect(result.error).toEqual({ code: "llm_key_rejected", retryable: false });
    expect(result.failure).toEqual({ code: "key_rejected", detail: "http_401" });
    expect(result.usage).toBeNull();
    expect(sleeps).toEqual([]);
    expectValidPayloads(result);
  });
});

describe("anthropic adapter, specific failures", () => {
  it("429 until attempts run out: rate_limited with llm_rate_limited", async () => {
    const { result, sleeps } = await replay("anthropic", "rate-limited-throughout");
    expect(result.outcome).toBe("rate_limited");
    expect(result.completed.attempts).toBe(3);
    expect(sleeps).toEqual([1000, 1000]);
    expect(result.error).toEqual({ code: "llm_rate_limited", retryable: true });
    expect(result.usage).toBeNull();
  });

  it("529 overloaded throughout: retried with backoff, then provider_error", async () => {
    const { result, sleeps } = await replay("anthropic", "overloaded-throughout");
    expect(result.outcome).toBe("provider_error");
    expect(result.completed.attempts).toBe(3);
    expect(sleeps).toEqual([188, 375]); // 250 then 500, with equal jitter at 0.5
    expect(result.error).toEqual({ code: "llm_unavailable", retryable: true });
    expect(result.failure).toEqual({ code: "provider_error", detail: "http_529" });
  });

  it("400 bad request: provider_error, not retried", async () => {
    const { result } = await replay("anthropic", "bad-request");
    expect(result).toMatchObject({
      outcome: "provider_error",
      completed: { attempts: 1 },
      error: { code: "llm_unavailable", retryable: false },
      failure: { code: "provider_error", detail: "http_400" },
    });
  });

  it("a refusal: provider_error, not retried, and the tokens it used are billed", async () => {
    const { result } = await replay("anthropic", "refusal");
    expect(result).toMatchObject({
      outcome: "provider_error",
      completed: { attempts: 1 },
      error: { code: "llm_unavailable", retryable: false },
      failure: { code: "refused", detail: "content_filter" },
    });
    expect(result.usage).toMatchObject({ inputTokens: 1474, outputTokens: 3 });
  });
});

describe("groq adapter, specific failures", () => {
  it("400 tool_use_failed is invalid output: the retry gets the problems and succeeds", async () => {
    const { result, fetch } = await replay("groq", "tool-use-failed-then-valid");
    expect(result.outcome).toBe("proposals");
    expect(result.completed.attempts).toBe(2);
    expect(fetch.played).toBe(2);
    expect(result.usage?.inputTokens).toBe(1538); // the 400 reported no usage
  });

  it("a reply with no tool call is invalid output, and gets the retry", async () => {
    const { result } = await replay("groq", "text-then-valid");
    expect(result.outcome).toBe("proposals");
    expect(result.completed.attempts).toBe(2);
  });

  it("a 503 is retried after a backoff", async () => {
    const { result, sleeps } = await replay("groq", "unavailable-then-ok");
    expect(result.outcome).toBe("proposals");
    expect(sleeps).toEqual([188]);
  });
});
