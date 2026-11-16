import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseTarget,
  readTemplate,
  renderEdge,
  renderWeb,
  type WranglerConfig,
  webOrigin,
  workerNames,
} from "./render-wrangler";

const root = fileURLToPath(new URL("..", import.meta.url));
const webTemplate = readTemplate(`${root}apps/web/wrangler.jsonc`);
const edgeTemplate = readTemplate(`${root}apps/edge/wrangler.jsonc`);

function service(config: WranglerConfig, binding: string): string | undefined {
  return config.services?.find((s) => s.binding === binding)?.service;
}

describe("parseTarget", () => {
  it("accepts production and pr-N", () => {
    expect(parseTarget("production")).toEqual({ kind: "production" });
    expect(parseTarget("pr-12")).toEqual({ kind: "pr", number: 12 });
  });

  it.each(["pr-0", "pr-", "pr-12a", "staging", "PR-1"])("rejects %s", (value) => {
    expect(() => parseTarget(value)).toThrow();
  });
});

describe("per-PR configs", () => {
  const target = parseTarget("pr-12");
  const web = renderWeb(webTemplate, target, "abc1234");
  const edge = renderEdge(edgeTemplate, target, "abc1234");

  it("name both Workers after the PR", () => {
    expect(edge.name).toBe("earshot-edge-pr-12");
    expect(web.name).toBe("earshot-web-pr-12");
  });

  it("point WORKER_SELF_REFERENCE at the web Worker itself", () => {
    expect(service(web, "WORKER_SELF_REFERENCE")).toBe(web.name);
  });

  it("bind the web Worker to the same PR's edge Worker", () => {
    expect(service(web, "EDGE")).toBe(edge.name);
  });

  it("set DEPLOY_ENV and GIT_SHA on both Workers", () => {
    for (const config of [web, edge]) {
      expect(config.vars).toMatchObject({ DEPLOY_ENV: "pr-12", GIT_SHA: "abc1234" });
    }
  });

  it("keep everything else from the templates", () => {
    expect(edge.durable_objects).toEqual(edgeTemplate.durable_objects);
    expect(web.assets).toEqual(webTemplate.assets);
    expect(web.compatibility_date).toBe(webTemplate.compatibility_date);
  });
});

describe("production configs", () => {
  const target = parseTarget("production");
  const web = renderWeb(webTemplate, target, "abc1234");

  it("use the base names", () => {
    expect(web.name).toBe("earshot-web");
    expect(service(web, "EDGE")).toBe("earshot-edge");
    expect(web.vars?.DEPLOY_ENV).toBe("production");
  });
});

describe("BETTER_AUTH_URL", () => {
  it("is each web Worker's own workers.dev origin", () => {
    const pr = renderWeb(webTemplate, parseTarget("pr-12"), "abc1234", {
      workersSubdomain: "acme",
    });
    const production = renderWeb(webTemplate, parseTarget("production"), "abc1234", {
      workersSubdomain: "acme",
    });
    expect(pr.vars?.BETTER_AUTH_URL).toBe("https://earshot-web-pr-12.acme.workers.dev");
    expect(production.vars?.BETTER_AUTH_URL).toBe("https://earshot-web.acme.workers.dev");
    expect(pr.vars).toMatchObject({ DEPLOY_ENV: "pr-12", GIT_SHA: "abc1234" });
  });

  it("is left unset without a subdomain, and refuses a malformed one", () => {
    expect(renderWeb(webTemplate, parseTarget("pr-12"), "abc1234").vars).not.toHaveProperty(
      "BETTER_AUTH_URL",
    );
    expect(() => webOrigin(parseTarget("pr-12"), "acme.evil.example/")).toThrow();
  });
});

describe("worker names", () => {
  it("stay within Cloudflare's 63-character limit for large PR numbers", () => {
    expect(workerNames({ kind: "pr", number: 9_999_999 }).edge.length).toBeLessThanOrEqual(63);
  });
});
