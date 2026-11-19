// The key never appears in an error, a log line, a returned object, or a cassette (spec WP5
// tests; threat model "The LLM key inside SessionDO"). Stricter than an exact match: no run of
// 8 characters of the key may appear, as in the web app's leak suites.
import { containsKeyShape, type LlmProvider } from "@earshot/core";
import { findSecretFragment } from "@earshot/keys/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtractionError } from "../src/errors";
import { createProposalExtractor } from "../src/extractor";
import { CASSETTES, cassette, createCassetteFetch, SCENARIOS, scenario } from "../src/testing";
import { runTurn } from "../src/turn";

const KEPT = ["content-type", "retry-after", "retry-after-ms"];

const CANARIES: Readonly<Record<LlmProvider, string>> = {
  anthropic: "sk-ant-api03-CANARYqx7Lm2Vb9Tz4Rk8Wn3Hs6Jd1Pf5Gc0Ya-AAAAAAAA",
  groq: "gsk_CANARYqx7Lm2Vb9Tz4Rk8Wn3Hs6Jd1Pf5Gc0YaBbBbBbBb",
};

/** Everything an error exposes: message, stack, own properties, and its JSON. */
function dumpError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const own = Object.fromEntries(
    Object.getOwnPropertyNames(error).map((name) => [
      name,
      (error as unknown as Record<string, unknown>)[name],
    ]),
  );
  return [String(error), error.stack ?? "", JSON.stringify(own), JSON.stringify(error)].join("\n");
}

function expectNoKey(text: string, key: string, where: string) {
  expect(findSecretFragment(text, key), where).toBeUndefined();
}

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  const capture = (...args: unknown[]) => {
    logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
  vi.spyOn(process, "emitWarning").mockImplementation((warning: string | Error) => {
    logged.push(String(warning));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(["anthropic", "groq"] as const)("%s: the key stays out", (provider) => {
  const key = CANARIES[provider];

  it.each(SCENARIOS[provider].map((s) => s.name))("of every result and error: %s", async (name) => {
    const fixture = scenario(provider, name);
    // The whole turn, as SessionDO runs it.
    const turn = await runTurn({
      extractor: createProposalExtractor({
        provider,
        fetch: createCassetteFetch(cassette(provider, name)),
      }),
      ...fixture.turn,
      apiKey: key,
      signal: new AbortController().signal,
      sleep: async () => {},
    });
    expectNoKey(JSON.stringify(turn), key, "runTurn result");
    // And the extractor alone, so its errors are seen before runTurn folds them into outcomes.
    const extractor = createProposalExtractor({
      provider,
      fetch: createCassetteFetch(cassette(provider, name)),
    });
    try {
      const result = await extractor.extract({
        ...fixture.turn,
        apiKey: key,
        signal: new AbortController().signal,
      });
      expectNoKey(JSON.stringify(result), key, "extract result");
    } catch (error) {
      expect(error).toBeInstanceOf(ExtractionError);
      expectNoKey(dumpError(error), key, "extraction error");
    }
    expectNoKey(JSON.stringify(extractor), key, "extractor");
    expectNoKey(logged.join("\n"), key, "console");
    // Nothing is logged at all: no SDK warning fires for these requests.
    expect(logged).toEqual([]);
  });

  it("even when the provider echoes the key back in its body and headers", async () => {
    const echoes: [number, Record<string, string>][] = [
      [401, {}],
      [429, { "retry-after": "1" }],
      [500, {}],
      [400, {}],
    ];
    for (const [status, extraHeaders] of echoes) {
      const echo = async () =>
        new Response(
          JSON.stringify(
            provider === "anthropic"
              ? {
                  type: "error",
                  error: { type: "authentication_error", message: `invalid x-api-key: ${key}` },
                }
              : {
                  error: {
                    message: `Invalid API Key ${key}`,
                    type: "invalid_request_error",
                    code: "tool_use_failed",
                    failed_generation: key,
                  },
                },
          ),
          {
            status,
            headers: { "content-type": "application/json", "x-echo": key, ...extraHeaders },
          },
        );
      const fixture = scenario(provider, "demo-turn-4");
      const extractor = createProposalExtractor({ provider, fetch: echo as typeof fetch });
      const failure = await extractor
        .extract({ ...fixture.turn, apiKey: key, signal: new AbortController().signal })
        .then(
          (result) => JSON.stringify(result),
          (error: unknown) => dumpError(error),
        );
      expectNoKey(failure, key, `extract against an echoing ${status}`);
      const turn = await runTurn({
        extractor,
        ...fixture.turn,
        apiKey: key,
        signal: new AbortController().signal,
        sleep: async () => {},
      });
      expectNoKey(JSON.stringify(turn), key, `runTurn against an echoing ${status}`);
    }
    expectNoKey(logged.join("\n"), key, "console");
  });

  it("of the committed cassettes, which store no request headers at all", () => {
    const file = CASSETTES[provider];
    expectNoKey(JSON.stringify(file), key, "cassettes");
    expect(containsKeyShape(JSON.stringify(file))).toBe(false);
    for (const recorded of Object.values(file.cassettes)) {
      for (const { request, response } of recorded.interactions) {
        expect(Object.keys(request).sort()).toEqual(["excerpt", "method", "path"]);
        expect(Object.keys(response.headers).filter((name) => !KEPT.includes(name))).toEqual([]);
      }
    }
  });
});
