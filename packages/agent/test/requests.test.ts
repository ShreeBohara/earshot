// What each adapter puts on the wire, read from the full request (cassettes keep only an excerpt).
import type { LlmProvider } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { createProposalExtractor } from "../src/extractor";
import { SCENARIO_API_KEY, scenario } from "../src/testing";
import { runTurn } from "../src/turn";

interface Seen {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

/** A fetch that records full requests and answers with the scenario's first response. */
function capturing(provider: LlmProvider) {
  const seen: Seen[] = [];
  const fixture = scenario(provider, "demo-turn-4");
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(await request.text()),
    });
    const response = fixture.responses[0];
    if (!response) throw new Error("no response");
    return new Response(JSON.stringify(response.body), { status: 200, headers: response.headers });
  };
  return { seen, fetch: fetch as typeof globalThis.fetch, turn: fixture.turn };
}

describe("the Anthropic request", () => {
  it("forces one strict submit_proposals call on claude-haiku-5-5, with no sampling settings", async () => {
    const { seen, fetch, turn } = capturing("anthropic");
    await createProposalExtractor({ provider: "anthropic", fetch }).extract({
      ...turn,
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
    });
    const [request] = seen;
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers.get("x-api-key")).toBe(SCENARIO_API_KEY);
    expect(request?.headers.get("anthropic-version")).toBe("2023-06-01");
    const body = request?.body ?? {};
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: "submit_proposals",
      disable_parallel_tool_use: true,
    });
    const tools = body.tools as { name: string; strict?: boolean }[];
    expect(tools.map((tool) => [tool.name, tool.strict])).toEqual([["submit_proposals", true]]);
    // Haiku 5.5 refuses non-default sampling, and skips thinking on a forced tool call.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");
  });
});

describe("prompt v2 on the wire", () => {
  it("sends the open account, never the CRM list, through runTurn", async () => {
    const { seen, fetch, turn } = capturing("anthropic");
    await runTurn({
      extractor: createProposalExtractor({ provider: "anthropic", fetch }),
      ...turn,
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
    });
    const system = JSON.stringify(seen[0]?.body.system);
    expect(system).toContain("Open account: Acme Corp");
    for (const name of ["Akme Dynamics", "Acmi Dynamics", "Donna Lee", "Dana Li"]) {
      expect(system).not.toContain(name);
    }
  });
});

describe("the Groq request", () => {
  it("forces one submit_proposals call on gpt-oss-20b at the lowest reasoning effort, not strict", async () => {
    const { seen, fetch, turn } = capturing("groq");
    await createProposalExtractor({ provider: "groq", fetch }).extract({
      ...turn,
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
    });
    const [request] = seen;
    expect(request?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${SCENARIO_API_KEY}`);
    const body = request?.body ?? {};
    expect(body.model).toBe("openai/gpt-oss-20b");
    expect(body.reasoning_effort).toBe("low");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "submit_proposals" } });
    const tools = body.tools as { function: { name: string; strict?: boolean } }[];
    expect(tools.map((tool) => tool.function.name)).toEqual(["submit_proposals"]);
    expect(tools[0]?.function).not.toHaveProperty("strict");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });
});

describe.each(["anthropic", "groq"] as const)("%s: keys", (provider) => {
  it("builds the provider per call, so each call carries only its own key", async () => {
    const { seen, fetch, turn } = capturing(provider);
    const extractor = createProposalExtractor({ provider, fetch });
    const keys = ["first-user-key-0000000000000000000", "second-user-key-111111111111111111"];
    for (const apiKey of keys) {
      await extractor.extract({ ...turn, apiKey, signal: new AbortController().signal });
    }
    const sent = seen.map((request) =>
      provider === "anthropic"
        ? request.headers.get("x-api-key")
        : request.headers.get("authorization")?.replace(/^Bearer /, ""),
    );
    expect(sent).toEqual(keys);
    expect(JSON.stringify(extractor)).not.toContain("user-key");
  });

  it("refuses an empty key without calling the provider", async () => {
    const { seen, fetch, turn } = capturing(provider);
    const extract = createProposalExtractor({ provider, fetch }).extract({
      ...turn,
      apiKey: "  ",
      signal: new AbortController().signal,
    });
    await expect(extract).rejects.toMatchObject({ code: "key_rejected", attempts: 0 });
    expect(seen).toEqual([]);
  });

  it("only runs the provider's supported model", () => {
    expect(() => createProposalExtractor({ provider, model: "some-other-model" })).toThrow(
      RangeError,
    );
  });
});
