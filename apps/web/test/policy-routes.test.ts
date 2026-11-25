import { createHash, generateKeyPairSync, randomBytes, sign as signData } from "node:crypto";
import {
  type ApprovalPolicyRules,
  MAX_MESSAGE_BYTES,
  type PolicySnapshot,
  parseClientMessage,
  type SessionProviders,
  verifyPolicySnapshot,
} from "@earshot/core";
import { loadDemoCrm, schema, type TenantContext, withTenant } from "@earshot/db";
import type { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MagicLinkMessage } from "@/lib/auth/email";
import { isSteppedUp, STEP_UP_SECONDS } from "@/lib/auth/fresh";
import type { Auth } from "@/lib/auth/server";
import { loadViewer, type Viewer } from "@/lib/auth/viewer-core";
import type { PolicyRouteDeps } from "@/lib/policies/routes";
import { utf8Length } from "@/lib/voice/entities";
import type { VoiceRouteDeps } from "@/lib/voice/routes";
import {
  authRequest,
  cloneDb,
  cookiesFrom,
  memoryLogger,
  migratedTemplate,
  ORIGIN,
  signInByMagicLink,
  type TestDb,
  testAuth,
  withCookie,
} from "./support/harness";

// The approval policy route (Phase 5 spec §4.6, WP11), for real, behind the real withViewer and
// withViewerTenant, on PGlite with every migration, signed in through Better Auth's real handler:
// the step-up (a sign-in from the last 5 minutes), the version, its audit entry and checkpoint,
// and the snapshot `POST /api/sessions` signs for each new session, so a change applies from the
// next one. The step-up is tested here, on fresh and stale sign-in sessions, a passkey's among
// them, rather than in Playwright: the e2e suites don't exercise passkeys yet.
const scope = vi.hoisted(() => ({
  cookie: "",
  auth: undefined as unknown,
  db: undefined as unknown,
  policyDeps: undefined as unknown,
  voiceDeps: undefined as unknown,
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
vi.mock("@/lib/auth", () => ({ getAuth: async () => scope.auth }));
vi.mock("@/lib/db", () => ({ getDb: async () => scope.db }));
vi.mock("@/lib/policies/deps", () => ({ policyRouteDeps: () => scope.policyDeps }));
vi.mock("@/lib/voice/deps", () => ({ voiceRouteDeps: async () => scope.voiceDeps }));

const policiesRoute = await import("@/app/api/policies/route");
const sessionsRoute = await import("@/app/api/sessions/route");
const { withViewerTenant } = await import("@/lib/auth/viewer");

const { approvalPolicies, auditCheckpoints, auditLog, passkey, user } = schema;

/** Generated for these tests only. */
const TICKET_SECRET = "tkVx9Qm2Lr7Hw4Zp8Nc6Bt1Kd5Jy3Fg0Ua7Se2Wq";
const EDGE_ORIGIN = "https://earshot-edge.example.workers.dev";
const PROVIDERS = {
  speechToText: { provider: "assemblyai", model: "universal-streaming-english" },
  llm: { provider: "anthropic", model: "claude-haiku-5-5" },
} satisfies SessionProviders;

const NOTES: ApprovalPolicyRules = {
  v: 1,
  autoApprove: [{ id: "notes", type: "note", alwaysReview: [] }],
};
const NOTES_AND_DEALS: ApprovalPolicyRules = {
  v: 1,
  autoApprove: [
    { id: "notes", type: "note", alwaysReview: [] },
    { id: "deal-updates", type: "deal_update", alwaysReview: ["amount", "stage"] },
  ],
};

let template: PGlite;
let db: TestDb;
let auth: Auth;
let outbox: MagicLinkMessage[];
let log: ReturnType<typeof memoryLogger>;
let policyDeps: PolicyRouteDeps;
let clock: number;

beforeAll(async () => {
  template = await migratedTemplate();
});

beforeEach(async () => {
  db = await cloneDb(template);
  outbox = [];
  log = memoryLogger();
  auth = testAuth({ db, outbox, log });
  clock = Date.now();
  policyDeps = { withViewerTenant, env: {}, log, now: () => new Date(clock), mode: "development" };
  const voiceDeps: VoiceRouteDeps = {
    db,
    withViewerTenant,
    env: { EARSHOT_SESSION_TICKET_SECRET: TICKET_SECRET, EDGE_PUBLIC_URL: EDGE_ORIGIN },
    log,
    fetch: async () => new Response(null, { status: 500 }),
    now: () => new Date(clock),
    mode: "production",
    rateLimit: false,
  };
  Object.assign(scope, { cookie: "", auth, db, policyDeps, voiceDeps });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.$client.close();
});

/** Signs in by magic link, through the real handler, and makes them the requests' viewer. */
async function signIn(email: string): Promise<Viewer> {
  const { cookie } = await signInByMagicLink(auth, outbox, email);
  return asViewer(cookie);
}

async function asViewer(cookie: string): Promise<Viewer> {
  scope.cookie = cookie;
  const viewer = await loadViewer({ auth, db, headers: withCookie(cookie) });
  if (!viewer) throw new Error("sign-in produced no viewer");
  return viewer;
}

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");

/**
 * Signs in with a passkey, through Better Auth's real handler: a software P-256 authenticator,
 * registered as the user's passkey, answers the challenge, and the verify step sets the session
 * cookie. As `test/sign-in-method.test.ts` does.
 */
async function signInWithPasskey(userId: string, email: string): Promise<Viewer> {
  await db.insert(user).values({ id: userId, name: "Pat Key", email });
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x ?? "", "base64url");
  const y = Buffer.from(jwk.y ?? "", "base64url");
  // COSE_Key, CBOR-encoded: {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const coseKey = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
  const credentialId = b64url(randomBytes(16));
  await db.insert(passkey).values({
    id: `pk-${userId}`,
    name: "Laptop",
    publicKey: coseKey.toString("base64"),
    userId,
    credentialID: credentialId,
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    transports: "internal",
    createdAt: new Date(),
  });
  const options = await auth.handler(authRequest("/passkey/generate-authenticate-options"));
  const { challenge } = (await options.json()) as { challenge: string };
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }),
  );
  const authenticatorData = Buffer.concat([
    createHash("sha256").update("localhost").digest(),
    Buffer.from([0x05]),
    Buffer.from([0, 0, 0, 1]),
  ]);
  const signature = signData(
    "sha256",
    Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
    privateKey,
  );
  const verified = await auth.handler(
    authRequest("/passkey/verify-authentication", {
      cookie: cookiesFrom(options),
      body: {
        response: {
          id: credentialId,
          rawId: credentialId,
          type: "public-key",
          response: {
            authenticatorData: b64url(authenticatorData),
            clientDataJSON: b64url(clientDataJSON),
            signature: b64url(signature),
            userHandle: b64url(Buffer.from(userId)),
          },
          clientExtensionResults: {},
          authenticatorAttachment: "platform",
        },
      },
    }),
  );
  if (verified.status !== 200) throw new Error(`passkey sign-in answered ${verified.status}`);
  return asViewer(cookiesFrom(verified));
}

