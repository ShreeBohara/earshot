// The edge Worker's configuration (src/config.ts): development defaults, and fail-closed elsewhere.
import { DEV_SESSION_TICKET_SECRET } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  EdgeConfigError,
  isAllowedOrigin,
  readEdgeConfig,
  readTicketSecret,
  readWebOrigins,
} from "../src/config";

const SECRET = "a-real-ticket-secret-of-at-least-32-bytes!!";

describe("the ticket secret", () => {
  it("falls back to the development secret only in development", () => {
    expect(readTicketSecret({ DEPLOY_ENV: "development" })).toBe(DEV_SESSION_TICKET_SECRET);
    expect(() => readTicketSecret({ DEPLOY_ENV: "production" })).toThrow(EdgeConfigError);
    expect(() => readTicketSecret({ DEPLOY_ENV: "pr-12" })).toThrow(/not set/);
  });

  it("refuses the development secret outside development, padded or not", () => {
    for (const secret of [DEV_SESSION_TICKET_SECRET, `  ${DEV_SESSION_TICKET_SECRET}\n`]) {
      expect(() =>
        readTicketSecret({ DEPLOY_ENV: "production", EARSHOT_SESSION_TICKET_SECRET: secret }),
      ).toThrow(/development-only/);
    }
  });

  it("trims the secret as the web app does, and refuses one under 32 bytes", () => {
    expect(
      readTicketSecret({ DEPLOY_ENV: "production", EARSHOT_SESSION_TICKET_SECRET: ` ${SECRET}\n` }),
    ).toBe(SECRET);
    expect(() =>
      readTicketSecret({ DEPLOY_ENV: "production", EARSHOT_SESSION_TICKET_SECRET: "short" }),
    ).toThrow(/32 bytes/);
  });

  it("never puts the value in an error", () => {
    try {
      readTicketSecret({ DEPLOY_ENV: "production", EARSHOT_SESSION_TICKET_SECRET: "tiny-secret" });
    } catch (error) {
      expect(String(error)).not.toContain("tiny-secret");
    }
  });
});

describe("WEB_ORIGIN", () => {
  it("lists one or more bare origins", () => {
    expect([
      ...readWebOrigins({
        DEPLOY_ENV: "production",
        WEB_ORIGIN: "https://earshot-web.acme.workers.dev, https://app.example",
      }),
    ]).toEqual(["https://earshot-web.acme.workers.dev", "https://app.example"]);
  });

  it("requires https outside development, except for localhost, and refuses paths", () => {
    expect(() =>
      readWebOrigins({ DEPLOY_ENV: "production", WEB_ORIGIN: "http://app.example" }),
    ).toThrow();
    expect(
      readWebOrigins({ DEPLOY_ENV: "production", WEB_ORIGIN: "http://localhost:3000" }).size,
    ).toBe(1);
    expect(
      readWebOrigins({ DEPLOY_ENV: "development", WEB_ORIGIN: "http://web.test:3000" }).size,
    ).toBe(1);
    for (const bad of [
      "",
      "https://app.example/path",
      "https://user:pw@app.example",
      "ftp://x.example",
    ]) {
      expect(() => readWebOrigins({ DEPLOY_ENV: "development", WEB_ORIGIN: bad })).toThrow(
        EdgeConfigError,
      );
    }
  });

  it("matches the Origin header exactly", () => {
    const allowed = readWebOrigins({ DEPLOY_ENV: "production", WEB_ORIGIN: "https://app.example" });
    expect(isAllowedOrigin("https://app.example", allowed)).toBe(true);
    for (const origin of [
      "https://app.example.evil",
      "https://APP.example",
      "http://app.example",
      "null",
      null,
      "https://app.example/",
    ]) {
      expect(isAllowedOrigin(origin, allowed)).toBe(false);
    }
  });
});

describe("readEdgeConfig", () => {
  it("imports the ticket key once per secret", async () => {
    const config = await readEdgeConfig({
      DEPLOY_ENV: "development",
      WEB_ORIGIN: "http://localhost:3000",
    });
    expect(config.development).toBe(true);
    expect(config.ticketKey.algorithm.name).toBe("HMAC");
    const again = await readEdgeConfig({
      DEPLOY_ENV: "development",
      WEB_ORIGIN: "http://localhost:3000",
    });
    expect(again.ticketKey).toBe(config.ticketKey);
  });
});
