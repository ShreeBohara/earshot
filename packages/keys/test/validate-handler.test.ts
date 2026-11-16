import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  type FetchLike,
  findSecretFragment,
  handleValidateKey,
  type Logger,
  PROVIDER_IDS,
  PROVIDER_KEY_HEADER,
  PROVIDERS,
} from "../src";

// The canary. If any eight characters of it in a row surface anywhere a test can see, it leaked.
const KEY = "sk-proj-VALIDATEcanaryQz7Xw2Lp9Rt4Mn8Bv6CxKs5Hg";

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

let logger: { [Level in keyof Logger]: Mock<Logger[Level]> };
let consoleSpies: Array<{ mock: { calls: unknown[][] } }>;

beforeEach(() => {
  // A plain spy, not a redacting logger: the test must see exactly what the handler logs.
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  consoleSpies = CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A provider that answers `status` and quotes the key it was sent, in its body and headers. */
function echoingFetch(status: number): Mock<FetchLike> {
  return vi.fn<FetchLike>(async (_url, init) => {
    const sent = Object.values(init.headers as Record<string, string>).join(" ");
    return new Response(
      JSON.stringify({ error: { message: `Incorrect API key provided: ${sent}`, key: KEY } }),
      {
        status,
        headers: {
          "content-type": "application/json",
          "x-request-key": KEY,
          "www-authenticate": `Bearer error="invalid_token", error_description="${KEY}"`,
        },
      },
    );
  });
}

const throwingFetch = () =>
  vi.fn<FetchLike>(async (url, init) => {
    throw new Error(`connect ECONNREFUSED ${url} with ${JSON.stringify(init.headers)}`);
  });

/** Never answers; only the handler's timeout ends the wait. */
const hangingFetch = () =>
  vi.fn<FetchLike>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error(`aborted ${KEY}`)));
      }),
  );