const tenantOf = (viewer: Viewer): TenantContext => ({
  userId: viewer.user.id,
  workspaceId: viewer.workspaceId,
});

type Result = { status: number; body: Record<string, unknown> };

async function putPolicy(body: unknown, headers: Record<string, string> = {}): Promise<Result> {
  const response = await policiesRoute.PUT(
    new Request(`${ORIGIN}/api/policies`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    undefined,
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function createSession(): Promise<Result> {
  const response = await sessionsRoute.POST(
    new Request(`${ORIGIN}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "debrief", engine: "cascaded", providers: PROVIDERS }),
    }),
    undefined,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const policyRows = () => db.select().from(approvalPolicies).orderBy(asc(approvalPolicies.version));

describe("isSteppedUp", () => {
  const at = new Date("2026-11-20T12:00:00.000Z");
  const session = (secondsAgo: number, signInMethod = "passkey" as const) => ({
    createdAt: new Date(at.getTime() - secondsAgo * 1000),
    signInMethod,
  });

  it("asks for a sign-in from the last 5 minutes, by a method Earshot recorded", () => {
    expect(STEP_UP_SECONDS).toBe(300);
    expect(isSteppedUp(session(0), at)).toBe(true);
    expect(isSteppedUp(session(299), at)).toBe(true);
    expect(isSteppedUp(session(300), at)).toBe(false);
    expect(isSteppedUp(session(3_600), at)).toBe(false);
    // A sign-in stamped a moment ahead of this clock counts as just begun.
    expect(isSteppedUp(session(-2), at)).toBe(true);
    for (const method of ["magic_link", "github", "google"] as const) {
      expect(isSteppedUp({ ...session(10), signInMethod: method }, at)).toBe(true);
    }
    expect(isSteppedUp({ ...session(10), signInMethod: "unknown" }, at)).toBe(false);
  });
});

// Better Auth's real handler over PGlite; CI runs it far slower than a laptop does.
describe("PUT /api/policies", { timeout: 120_000 }, () => {
  it("answers 401 to a signed-out request", async () => {
    const result = await putPolicy({ rules: NOTES, baseVersion: 0 });
    expect(result.status).toBe(401);
    expect(await policyRows()).toEqual([]);
  });

  it("refuses a sign-in older than 5 minutes with step_up_required, and writes nothing", async () => {
    await signIn("ana@acme.example");
    clock += (STEP_UP_SECONDS + 1) * 1000;
    const result = await putPolicy({ rules: NOTES, baseVersion: 0 });
    expect(result).toEqual({
      status: 403,
      body: {
        error: "step_up_required",
        message:
          "Changing an approval policy needs a sign-in from the last 5 minutes. Confirm it's you, then save again.",
      },
    });
    expect(await policyRows()).toEqual([]);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "policy.changed"))).toEqual(
      [],
    );
    // The hour other sensitive actions allow isn't enough here.
    clock += 30 * 60 * 1000;
    expect((await putPolicy({ rules: NOTES, baseVersion: 0 })).status).toBe(403);
  });

  it("allows a fresh passkey sign-in, and records the passkey in the version's audit entry and its checkpoint", async () => {
    const viewer = await signInWithPasskey("u-pk", "pat@acme.example");
    expect(viewer.session.signInMethod).toBe("passkey");
    const result = await putPolicy({ rules: NOTES_AND_DEALS, baseVersion: 0 });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      changed: true,
      policy: { version: 1, rules: NOTES_AND_DEALS, createdBy: viewer.user.id },
    });
    const policy = result.body.policy as { id: string; rulesSha256: string };

    const [row] = await policyRows();
    expect(row).toMatchObject({
      workspaceId: viewer.workspaceId,
      id: policy.id,
      version: 1,
      createdBy: viewer.user.id,
      rulesSha256: policy.rulesSha256,
    });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "policy.changed"));
    expect(entry).toMatchObject({
      workspaceId: viewer.workspaceId,
      actorUserId: viewer.user.id,
      subjectType: "approval_policy",
      subjectId: policy.id,
      detail: {
        policyId: policy.id,
        version: 1,
        rulesSha256: policy.rulesSha256,
        auth: { method: "passkey", signedInAt: viewer.session.createdAt.toISOString() },
      },
    });
    const checkpoints = await db
      .select()
      .from(auditCheckpoints)
      .where(eq(auditCheckpoints.workspaceId, viewer.workspaceId));
    expect(checkpoints.map((checkpoint) => [checkpoint.chainSeq, checkpoint.request])).toEqual([
      [entry?.chainSeq, "policy"],
    ]);
  });

  it("allows a fresh magic-link sign-in too, and appends each change as the next version", async () => {
    await signIn("ana@acme.example");
    clock += 4 * 60 * 1000; // within the 5 minutes
    const first = await putPolicy({ rules: NOTES, baseVersion: 0 });
    expect(first).toMatchObject({ status: 200, body: { policy: { version: 1 } } });
    const second = await putPolicy({ rules: NOTES_AND_DEALS, baseVersion: 1 });
    expect(second).toMatchObject({ status: 200, body: { policy: { version: 2 } } });
    const same = await putPolicy({ rules: NOTES_AND_DEALS, baseVersion: 2 });
    expect(same).toMatchObject({ status: 200, body: { changed: false, policy: { version: 2 } } });
    expect((await policyRows()).map((row) => row.version)).toEqual([1, 2]);
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, "policy.changed"));
    expect(
      entries.map((entry) => (entry.detail as { auth: { method: string } }).auth.method),
    ).toEqual(["magic_link", "magic_link"]);
  });

  it("refuses a change made from an older version with 409 stale", async () => {
    await signIn("ana@acme.example");
    await putPolicy({ rules: NOTES, baseVersion: 0 });
    const stale = await putPolicy({ rules: NOTES_AND_DEALS, baseVersion: 0 });
    expect(stale).toMatchObject({ status: 409, body: { error: "stale", currentVersion: 1 } });
    expect(await policyRows()).toHaveLength(1);
  });

  it("refuses cross-site requests, oversized bodies, and rules the writer's checks refuse, quoting nothing", async () => {
    await signIn("ana@acme.example");
    expect(
      await putPolicy({ rules: NOTES, baseVersion: 0 }, { "sec-fetch-site": "cross-site" }),
    ).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(
      await putPolicy({ rules: NOTES, baseVersion: 0 }, { "content-length": "20000" }),
    ).toMatchObject({ status: 413, body: { error: "too_large" } });
    const shaped = `sk-${"a".repeat(24)}`;
    const bad: unknown[] = [
      "not json",
      { rules: NOTES },
      { rules: NOTES, baseVersion: -1 },
      { rules: NOTES, baseVersion: 0, extra: true },
      { rules: { v: 2, autoApprove: [] }, baseVersion: 0 },
      // Two rules for one type.
      {
        rules: {
          v: 1,
          autoApprove: [
            { id: "notes", type: "note", alwaysReview: [] },
            { id: "more-notes", type: "note", alwaysReview: [] },
          ],
        },
        baseVersion: 0,
      },
      // Another type's field.
      {
        rules: { v: 1, autoApprove: [{ id: "notes", type: "note", alwaysReview: ["amount"] }] },
        baseVersion: 0,
      },
      // An id shaped like a key, which would stop every session's start.
      {
        rules: { v: 1, autoApprove: [{ id: shaped, type: "note", alwaysReview: [] }] },
        baseVersion: 0,
      },
    ];
    for (const body of bad) {
      const result = await putPolicy(body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(result.body.error).toBe("invalid_request");
      expect(JSON.stringify(result.body)).not.toContain(shaped);
    }
    expect(log.lines.join("\n")).not.toContain(shaped);
    expect(await policyRows()).toEqual([]);
  });

  it("fails closed without a usable audit signing key: 503, before touching the database", async () => {
    await signIn("ana@acme.example");
    policyDeps.mode = "production";
    const result = await putPolicy({ rules: NOTES, baseVersion: 0 });
    expect(result).toMatchObject({ status: 503, body: { error: "audit_unavailable" } });
    expect(await policyRows()).toEqual([]);
  });

  it("keeps each workspace's policy its own", async () => {
    const ana = await signIn("ana@acme.example");
    await putPolicy({ rules: NOTES, baseVersion: 0 });
    const bo = await signIn("bo@bravo.example");
    expect(bo.workspaceId).not.toBe(ana.workspaceId);
    // Bo's first change starts at version 1, from no policy, whatever Ana's is.
    const result = await putPolicy({ rules: NOTES_AND_DEALS, baseVersion: 0 });
    expect(result).toMatchObject({ status: 200, body: { policy: { version: 1 } } });
    const rows = await policyRows();
    expect(rows.map((row) => [row.workspaceId, row.version])).toEqual(
      expect.arrayContaining([
        [ana.workspaceId, 1],
        [bo.workspaceId, 1],
      ]),
    );
    const anaId = rows.find((row) => row.workspaceId === ana.workspaceId)?.id;
    const boId = rows.find((row) => row.workspaceId === bo.workspaceId)?.id;
    expect(anaId).not.toBe(boId);
  });
});

describe("the snapshot POST /api/sessions signs", { timeout: 120_000 }, () => {
  it("is null without a policy, or with one that approves nothing", async () => {
    await signIn("ana@acme.example");
    expect((await createSession()).body.policy).toBeNull();
    await putPolicy({ rules: { v: 1, autoApprove: [] }, baseVersion: 0 });
    expect((await createSession()).body.policy).toBeNull();
  });

  it("carries the latest version, signed for that session alone, so a change applies from the next session", async () => {
    await signIn("ana@acme.example");
    await putPolicy({ rules: NOTES, baseVersion: 0 });
    const first = await createSession();
    expect(first.status).toBe(201);
    const firstId = first.body.sessionId as string;
    const snapshot = first.body.policy as PolicySnapshot;
    expect(snapshot).toMatchObject({ version: 1, rules: NOTES });
    expect(await verifyPolicySnapshot(TICKET_SECRET, snapshot, firstId)).toBe(true);

    // The policy changes mid-session: the session that started keeps version 1...
    await putPolicy({ rules: NOTES_AND_DEALS, baseVersion: 1 });
    const second = await createSession();
    const secondId = second.body.sessionId as string;
    const next = second.body.policy as PolicySnapshot;
    expect(next).toMatchObject({ id: snapshot.id, version: 2, rules: NOTES_AND_DEALS });
    expect(await verifyPolicySnapshot(TICKET_SECRET, next, secondId)).toBe(true);
    // ...and neither snapshot passes for the other session, nor with another secret.
    expect(await verifyPolicySnapshot(TICKET_SECRET, snapshot, secondId)).toBe(false);
    expect(await verifyPolicySnapshot(TICKET_SECRET, next, firstId)).toBe(false);
    expect(await verifyPolicySnapshot(`${TICKET_SECRET}-other`, next, secondId)).toBe(false);
    expect(log.lines.join("\n")).not.toContain(TICKET_SECRET);
  });

  it("fits, with the session's entities, in the 64 KiB start the client sends", async () => {
    const viewer = await signIn("ana@acme.example");
    await withTenant(db, tenantOf(viewer), (tx) => loadDemoCrm(tx));
    await putPolicy({ rules: NOTES_AND_DEALS, baseVersion: 0 });
    const created = await createSession();
    const entities = created.body.entities as unknown[];
    expect(entities.length).toBeGreaterThan(0);
    const frame = JSON.stringify({
      t: "start",
      msgId: "01a1c6e2-9320-7deb-a57a-ba62dc02df02",
      mode: "debrief",
      engine: "cascaded",
      providers: PROVIDERS,
      startedAt: "2026-11-15T19:15:00.000Z",
      entities,
      policy: created.body.policy,
    });
    expect(utf8Length(frame)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(parseClientMessage(frame).ok).toBe(true);
  });
});
