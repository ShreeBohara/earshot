import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthConfigError,
  configuredSocialProviders,
  DEV_SECRET,
  readAuthConfig,
  secretValues,
  socialProviderIds,
} from "@/lib/auth/config";
import {
  createMagicLinkSender,
  EmailDeliveryError,
  EmailUnavailableError,
  RESEND_ENDPOINT,
} from "@/lib/auth/email";
import { memoryLogger, TEST_SECRET } from "./support/harness";

const URL_TO_SEND = "https://earshot.example/api/auth/magic-link/verify?token=TOKENxyzTOKENxyz";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readAuthConfig", () => {
  it("runs with no configuration in development", () => {
    const config = readAuthConfig({}, "development");
    expect(config).toMatchObject({
      mode: "development",
      secret: DEV_SECRET,
      baseURL: "http://localhost:3000",
      trustedOrigins: ["http://localhost:3000"],
      social: {},
      email: null,
    });
  });

  it("fails closed in production without a secret or base URL", () => {
    expect(() =>
      readAuthConfig({ BETTER_AUTH_URL: "https://earshot.example" }, "production"),
    ).toThrow(/BETTER_AUTH_SECRET is not set/);
    expect(() => readAuthConfig({ BETTER_AUTH_SECRET: TEST_SECRET }, "production")).toThrow(
      /BETTER_AUTH_URL is not set/,
    );
    expect(() =>
      readAuthConfig(
        { BETTER_AUTH_SECRET: DEV_SECRET, BETTER_AUTH_URL: "https://earshot.example" },
        "production",
      ),
    ).toThrow(AuthConfigError);
  });

  it("rejects short secrets and plain http outside localhost", () => {
    expect(() =>
      readAuthConfig(
        { BETTER_AUTH_SECRET: "too-short", BETTER_AUTH_URL: "https://earshot.example" },
        "production",
      ),
    ).toThrow(/at least 32 characters/);
    expect(() =>
      readAuthConfig(
        { BETTER_AUTH_SECRET: TEST_SECRET, BETTER_AUTH_URL: "http://earshot.example" },
        "production",
      ),
    ).toThrow(/https/);
    expect(
      readAuthConfig(
        { BETTER_AUTH_SECRET: TEST_SECRET, BETTER_AUTH_URL: "http://localhost:8787" },
        "production",
      ).baseURL,
    ).toBe("http://localhost:8787");
  });

  it("trusts the base URL's origin plus any listed origins", () => {
    const config = readAuthConfig(
      {
        BETTER_AUTH_SECRET: TEST_SECRET,
        BETTER_AUTH_URL: "https://earshot.example/some/path",
        BETTER_AUTH_TRUSTED_ORIGINS: " https://admin.earshot.example , https://earshot.example ",
      },
      "production",
    );
    expect(config.baseURL).toBe("https://earshot.example");
    expect(config.trustedOrigins).toEqual([
      "https://earshot.example",
      "https://admin.earshot.example",
    ]);
  });

  it("turns email on only with both an API key and a sender", () => {
    expect(readAuthConfig({ RESEND_API_KEY: "re_x" }, "development").email).toBeNull();
    expect(readAuthConfig({ EMAIL_FROM: "a@b.example" }, "development").email).toBeNull();
    expect(
      readAuthConfig({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.example" }, "development").email,
    ).toEqual({ resendApiKey: "re_x", from: "a@b.example" });
  });

  it("lists the secrets the logger must redact", () => {
    expect(
      secretValues({
        BETTER_AUTH_SECRET: "s1",
        GITHUB_CLIENT_SECRET: "s2",
        GITHUB_CLIENT_ID: "public-id",
        RESEND_API_KEY: "s3",
        DATABASE_URL: "postgres://u:p@h/db",
        EARSHOT_VAULT_MASTER_KEY: "bWFzdGVyLWtleQ==",
      }),
    ).toEqual(["s1", "s2", "s3", "postgres://u:p@h/db", "bWFzdGVyLWtleQ=="]);
  });
});

