import { describe, expect, it, vi } from "vitest";
import {
  containsSecret,
  createRedactingLogger,
  isProviderId,
  last4,
  PROVIDER_IDS,
  PROVIDERS,
  redact,
  redactValue,
  validateKey,
} from "../src";

// A canary: if this string shows up in any output, a key has leaked.
const CANARY = "sk-proj-CANARYcanary0123456789abcdefghijklmnopqrstuv";

describe("providers", () => {
  it("define a validation endpoint for every provider", () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDERS[id].validate.url).toMatch(/^https:\/\//);
      expect(isProviderId(id)).toBe(true);
    }
    expect(isProviderId("myspace")).toBe(false);
  });

  it("show only the last four characters", () => {
    expect(last4(CANARY)).toBe("stuv");
    expect(last4("abc")).toBe("••••");
  });
});

describe("validateKey", () => {
  it("reports a working key", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await validateKey("openai", CANARY, fetchImpl)).toEqual({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("explains a rejected key without echoing it", async () => {
    const fetchImpl = vi.fn(async () => new Response(`bad key ${CANARY}`, { status: 401 }));
    const result = await validateKey("anthropic", CANARY, fetchImpl);
    expect(result.ok).toBe(false);
    expect(containsSecret(JSON.stringify(result), CANARY)).toBe(false);
  });

  it("explains a network failure without echoing the key", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED with header ${CANARY}`);
    });
    const result = await validateKey("deepgram", CANARY, fetchImpl);
    expect(result).toMatchObject({ ok: false });
    expect(containsSecret(JSON.stringify(result), CANARY)).toBe(false);
  });
});

describe("redaction", () => {
  it("removes a known secret and anything shaped like a provider key", () => {
    const text = `key=${CANARY} anthropic=sk-ant-api03-abcdefghijklmnopqrstuvwxyz google=AIzaSyA-abcdefghijklmnopqrstuvwxyz01234`;
    const out = redact(text, [CANARY]);
    expect(out).not.toContain(CANARY);
    expect(out).not.toMatch(/sk-ant-|AIzaSy/);
  });

  it("redacts deep inside structured values, including JSON-escaped forms", () => {
    const value = { error: { message: `upstream said ${CANARY}` }, list: [CANARY] };
    const out = JSON.stringify(redactValue(value, [CANARY]));
    expect(containsSecret(out, CANARY)).toBe(false);
  });

  it("never lets a logged key reach the sink", () => {
    const lines: string[] = [];
    const log = createRedactingLogger(
      (line) => lines.push(line),
      () => [CANARY],
    );
    log.error("provider call failed", { headers: { authorization: `Bearer ${CANARY}` } });
    log.info(`retrying with ${CANARY}`);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(containsSecret(line, CANARY)).toBe(false);
  });
});