function validationRequest(
  options: { body?: unknown; key?: string; method?: string; url?: string } = {},
): Request {
  const { body = { provider: "openai" }, key = KEY, method = "POST" } = options;
  const headers = new Headers({ "content-type": "application/json" });
  if (key) headers.set(PROVIDER_KEY_HEADER, key);
  return new Request(options.url ?? "https://earshot.test/api/keys/validate", {
    method,
    headers,
    ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

/** Everything the outside world could see: the response, its headers, and every log call. */
async function observed(response: Response): Promise<string> {
  const headers = JSON.stringify([...response.headers]);
  const logged = Object.values(logger).flatMap((spy) => spy.mock.calls);
  const consoled = consoleSpies.flatMap((spy) => spy.mock.calls);
  return [await response.text(), headers, JSON.stringify(logged), JSON.stringify(consoled)].join(
    "\n",
  );
}

async function handle(request: Request, fetchImpl: FetchLike, timeoutMs?: number) {
  const response = await handleValidateKey(request, { fetch: fetchImpl, logger, timeoutMs });
  const seen = await observed(response.clone());
  expect(findSecretFragment(seen, KEY), "a fragment of the key leaked").toBeUndefined();
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { status: response.status, body: await response.json() };
}

describe("handleValidateKey: what the provider says", () => {
  const outcomes = [
    { name: "accepts the key", fetch: () => echoingFetch(200), ok: true, reason: undefined },
    { name: "rejects it (401)", fetch: () => echoingFetch(401), ok: false, reason: "rejected" },
    { name: "rejects it (403)", fetch: () => echoingFetch(403), ok: false, reason: "rejected" },
    {
      name: "limits requests (429)",
      fetch: () => echoingFetch(429),
      ok: false,
      reason: "rate_limited",
    },
    {
      name: "fails (500)",
      fetch: () => echoingFetch(500),
      ok: false,
      reason: "upstream_error",
    },
    {
      name: "can't be reached",
      fetch: throwingFetch,
      ok: false,
      reason: "unreachable",
    },
    { name: "never answers", fetch: hangingFetch, ok: false, reason: "unreachable" },
  ] as const;

  it.each(outcomes)("$name: a fixed answer, and no trace of the key anywhere", async (outcome) => {
    for (const provider of PROVIDER_IDS) {
      const fetchImpl = outcome.fetch();
      const result = await handle(validationRequest({ body: { provider } }), fetchImpl, 50);

      expect(result).toEqual({
        status: 200,
        body: {
          ok: outcome.ok,
          provider,
          last4: KEY.slice(-4),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("sends the key to its provider only, in that provider's own header", async () => {
    for (const provider of PROVIDER_IDS) {
      const fetchImpl = echoingFetch(200);
      await handle(validationRequest({ body: { provider } }), fetchImpl);

      const { url, headers } = PROVIDERS[provider].validate;
      expect(fetchImpl).toHaveBeenCalledWith(url, {
        method: "GET",
        headers: headers(KEY),
        signal: expect.any(AbortSignal),
      });
    }
  });

  it("logs outcomes as codes", async () => {
    await handle(validationRequest({ body: { provider: "groq" } }), echoingFetch(401));
    expect(logger.info).toHaveBeenCalledWith("provider key not accepted", {
      provider: "groq",
      reason: "rejected",
      status: 401,
    });
  });
});

describe("handleValidateKey: requests it refuses", () => {
  const refusals: ReadonlyArray<{
    name: string;
    request: () => Request;
    status: number;
    body: Record<string, unknown>;
  }> = [
    {
      name: "no key header",
      request: () => validationRequest({ key: "" }),
      status: 400,
      body: { ok: false, provider: "openai", reason: "missing_key" },
    },
    {
      name: "a blank key header",
      request: () => validationRequest({ key: "   " }),
      status: 400,
      body: { ok: false, provider: "openai", reason: "missing_key" },
    },
    {
      name: "the key in the body instead of the header",
      request: () => validationRequest({ key: "", body: { provider: "openai", key: KEY } }),
      status: 400,
      body: { ok: false, provider: "openai", reason: "missing_key" },
    },
    {
      name: "the key in the URL instead of the header",
      request: () =>
        validationRequest({ key: "", url: `https://earshot.test/api/keys/validate?key=${KEY}` }),
      status: 400,
      body: { ok: false, provider: "openai", reason: "missing_key" },
    },
    {
      name: "the key pasted as the provider",
      request: () => validationRequest({ body: { provider: KEY } }),
      status: 400,
      body: { ok: false, reason: "unknown_provider" },
    },
    {
      name: "a body that isn't JSON",
      request: () => validationRequest({ body: `provider=openai&key=${KEY}` }),
      status: 400,
      body: { ok: false, reason: "invalid_request" },
    },
    {
      name: "JSON that isn't an object with a provider",
      request: () => validationRequest({ body: [KEY] }),
      status: 400,
      body: { ok: false, reason: "invalid_request" },
    },
    {
      name: "an oversized body",
      request: () => validationRequest({ body: { provider: "openai", padding: "x".repeat(2000) } }),
      status: 400,
      body: { ok: false, reason: "invalid_request" },
    },
    {
      name: "a GET",
      request: () => validationRequest({ method: "GET" }),
      status: 405,
      body: { ok: false, reason: "method_not_allowed" },
    },
  ];

  it.each(refusals)("refuses $name, never calling the provider", async (refusal) => {
    const fetchImpl = echoingFetch(200);
    expect(await handle(refusal.request(), fetchImpl)).toEqual({
      status: refusal.status,
      body: refusal.body,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("tells a client which method to use", async () => {
    const response = await handleValidateKey(validationRequest({ method: "GET" }), {
      fetch: echoingFetch(200),
    });
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("handleValidateKey: no storage", () => {
  it("has nothing to store with: the package depends on no database, and the handler imports only validation and redaction", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const dependencies = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    });
    const storage = /^@earshot\/db$|drizzle|postgres|neon|pglite|^pg$|sqlite|kysely|prisma/;
    expect(dependencies.filter((name) => storage.test(name))).toEqual([]);

    const source = readFileSync(new URL("../src/validate-handler.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(["./providers", "./redact"]);
  });
});
