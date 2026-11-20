import { recordAudit, schema, verifyAuditExport, withTenant, writeCheckpoint } from "@earshot/db";
import {
  DEV_AUDIT_KID,
  DEV_AUDIT_SIGNING_KEY,
  findSecretFragment,
  generateAuditSigningKey,
  loadAuditSigningKey,
} from "@earshot/keys/server";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditKeysResponse, readAuditKeys } from "@/lib/audit/keys";
import { secretValues } from "@/lib/auth/config";
import type { MagicLinkMessage } from "@/lib/auth/email";
import type { Auth } from "@/lib/auth/server";
import { createLogger } from "@/lib/log";
import {
  cloneDb,
  migratedTemplate,
  signInByMagicLink,
  type TestDb,
  testAuth,
} from "./support/harness";
import { consoleOutput, responseText, spyOnConsole } from "./support/leaks";

// The routes run for real; only the request scope and the per-request Cloudflare wiring are the
// test's own. The log here doesn't redact, so a key that reached it would show.
const scope = vi.hoisted(() => ({
  cookie: "",
  auth: undefined as unknown,
  db: undefined as unknown,
  env: {} as Record<string, unknown>,
  lines: [] as string[],
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
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: scope.env }) }));
vi.mock("@/lib/auth", () => ({
  getAuth: async () => scope.auth,
  log: {
    info: (message: string) => scope.lines.push(`info ${message}`),
    warn: (message: string) => scope.lines.push(`warn ${message}`),
    error: (message: string) => scope.lines.push(`error ${message}`),
  },
}));
vi.mock("@/lib/db", () => ({ getDb: async () => scope.db }));

const keysRoute = await import("@/app/api/audit/keys/route");
const healthRoute = await import("@/app/api/health/route");
const exportRoute = await import("@/app/api/account/export/route");

/** A key made for this test only. */
async function testKey() {
  const key = await generateAuditSigningKey();
  return { ...key, d: (JSON.parse(key.secret) as { d: string }).d };
}

const DEV_D = (JSON.parse(DEV_AUDIT_SIGNING_KEY) as { d: string }).d;

function expectNoPrivateKey(haystack: string, ...ds: string[]) {
  for (const d of [...ds, DEV_D]) {
    expect(
      findSecretFragment(haystack, d, 8),
      "a fragment of a private key leaked",
    ).toBeUndefined();
  }
}

/** The edge Worker, answering the health check. */
const edge = {
  fetch: async () => Response.json({ status: "ok", durableObject: "ok", env: "production" }),
};

let template: PGlite;
let db: TestDb;

beforeAll(async () => {
  template = await migratedTemplate();
});

beforeEach(async () => {
  db = await cloneDb(template);
  scope.cookie = "";
  scope.db = db;
  scope.auth = undefined;
  scope.env = {};
  scope.lines = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.$client.close();
});

// Real routes over PGlite and WebCrypto; CI runs them far slower than a laptop does.
describe("GET /api/audit/keys", { timeout: 120_000 }, () => {
  it("serves the active key and the retired ones, cacheable, and nothing private", async () => {
    const active = await testKey();
    const old = await testKey();
    const retiredAt = "2026-11-19T09:00:00.000Z";
    scope.env = {
      EARSHOT_AUDIT_SIGNING_KEY: active.secret,
      EARSHOT_AUDIT_RETIRED_KEYS: JSON.stringify([{ ...JSON.parse(old.publicJwk), retiredAt }]),
    };
    const console = spyOnConsole();

    const response = await keysRoute.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.clone().json()).toEqual({
      keys: [
        { kid: active.kid, alg: "Ed25519", x: JSON.parse(active.publicJwk).x, status: "active" },
        {
          kid: old.kid,
          alg: "Ed25519",
          x: JSON.parse(old.publicJwk).x,
          status: "retired",
          retiredAt,
        },
      ],
    });
    expectNoPrivateKey(await responseText(response), active.d, old.d);
    expectNoPrivateKey(scope.lines.join("\n") + consoleOutput(console), active.d, old.d);
  });

  it("serves no active key while the secret is missing, and logs that once", async () => {
    scope.env = { EARSHOT_AUDIT_SIGNING_KEY: "", EARSHOT_AUDIT_RETIRED_KEYS: "[]" };
    expect(await (await keysRoute.GET()).json()).toEqual({ keys: [] });
    await keysRoute.GET();
    expect(scope.lines).toEqual([
      expect.stringMatching(/^warn audit signing unavailable: EARSHOT_AUDIT_SIGNING_KEY isn't set/),
    ]);
  });

  it("refuses the development key outside development, naming the variable and never the key", async () => {
    const old = await testKey();
    scope.env = {
      EARSHOT_AUDIT_SIGNING_KEY: DEV_AUDIT_SIGNING_KEY,
      EARSHOT_AUDIT_RETIRED_KEYS: old.publicJwk,
    };
    const response = await keysRoute.GET();
    expect(await response.clone().json()).toEqual({
      keys: [expect.objectContaining({ kid: old.kid, status: "retired" })],
    });
    expect(scope.lines.join("\n")).toMatch(/EARSHOT_AUDIT_SIGNING_KEY is the development-only key/);
    expectNoPrivateKey((await responseText(response)) + scope.lines.join("\n"), old.d);
  });

  it("answers 500, and serves nothing, when the retired list holds a private key", async () => {
    const active = await testKey();
    const leaked = await testKey();
    scope.env = {
      EARSHOT_AUDIT_SIGNING_KEY: active.secret,
      EARSHOT_AUDIT_RETIRED_KEYS: `[${leaked.secret}]`,
    };
    const response = await keysRoute.GET();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(scope.lines.join("\n")).toMatch(/EARSHOT_AUDIT_RETIRED_KEYS holds a private key/);
    expectNoPrivateKey((await responseText(response)) + scope.lines.join("\n"), active.d, leaked.d);
  });

  it("serves the development key's public half under next dev", async () => {
    const keys = await readAuditKeys({}, { mode: "development", log: createLogger(() => []) });
    expect(keys.signing.status).toBe("development");
    const response = auditKeysResponse(keys);
    expect(await response.clone().json()).toEqual({
      keys: [expect.objectContaining({ kid: DEV_AUDIT_KID, status: "active" })],
    });
    expectNoPrivateKey(await responseText(response));
  });
});

