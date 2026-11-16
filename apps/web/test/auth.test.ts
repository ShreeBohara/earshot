import { ensureWorkspace, schema } from "@earshot/db";
import type { PGlite } from "@electric-sql/pglite";
import { count, eq, like } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MagicLinkMessage } from "@/lib/auth/email";
import { MAGIC_LINKS_PER_ADDRESS, RATE_LIMIT_RULES } from "@/lib/auth/server";
import { loadViewer } from "@/lib/auth/viewer-core";
import {
  authRequest,
  cloneDb,
  memoryLogger,
  migratedTemplate,
  ORIGIN,
  signInByMagicLink,
  type TestDb,
  testAuth,
  withCookie,
} from "./support/harness";

const { user, workspaceMembers, workspaces, session, rateLimit } = schema;

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

async function membershipsOf(userId: string) {
  return db
    .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
}

async function userByEmail(email: string) {
  const [row] = await db.select().from(user).where(eq(user.email, email));
  return row;
}

describe("magic-link sign-up", () => {
  it("creates the user, a workspace, and an owner membership exactly once; a second sign-in reuses them", async () => {
    const outbox: MagicLinkMessage[] = [];
    const auth = testAuth({ db, outbox });

    const first = await signInByMagicLink(auth, outbox, "ana@acme.example");
    expect(first.location).toBe(`${ORIGIN}/onboarding`);
    const ana = await userByEmail("ana@acme.example");
    expect(ana).toMatchObject({ emailVerified: true });
    const memberships = await membershipsOf(ana?.id ?? "");
    expect(memberships).toEqual([{ workspaceId: expect.any(String), role: "owner" }]);

    const second = await signInByMagicLink(auth, outbox, "ana@acme.example");
    expect(second.location).toBe(`${ORIGIN}/home`);
    expect(await db.select({ n: count() }).from(user)).toEqual([{ n: 1 }]);
    expect(await membershipsOf(ana?.id ?? "")).toEqual(memberships);
    expect(await db.select({ n: count() }).from(workspaces)).toEqual([{ n: 1 }]);
    expect(await db.select({ n: count() }).from(session)).toEqual([{ n: 2 }]);
  });

  it("stores only a hash of each magic-link token", async () => {
    const outbox: MagicLinkMessage[] = [];
    const auth = testAuth({ db, outbox });
    await auth.handler(authRequest("/sign-in/magic-link", { body: { email: "ana@acme.example" } }));
    const token = new URL(outbox[0]?.url ?? "").searchParams.get("token") ?? "";
    expect(token).toHaveLength(32);

    const rows = await db.select().from(schema.verification);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("accepts each link once", async () => {
    const outbox: MagicLinkMessage[] = [];
    const auth = testAuth({ db, outbox });
    await signInByMagicLink(auth, outbox, "ana@acme.example");
    const reused = await auth.handler(
      new Request(outbox[0]?.url ?? "", { headers: { origin: ORIGIN } }),
    );
    expect(reused.status).toBe(302);
    expect(reused.headers.get("location")).toContain("error=INVALID_TOKEN");
  });
});

describe("workspace bootstrap", () => {
  it("lets ensureWorkspace repair a user whose sign-up hook failed, exactly once", async () => {
    const outbox: MagicLinkMessage[] = [];
    const auth = testAuth({ db, outbox });
    const { cookie } = await signInByMagicLink(auth, outbox, "ana@acme.example");
    const ana = await userByEmail("ana@acme.example");
    // As if the hook had failed: no workspace at all.
    await db.delete(workspaces);
    expect(await membershipsOf(ana?.id ?? "")).toEqual([]);

    const viewer = await loadViewer({ auth, db, headers: withCookie(cookie) });
    const again = await loadViewer({ auth, db, headers: withCookie(cookie) });

    expect(viewer?.workspaceId).toEqual(expect.any(String));
    expect(again?.workspaceId).toBe(viewer?.workspaceId);
    expect(await membershipsOf(ana?.id ?? "")).toEqual([
      { workspaceId: viewer?.workspaceId, role: "owner" },
    ]);
  });

  it("is idempotent when called directly", async () => {
    const outbox: MagicLinkMessage[] = [];
    await signInByMagicLink(testAuth({ db, outbox }), outbox, "ana@acme.example");
    const ana = await userByEmail("ana@acme.example");
    const owner = { id: ana?.id ?? "", name: ana?.name ?? "" };

    const results = await Promise.all([ensureWorkspace(db, owner), ensureWorkspace(db, owner)]);

    expect(results.map((r) => r.created)).toEqual([false, false]);
    expect(new Set(results.map((r) => r.workspaceId)).size).toBe(1);
    expect(await membershipsOf(owner.id)).toHaveLength(1);
  });

  it("names the workspace after the user when the provider gives a name", async () => {
    await db.insert(user).values({ id: "u-1", name: "Dana Lee", email: "dana@acme.example" });
    const { workspaceId } = await ensureWorkspace(db, { id: "u-1", name: "Dana Lee" });
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(workspace?.name).toBe("Dana's workspace");
  });
});

describe("loadViewer (getViewer's core)", () => {
  it("resolves each user's own workspace and role", async () => {
    const outbox: MagicLinkMessage[] = [];
    const auth = testAuth({ db, outbox });
    const ana = await signInByMagicLink(auth, outbox, "ana@acme.example");
    const bo = await signInByMagicLink(auth, outbox, "bo@globex.example");

    const anaViewer = await loadViewer({ auth, db, headers: withCookie(ana.cookie) });
    const boViewer = await loadViewer({ auth, db, headers: withCookie(bo.cookie) });

    const [anaMembership] = await membershipsOf(anaViewer?.user.id ?? "");
    expect(anaViewer).toMatchObject({
      user: { email: "ana@acme.example" },
      workspaceId: anaMembership?.workspaceId,
      workspaceName: "Personal",
      role: "owner",
    });
    expect(boViewer?.user.email).toBe("bo@globex.example");
    expect(boViewer?.workspaceId).not.toBe(anaViewer?.workspaceId);
    expect(anaViewer?.session).not.toHaveProperty("token");
  });

  it("returns null without a valid session", async () => {
    const auth = testAuth({ db });
    expect(await loadViewer({ auth, db, headers: new Headers() })).toBeNull();
    expect(
      await loadViewer({ auth, db, headers: withCookie("earshot.session_token=forged.value") }),
    ).toBeNull();
  });

  it("returns null once the session is revoked", async () => {
    const outbox: MagicLinkMessage[] = [];
    const auth = testAuth({ db, outbox });
    const { cookie } = await signInByMagicLink(auth, outbox, "ana@acme.example");
    await db.delete(session);
    expect(await loadViewer({ auth, db, headers: withCookie(cookie) })).toBeNull();
  });
});

describe("OAuth providers", () => {
  const github = { GITHUB_CLIENT_ID: "gh-client-id", GITHUB_CLIENT_SECRET: "gh-client-secret" };

  it("are off without both a client id and a secret", async () => {
    const auth = testAuth({ db, env: { GITHUB_CLIENT_ID: "gh-client-id" } });
    const response = await auth.handler(
      authRequest("/sign-in/social", { body: { provider: "github", callbackURL: "/home" } }),
    );
    expect(response.status).toBe(404);
  });

  it("are on once both are set, and redirect to the provider", async () => {
    const auth = testAuth({ db, env: github });
    const response = await auth.handler(
      authRequest("/sign-in/social", { body: { provider: "github", callbackURL: "/home" } }),
    );
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    expect(new URL(url).hostname).toBe("github.com");
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/auth/callback/github`,
    );
  });
});

describe("magic-link email delivery", () => {
  it("fails closed in production without an email provider, and never logs the link", async () => {
    const log = memoryLogger();
    const consoleCalls: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => void consoleCalls.push(args));
    }
    // The real sender: no outbox override.
    const auth = testAuth({
      db,
      mode: "production",
      env: { BETTER_AUTH_URL: "https://earshot.example" },
      outbox: null,
      log,
    });

    const response = await auth.handler(
      new Request("https://earshot.example/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { origin: "https://earshot.example", "content-type": "application/json" },
        body: JSON.stringify({ email: "ana@acme.example" }),
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "EMAIL_UNAVAILABLE" });
    const everything = JSON.stringify([log.lines, consoleCalls]);
    expect(everything).not.toMatch(/magic-link\/verify|token=/);
    expect(everything).not.toContain("ana@acme.example");
    expect(log.lines.join("\n")).toContain("RESEND_API_KEY and EMAIL_FROM are not set");
  });

  it("sends through Resend when configured, without logging anything about the message", async () => {
    const log = memoryLogger();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email-1" })));
    const auth = testAuth({
      db,
      mode: "production",
      env: {
        BETTER_AUTH_URL: "https://earshot.example",
        RESEND_API_KEY: "re_test_key_for_vitest",
        EMAIL_FROM: "Earshot <sign-in@mail.example>",
      },
      outbox: null,
      log,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const response = await auth.handler(
      new Request("https://earshot.example/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { origin: "https://earshot.example", "content-type": "application/json" },
        body: JSON.stringify({ email: "ana@acme.example" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe("https://api.resend.com/emails");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer re_test_key_for_vitest");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      from: "Earshot <sign-in@mail.example>",
      to: ["ana@acme.example"],
    });
    expect(body.text).toContain("https://earshot.example/api/auth/magic-link/verify?token=");
    expect(log.lines).toEqual([]);
  });
});

describe("rate limiting", () => {
  it("limits magic-link requests per IP in the shared database, across instances", async () => {
    const outbox: MagicLinkMessage[] = [];
    const isolateA = testAuth({ db, outbox, rateLimit: true });
    const isolateB = testAuth({ db, outbox, rateLimit: true });
    const limit = RATE_LIMIT_RULES["/sign-in/magic-link"].max;

    const send = (auth: typeof isolateA, ip: string, i: number) =>
      auth.handler(
        authRequest("/sign-in/magic-link", { body: { email: `user${i}@acme.example` }, ip }),
      );

    for (let i = 0; i < limit; i++) {
      // Alternate instances: the counter lives in Postgres, not in either isolate's memory.
      expect((await send(i % 2 ? isolateA : isolateB, "203.0.113.7", i)).status).toBe(200);
    }
    const blocked = await send(isolateA, "203.0.113.7", limit);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("x-retry-after"))).toBeGreaterThan(0);

    // Another client is unaffected.
    expect((await send(isolateB, "198.51.100.4", 99)).status).toBe(200);
    const keys = await db.select({ key: rateLimit.key }).from(rateLimit);
    expect(keys.map((k) => k.key)).toEqual(
      expect.arrayContaining([
        "203.0.113.7|/sign-in/magic-link",
        "198.51.100.4|/sign-in/magic-link",
      ]),
    );
  });

  it("limits sign-in attempts too", async () => {
    const auth = testAuth({
      db,
      rateLimit: true,
      env: { GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b" },
    });
    const statuses: number[] = [];
    for (let i = 0; i <= RATE_LIMIT_RULES["/sign-in/social"].max; i++) {
      const response = await auth.handler(
        authRequest("/sign-in/social", { body: { provider: "github" }, ip: "203.0.113.8" }),
      );
      statuses.push(response.status);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((status) => status === 200)).toBe(true);
  });

  it("caps links per address whatever the IP, without revealing it", async () => {
    const outbox: MagicLinkMessage[] = [];
    const log = memoryLogger();
    const auth = testAuth({ db, outbox, rateLimit: true, log });
    const statuses: number[] = [];
    for (let i = 0; i <= MAGIC_LINKS_PER_ADDRESS.max; i++) {
      const response = await auth.handler(
        authRequest("/sign-in/magic-link", {
          body: { email: "Victim@Acme.example" },
          ip: `192.0.2.${i + 1}`,
        }),
      );
      statuses.push(response.status);
    }
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(outbox).toHaveLength(MAGIC_LINKS_PER_ADDRESS.max);
    // The table holds a keyed hash of the address, never the address itself.
    const rows = await db
      .select()
      .from(rateLimit)
      .where(like(rateLimit.key, "magic-link-address|%"));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows).toLowerCase()).not.toContain("victim@acme.example");
    expect(log.lines.join("\n")).not.toContain("acme.example");
  });
});
