import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuthLog } from "@/lib/auth/better-auth-log";
import { readAuthConfig } from "@/lib/auth/config";
import { createAuth } from "@/lib/auth/server";
import { errorSummary, scrubMessage } from "@/lib/log";
import {
  authRequest,
  cloneDb,
  memoryLogger,
  migratedTemplate,
  ORIGIN,
  TEST_SECRET,
  type TestDb,
} from "./support/harness";

// Values that must never reach a log line, in every shape Better Auth might pass them.
const SESSION_TOKEN = "kQ2xV9pL7mN4bR8sT1wY6zA3cD5fG0hJ";
const EMAIL = "victim@acme.example";
const PROVIDER_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
const SENSITIVE = [SESSION_TOKEN, EMAIL, PROVIDER_KEY];

function expectNoneOf(lines: string[]) {
  const output = lines.join("\n");
  for (const value of SENSITIVE) expect(output, `${value} reached the log`).not.toContain(value);
}

describe("betterAuthLog (Better Auth's logger hook)", () => {
  it("drops every argument except an Error's name and code", () => {
    const log = memoryLogger();
    const hook = betterAuthLog(log);
    const apiError = Object.assign(new Error(`token ${SESSION_TOKEN} for ${EMAIL}`), {
      name: "APIError",
      body: { code: "INVALID_TOKEN", message: `${EMAIL} ${PROVIDER_KEY}` },
    });

    hook(
      "error",
      "Failed to verify the magic link",
      SESSION_TOKEN,
      EMAIL,
      PROVIDER_KEY,
      { token: SESSION_TOKEN, user: { email: EMAIL }, headers: { authorization: PROVIDER_KEY } },
      [SESSION_TOKEN, EMAIL],
      apiError,
      new TypeError(`${PROVIDER_KEY} was rejected`),
    );

    expect(log.lines).toHaveLength(1);
    expectNoneOf(log.lines);
    expect(log.lines[0]).toContain("better-auth: Failed to verify the magic link");
    expect(log.lines[0]).toContain('{"name":"APIError","code":"INVALID_TOKEN"}');
    expect(log.lines[0]).toContain('{"name":"TypeError"}');
  });

  it("scrubs the message itself", () => {
    const log = memoryLogger();
    betterAuthLog(log)("warn", `Sign-in for ${EMAIL} with ${SESSION_TOKEN} using ${PROVIDER_KEY}`);
    expectNoneOf(log.lines);
    expect(log.lines[0]).toContain("Sign-in for [EMAIL] with [TOKEN] using");
  });

  it("logs an Error passed as the message by its name only", () => {
    const log = memoryLogger();
    betterAuthLog(log)("error", new Error(`${EMAIL} ${SESSION_TOKEN}`) as unknown as string);
    expectNoneOf(log.lines);
    expect(log.lines[0]).toBe("error better-auth: Error");
  });

  it("keeps the level", () => {
    const log = memoryLogger();
    const hook = betterAuthLog(log);
    hook("error", "e");
    hook("warn", "w");
    hook("info", "i");
    hook("debug", "d");
    expect(log.lines).toEqual([
      "error better-auth: e",
      "warn better-auth: w",
      "info better-auth: i",
      "info better-auth: d",
    ]);
  });
});

describe("the server logger", () => {
  it("logs errors by name and code only, never their messages", () => {
    const log = memoryLogger([TEST_SECRET]);
    const error = Object.assign(new Error(`insert failed, params: ${EMAIL}, ${SESSION_TOKEN}`), {
      code: "23505",
    });
    log.error("workspace bootstrap failed", { userId: "u-1", error, key: PROVIDER_KEY });
    expectNoneOf(log.lines);
    expect(log.lines[0]).toContain('"error":{"name":"Error","code":"23505"}');
    expect(log.lines[0]).toContain('"userId":"u-1"');
  });

  it("redacts configured secrets", () => {
    const log = memoryLogger([TEST_SECRET]);
    log.warn(`configured with ${TEST_SECRET}`);
    expect(log.lines[0]).toBe("warn configured with [REDACTED]");
  });

  it("summarizes only real errors, with identifier-shaped names and codes", () => {
    expect(errorSummary({ name: "Error", message: EMAIL })).toBeUndefined();
    expect(errorSummary("boom")).toBeUndefined();
    const odd = Object.assign(new Error("x"), { code: `${EMAIL} 42` });
    odd.name = `Bad name ${EMAIL}`;
    expect(errorSummary(odd)).toEqual({});
    expect(scrubMessage("plain words stay as they are")).toBe("plain words stay as they are");
    expect(scrubMessage("rate limited on /passkey/generate-authenticate-options")).toBe(
      "rate limited on /passkey/generate-authenticate-options",
    );
    // A magic-link token is letters only, in mixed case; a hex digest is digits and letters.
    expect(scrubMessage("token=AbcdEfghIjklMnopQrstUvwxYzabCdef")).toBe("token=[TOKEN]");
    expect(scrubMessage("key 9f2c4e6a8b0d1f3e5a7c9e1b3d5f7a9c")).toBe("key [TOKEN]");
  });
});

describe("Better Auth's own error logging, end to end", () => {
  let template: PGlite;
  let db: TestDb;

  beforeAll(async () => {
    template = await migratedTemplate();
  });

  beforeEach(async () => {
    db = await cloneDb(template);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.$client.close();
  });

  it("keeps an endpoint's unexpected error out of the log, except its name", async () => {
    const consoleCalls: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => void consoleCalls.push(args));
    }
    const log = memoryLogger();
    // A sender that fails with sensitive values in its message: Better Auth logs the error.
    const auth = createAuth({
      config: readAuthConfig(
        { BETTER_AUTH_SECRET: TEST_SECRET, BETTER_AUTH_URL: ORIGIN },
        "development",
      ),
      db,
      log,
      sendMagicLink: async () => {
        throw new Error(`could not send ${SESSION_TOKEN} to ${EMAIL} with ${PROVIDER_KEY}`);
      },
    });

    const response = await auth.handler(
      authRequest("/sign-in/magic-link", { body: { email: EMAIL } }),
    );

    expect(response.status).toBe(500);
    expect(log.lines.some((line) => line.startsWith("error better-auth:"))).toBe(true);
    expectNoneOf(log.lines);
    expectNoneOf(consoleCalls.map((call) => JSON.stringify(call)));
  });
});
