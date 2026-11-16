import { describe, expect, it } from "vitest";
import { createProposalExtractor } from "../src/extractor";
import { aiGatewayFromEnv, providerEndpoint } from "../src/gateway";
import { SCENARIO_API_KEY, scenario } from "../src/testing/scenarios";

const gateway = { accountId: "0123456789abcdef0123456789abcdef", gatewayId: "earshot-dev" };

describe("providerEndpoint", () => {
  it("goes straight to each provider by default, with an explicit base URL", () => {
    expect(providerEndpoint("anthropic", null)).toEqual({
      baseURL: "https://api.anthropic.com/v1",
      headers: {},
    });
    expect(providerEndpoint("groq", undefined).baseURL).toBe("https://api.groq.com/openai/v1");
  });

  it("points at AI Gateway with logging off when a gateway is configured", () => {
    expect(providerEndpoint("groq", gateway)).toEqual({
      baseURL: `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/earshot-dev/groq`,
      headers: { "cf-aig-collect-log": "false" },
    });
    expect(providerEndpoint("anthropic", gateway).baseURL).toBe(
      `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/earshot-dev/anthropic/v1`,
    );
  });

  it("refuses ids that could change the URL", () => {
    expect(() => providerEndpoint("groq", { ...gateway, gatewayId: "../evil" })).toThrow(
      RangeError,
    );
  });
});

describe("aiGatewayFromEnv", () => {
  it("is off unless both variables are set", () => {
    expect(aiGatewayFromEnv({})).toBeNull();
    expect(aiGatewayFromEnv({ AI_GATEWAY_ACCOUNT_ID: gateway.accountId })).toBeNull();
    expect(
      aiGatewayFromEnv({
        AI_GATEWAY_ACCOUNT_ID: gateway.accountId,
        AI_GATEWAY_ID: " earshot-dev ",
      }),
    ).toEqual(gateway);
  });

  it("throws on a value that isn't an id", () => {
    expect(() =>
      aiGatewayFromEnv({ AI_GATEWAY_ACCOUNT_ID: gateway.accountId, AI_GATEWAY_ID: "a/b" }),
    ).toThrow(RangeError);
  });
});

describe("requests through the gateway", () => {
  for (const provider of ["anthropic", "groq"] as const) {
    it(`${provider}: go to the gateway with the user's key in the provider's own header`, async () => {
      const seen: Request[] = [];
      const fixture = scenario(provider, "demo-turn-4");
      const capture = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        seen.push(new Request(input, init));
        const response = fixture.responses[0];
        if (!response) throw new Error("no response");
        return new Response(JSON.stringify(response.body), {
          status: 200,
          headers: response.headers,
        });
      };
      const extractor = createProposalExtractor({
        provider,
        fetch: capture as typeof fetch,
        gateway,
      });
      const result = await extractor.extract({
        ...fixture.turn,
        apiKey: SCENARIO_API_KEY,
        signal: new AbortController().signal,
      });
      expect(result.drafts).toHaveLength(1);
      const [request] = seen;
      expect(request?.url).toBe(
        provider === "anthropic"
          ? `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/earshot-dev/anthropic/v1/messages`
          : `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/earshot-dev/groq/chat/completions`,
      );
      expect(request?.headers.get("cf-aig-collect-log")).toBe("false");
      if (provider === "anthropic") {
        expect(request?.headers.get("x-api-key")).toBe(SCENARIO_API_KEY);
      } else {
        expect(request?.headers.get("authorization")).toBe(`Bearer ${SCENARIO_API_KEY}`);
      }
    });
  }
});
