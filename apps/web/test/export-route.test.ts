import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MagicLinkMessage } from "@/lib/auth/email";
import type { Auth } from "@/lib/auth/server";
import {
  cloneDb,
  migratedTemplate,
  signInByMagicLink,
  type TestDb,
  testAuth,
} from "./support/harness";

// The route runs for real; only the request scope (cookies, headers) and the per-request
// Cloudflare wiring (getAuth, getDb) are swapped for the test's own.
const scope = vi.hoisted(() => ({
  cookie: "",
  auth: undefined as unknown,
  db: undefined as unknown,
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    const pairs = new Map(
      scope.cookie
        .split("; ")
        .filter(Boolean)
        .map((pair) => pair.split("=") as [string, string]),
    );
    return { has: (name: string) => pairs.has(name) };
  },
  headers: async () => new Headers(scope.cookie ? { cookie: scope.cookie } : {}),
}));
vi.mock("@/lib/auth", () => ({
  getAuth: async () => scope.auth,
  log: { info: () => {}, warn: () => {}, error: () => {} },
}));
// No audit signing key: the export still downloads, with no public keys (test/audit-routes.test.ts
// covers the chain, the checkpoints, and the keys).
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: {} }) }));
vi.mock("@/lib/db", () => ({ getDb: async () => scope.db }));

const { GET } = await import("@/app/api/account/export/route");

let template: PGlite;
let db: TestDb;
let auth: Auth;
let outbox: MagicLinkMessage[];

beforeAll(async () => {
  template = await migratedTemplate();
});

beforeEach(async () => {
  db = await cloneDb(template);
  outbox = [];
  auth = testAuth({ db, outbox });
  Object.assign(scope, { cookie: "", auth, db });
});

afterEach(async () => {
  await db.$client.close();
});

const call = () => GET(new Request("http://localhost:3000/api/account/export"), undefined);

describe("GET /api/account/export", () => {
  it("answers 401 with JSON when signed out", async () => {
    const response = await call();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "unauthorized",
      message: "Sign in to continue.",
    });
  });

  it("answers 401 for a forged session cookie", async () => {
    scope.cookie = "earshot.session_token=forged.value";
    expect((await call()).status).toBe(401);
  });

  it("refuses a cross-site request, even with a valid session", async () => {
    const { cookie } = await signInByMagicLink(auth, outbox, "ana@acme.example");
    scope.cookie = cookie;
    const response = await GET(
      new Request("http://localhost:3000/api/account/export", {
        headers: { "sec-fetch-site": "cross-site" },
      }),
      undefined,
    );
    expect(response.status).toBe(403);
  });

  it("downloads the signed-in user's export as one JSON file", async () => {
    const { cookie } = await signInByMagicLink(auth, outbox, "ana@acme.example");
    scope.cookie = cookie;

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="earshot-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { workspaces: unknown[] };
    expect(body).toMatchObject({
      format: "earshot.account-export",
      version: 1,
      user: { email: "ana@acme.example" },
    });
    expect(body.workspaces).toHaveLength(1);
  });
});
