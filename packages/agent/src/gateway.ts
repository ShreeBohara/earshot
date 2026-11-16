// Where each provider's requests go: straight to the provider by default, or through Cloudflare
// AI Gateway when the edge Worker sets AI_GATEWAY_ACCOUNT_ID and AI_GATEWAY_ID (spec decision 6,
// WP5 step 3). Through the gateway, the provider's `baseURL` points at it and the user's key
// still rides in the provider's own auth header, so the gateway forwards it and stores nothing.
import type { LlmProvider } from "@earshot/core";

export interface AiGatewayConfig {
  readonly accountId: string;
  readonly gatewayId: string;
}

/**
 * The providers' own base URLs, given explicitly: `createAnthropic` would otherwise read
 * ANTHROPIC_BASE_URL from the environment, and with `nodejs_compat` a Worker's vars can appear
 * there, which could send a user's key somewhere unintended.
 */
export const DIRECT_BASE_URLS: Readonly<Record<LlmProvider, string>> = {
  anthropic: "https://api.anthropic.com/v1",
  groq: "https://api.groq.com/openai/v1",
};

/**
 * The path after `/v1/{account}/{gateway}` for each provider. Groq's is documented: the gateway
 * replaces `https://api.groq.com/openai/v1`. Anthropic's isn't; `/anthropic/v1` follows from the
 * gateway forwarding the rest of the path to `api.anthropic.com` and the AI SDK appending
 * `/messages`. Confirm both with one live call each (spec Appendix B, question 16).
 */
export const AI_GATEWAY_PATHS: Readonly<Record<LlmProvider, string>> = {
  anthropic: "anthropic/v1",
  groq: "groq",
};

/** Sent on every gateway request, so the gateway keeps no log of the prompt or the response. */
export const AI_GATEWAY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cf-aig-collect-log": "false",
});

const GATEWAY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The gateway config from the edge Worker's variables, or null when either is unset. A value
 * that couldn't be part of a gateway URL throws, so a typo fails loudly instead of routing the
 * key elsewhere.
 */
export function aiGatewayFromEnv(env: {
  readonly AI_GATEWAY_ACCOUNT_ID?: string | undefined;
  readonly AI_GATEWAY_ID?: string | undefined;
}): AiGatewayConfig | null {
  const accountId = env.AI_GATEWAY_ACCOUNT_ID?.trim() ?? "";
  const gatewayId = env.AI_GATEWAY_ID?.trim() ?? "";
  if (accountId === "" || gatewayId === "") return null;
  if (!GATEWAY_ID.test(accountId) || !GATEWAY_ID.test(gatewayId)) {
    throw new RangeError("AI_GATEWAY_ACCOUNT_ID and AI_GATEWAY_ID must be letters, digits, - or _");
  }
  return { accountId, gatewayId };
}

/** The base URL and extra headers for one provider's requests. */
export function providerEndpoint(
  provider: LlmProvider,
  gateway: AiGatewayConfig | null | undefined,
): { readonly baseURL: string; readonly headers: Readonly<Record<string, string>> } {
  if (!gateway) return { baseURL: DIRECT_BASE_URLS[provider], headers: {} };
  if (!GATEWAY_ID.test(gateway.accountId) || !GATEWAY_ID.test(gateway.gatewayId)) {
    throw new RangeError("invalid AI Gateway account or gateway id");
  }
  return {
    baseURL: `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.gatewayId}/${AI_GATEWAY_PATHS[provider]}`,
    headers: AI_GATEWAY_HEADERS,
  };
}