describe("OAuth providers on the sign-in page", () => {
  it("shows a provider only when both its client id and secret are set", () => {
    expect(socialProviderIds({})).toEqual([]);
    expect(socialProviderIds({ GITHUB_CLIENT_ID: "id" })).toEqual([]);
    expect(socialProviderIds({ GITHUB_CLIENT_SECRET: "secret" })).toEqual([]);
    expect(socialProviderIds({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "  " })).toEqual([]);
    expect(socialProviderIds({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" })).toEqual([
      "github",
    ]);
    expect(
      socialProviderIds({
        GOOGLE_CLIENT_ID: "gid",
        GOOGLE_CLIENT_SECRET: "gsecret",
        GITHUB_CLIENT_ID: "id",
        GITHUB_CLIENT_SECRET: "secret",
      }),
    ).toEqual(["github", "google"]);
    expect(
      configuredSocialProviders({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret" }),
    ).toEqual({
      google: { clientId: "gid", clientSecret: "gsecret" },
    });
  });
});

describe("createMagicLinkSender", () => {
  it("prints the link in development, marked development-only", async () => {
    const printed: string[] = [];
    const log = memoryLogger();
    const send = createMagicLinkSender({
      mode: "development",
      email: null,
      log,
      ttlMinutes: 5,
      devConsole: (text) => printed.push(text),
    });

    await send({ email: "ana@acme.example", url: URL_TO_SEND });

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("DEVELOPMENT ONLY");
    expect(printed[0]).toContain(URL_TO_SEND);
    // The address stays out even of the dev console; the server log gets nothing.
    expect(printed[0]).not.toContain("ana@acme.example");
    expect(log.lines).toEqual([]);
  });

  it("refuses to send in production without a provider, and never writes the link anywhere", async () => {
    const printed: string[] = [];
    const log = memoryLogger();
    const consoleCalls: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => void consoleCalls.push(args));
    }
    const send = createMagicLinkSender({
      mode: "production",
      email: null,
      log,
      ttlMinutes: 5,
      devConsole: (text) => printed.push(text),
    });

    const failure = await send({ email: "ana@acme.example", url: URL_TO_SEND }).catch((e) => e);

    expect(failure).toBeInstanceOf(EmailUnavailableError);
    expect(String(failure.message)).toMatch(/RESEND_API_KEY and EMAIL_FROM/);
    expect(String(failure.message)).not.toContain("TOKEN");
    expect(printed).toEqual([]);
    const everything = JSON.stringify([log.lines, consoleCalls]);
    expect(everything).not.toContain("TOKENxyz");
    expect(everything).not.toContain("ana@acme.example");
  });

  it("posts the message to Resend with the API key, and only the recipient", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const send = createMagicLinkSender({
      mode: "production",
      email: { resendApiKey: "re_key", from: "Earshot <sign-in@mail.example>" },
      log: memoryLogger(),
      ttlMinutes: 5,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await send({ email: "ana@acme.example", url: URL_TO_SEND });

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.to).toEqual(["ana@acme.example"]);
    expect(body.subject).toBe("Your Earshot sign-in link");
    expect(body.text).toContain(URL_TO_SEND);
    expect(body.html).toContain(URL_TO_SEND.replaceAll("&", "&amp;"));
  });

  it("reports a provider failure by status, without echoing the response or the link", async () => {
    const fetchMock = vi.fn(
      async () => new Response(`{"echo":"ana@acme.example ${URL_TO_SEND}"}`, { status: 422 }),
    );
    const send = createMagicLinkSender({
      mode: "production",
      email: { resendApiKey: "re_key", from: "a@mail.example" },
      log: memoryLogger(),
      ttlMinutes: 5,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const failure = await send({ email: "ana@acme.example", url: URL_TO_SEND }).catch((e) => e);

    expect(failure).toBeInstanceOf(EmailDeliveryError);
    expect(failure.message).toBe("The email provider refused the message (HTTP 422)");
  });

  it("hides network errors, which can quote the request", async () => {
    const send = createMagicLinkSender({
      mode: "production",
      email: { resendApiKey: "re_key", from: "a@mail.example" },
      log: memoryLogger(),
      ttlMinutes: 5,
      fetch: (async () => {
        throw new Error(`connect failed for ${URL_TO_SEND}`);
      }) as unknown as typeof fetch,
    });
    const failure = await send({ email: "ana@acme.example", url: URL_TO_SEND }).catch((e) => e);
    expect(failure).toBeInstanceOf(EmailDeliveryError);
    expect(failure.message).not.toContain("TOKEN");
  });
});