describe("GET /api/health", { timeout: 120_000 }, () => {
  it("says whether a signing key is configured, without the key, and without changing the status", async () => {
    const active = await testKey();
    const cases: [Record<string, unknown>, string][] = [
      [{ EARSHOT_AUDIT_SIGNING_KEY: active.secret }, "configured"],
      [{}, "missing"],
      [{ EARSHOT_AUDIT_SIGNING_KEY: DEV_AUDIT_SIGNING_KEY }, "invalid"],
      [{ EARSHOT_AUDIT_SIGNING_KEY: `{"kty":"OKP","crv":"Ed25519","d":"${active.d}"}` }, "invalid"],
    ];
    for (const [env, signingKey] of cases) {
      // No database: the status is degraded either way, whatever the signing key's state.
      scope.env = { ...env, EDGE: edge, DEPLOY_ENV: "production", GIT_SHA: "abc1234" };
      const response = await healthRoute.GET();
      const body = (await response.clone().json()) as { status: string; audit: unknown };
      expect(body.audit, signingKey).toEqual({ signingKey });
      expect(body.status).toBe("degraded");
      expectNoPrivateKey(await responseText(response), active.d);
    }
    expectNoPrivateKey(scope.lines.join("\n"), active.d);
  });
});

describe("GET /api/account/export", { timeout: 120_000 }, () => {
  let auth: Auth;
  let outbox: MagicLinkMessage[];

  beforeEach(() => {
    outbox = [];
    auth = testAuth({ db, outbox });
    scope.auth = auth;
  });

  it("carries the chain, its checkpoints, and the public keys, and verifies offline", async () => {
    const active = await testKey();
    scope.env = { EARSHOT_AUDIT_SIGNING_KEY: active.secret };
    const { cookie } = await signInByMagicLink(auth, outbox, "ana@acme.example");
    scope.cookie = cookie;
    const [ana] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, "ana@acme.example"));
    const [membership] = await db
      .select()
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, ana?.id ?? ""));
    const tenant = { userId: ana?.id ?? "", workspaceId: membership?.workspaceId ?? "" };

    // A review request: entries and one checkpoint, signed with this deployment's key.
    const state = await loadAuditSigningKey(
      { EARSHOT_AUDIT_SIGNING_KEY: active.secret },
      { development: false },
    );
    if (!("signer" in state)) throw new Error("no signer");
    await withTenant(db, tenant, async (tx) => {
      const { head } = await recordAudit(tx, [
        {
          action: "proposal.approved",
          subjectType: "proposal",
          subjectId: "p-1",
          detail: { mode: "single" },
        },
      ]);
      await writeCheckpoint(tx, state.signer, head, "review");
    });
    const console = spyOnConsole();

    const response = await exportRoute.GET(
      new Request("http://localhost:3000/api/account/export"),
      undefined,
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    const exported = JSON.parse(text) as {
      audit: { form: number; keys: { kid: string }[] };
      workspaces: { tables: { audit_log: unknown[]; audit_checkpoints: unknown[] } }[];
    };
    expect(exported.audit).toEqual({
      form: 1,
      keys: [
        { kid: active.kid, alg: "Ed25519", x: JSON.parse(active.publicJwk).x, status: "active" },
      ],
    });
    expect(exported.workspaces[0]?.tables.audit_log).toHaveLength(2); // the review, account.exported
    expect(exported.workspaces[0]?.tables.audit_checkpoints).toHaveLength(1);

    const verified = await verifyAuditExport(exported);
    expect(verified.problems).toEqual([]);
    expect(verified.workspaces[0]?.signedThrough).toBe(1);

    expectNoPrivateKey(text, active.d);
    expectNoPrivateKey(scope.lines.join("\n") + consoleOutput(console), active.d);
  });
});

describe("the redacting logger", () => {
  it("scrubs the signing key, whole or its d alone", async () => {
    const active = await testKey();
    const lines: string[] = [];
    const logger = createLogger(
      () => secretValues({ EARSHOT_AUDIT_SIGNING_KEY: active.secret }),
      (line) => lines.push(line),
    );
    logger.error("oops", { env: active.secret, d: active.d });
    expectNoPrivateKey(lines.join("\n"), active.d);
  });
});
