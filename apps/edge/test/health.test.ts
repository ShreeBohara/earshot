import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("reports the Durable Object as ok", async () => {
    const response = await SELF.fetch("https://edge.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", durableObject: "ok" });
  });
});

describe("SessionDO", () => {
  it("keeps its ping count in SQLite storage", async () => {
    const stub = env.SESSION.get(env.SESSION.idFromName("counter"));
    expect((await stub.ping()).pings).toBe(1);
    expect((await stub.ping()).pings).toBe(2);
  });
});
