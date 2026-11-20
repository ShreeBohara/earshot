import { createHash, generateKeyPairSync, randomBytes, sign as signData } from "node:crypto";
import { schema } from "@earshot/db";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MagicLinkMessage } from "@/lib/auth/email";
import { signInMethodFor } from "@/lib/auth/sign-in-method";
import {
  authRequest,
  cloneDb,
  cookiesFrom,
  migratedTemplate,
  ORIGIN,
  signInByMagicLink,
  type TestDb,
  testAuth,
  withCookie,
} from "./support/harness";

// How each session signed in (migration 0013, docs/adr/0033), through Better Auth's real handler
// on PGlite: the database hook reads the route of the endpoint creating the session.

const { session, user, passkey } = schema;

let template: PGlite;
let db: TestDb;

beforeAll(async () => {
  template = await migratedTemplate();
});

beforeEach(async () => {
  db = await cloneDb(template);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.$client.close();
});

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");

async function methodsOf(userId: string) {
  const rows = await db
    .select({ method: session.signInMethod })
    .from(session)
    .where(eq(session.userId, userId));
  return rows.map((row) => row.method);
}

describe("signInMethodFor", () => {
  it("maps each sign-in route, and anything else to unknown", () => {
    expect(signInMethodFor({ path: "/magic-link/verify" })).toBe("magic_link");
    expect(signInMethodFor({ path: "/passkey/verify-authentication" })).toBe("passkey");
    expect(signInMethodFor({ path: "/callback/:id", params: { id: "github" } })).toBe("github");
    expect(signInMethodFor({ path: "/callback/:id", params: { id: "google" } })).toBe("google");
    expect(signInMethodFor({ path: "/sign-in/social", body: { provider: "google" } })).toBe(
      "google",
    );
    expect(signInMethodFor({ path: "/callback/:id", params: { id: "gitlab" } })).toBe("unknown");
    expect(signInMethodFor({ path: "/callback/:id" })).toBe("unknown");
    expect(signInMethodFor({ path: "/change-password" })).toBe("unknown");
    expect(signInMethodFor({ path: "/callback/github" })).toBe("unknown"); // a request path, not a route
    expect(signInMethodFor(null)).toBe("unknown");
    expect(signInMethodFor(undefined)).toBe("unknown");
  });
});

// Better Auth's real handler over PGlite; CI runs it far slower than a laptop does.
describe("the sign-in method on each session", { timeout: 120_000 }, () => {
  it("is magic_link after opening a magic link, and getSession returns it", async () => {
    const outbox: MagicLinkMessage[] = [];
    const auth = testAuth({ db, outbox });
    const { cookie } = await signInByMagicLink(auth, outbox, "ana@acme.example");
    const [ana] = await db.select().from(user).where(eq(user.email, "ana@acme.example"));

    expect(await methodsOf(ana?.id ?? "")).toEqual(["magic_link"]);
    const current = await auth.api.getSession({ headers: withCookie(cookie) });
    expect(current?.session).toMatchObject({ signInMethod: "magic_link" });
  });

  it("is passkey after a passkey assertion", async () => {
    const auth = testAuth({ db });
    await db.insert(user).values({ id: "u-pk", name: "Pat Key", email: "pat@acme.example" });

    // A software authenticator: a P-256 key made for this test, registered as the user's passkey.
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
      id: "pk-1",
      name: "Laptop",
      publicKey: coseKey.toString("base64"),
      userId: "u-pk",
      credentialID: credentialId,
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      transports: "internal",
      createdAt: new Date(),
    });

    const options = await auth.handler(authRequest("/passkey/generate-authenticate-options"));
    expect(options.status).toBe(200);
    const { challenge } = (await options.json()) as { challenge: string };
    const cookie = cookiesFrom(options);

    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }),
    );
    const authenticatorData = Buffer.concat([
      createHash("sha256").update("localhost").digest(), // the RP id: the app's hostname
      Buffer.from([0x05]), // user present and verified
      Buffer.from([0, 0, 0, 1]), // sign count
    ]);
    const signature = signData(
      "sha256",
      Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
      privateKey,
    );
    const verified = await auth.handler(
      authRequest("/passkey/verify-authentication", {
        cookie,
        body: {
          response: {
            id: credentialId,
            rawId: credentialId,
            type: "public-key",
            response: {
              authenticatorData: b64url(authenticatorData),
              clientDataJSON: b64url(clientDataJSON),
              signature: b64url(signature),
              userHandle: b64url(Buffer.from("u-pk")),
            },
            clientExtensionResults: {},
            authenticatorAttachment: "platform",
          },
        },
      }),
    );
    expect(verified.status, await verified.clone().text()).toBe(200);
    expect(await methodsOf("u-pk")).toEqual(["passkey"]);
  });

  it("is github after GitHub's OAuth callback (GitHub stubbed: no network)", async () => {
    const auth = testAuth({
      db,
      env: { GITHUB_CLIENT_ID: "gh-client-id", GITHUB_CLIENT_SECRET: "gh-client-secret" },
    });
    const started = await auth.handler(
      authRequest("/sign-in/social", { body: { provider: "github", callbackURL: "/home" } }),
    );
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";
    expect(state).not.toBe("");

    const realFetch = globalThis.fetch;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const target = String(input instanceof Request ? input.url : input);
        if (target.startsWith("https://github.com/login/oauth/access_token")) {
          return json({
            access_token: "gho_test_token",
            token_type: "bearer",
            scope: "read:user,user:email",
          });
        }
        if (target === "https://api.github.com/user") {
          return json({
            id: 4242,
            login: "ana",
            name: "Ana Example",
            email: "ana@acme.example",
            avatar_url: null,
          });
        }
        if (target === "https://api.github.com/user/emails") {
          return json([{ email: "ana@acme.example", primary: true, verified: true }]);
        }
        if (target.startsWith("http://") || target.startsWith("https://")) {
          throw new Error(`unexpected network call to ${target}`);
        }
        return realFetch(input, init);
      }),
    );

    const callback = await auth.handler(
      new Request(
        `${ORIGIN}/api/auth/callback/github?code=test-code&state=${encodeURIComponent(state)}`,
        {
          headers: { origin: ORIGIN, cookie: cookiesFrom(started) },
        },
      ),
    );
    expect(callback.status, await callback.clone().text()).toBe(302);
    const [ana] = await db.select().from(user).where(eq(user.email, "ana@acme.example"));
    expect(await methodsOf(ana?.id ?? "")).toEqual(["github"]);
  });

  it("is unknown for a session row written without it, and nothing else is allowed", async () => {
    await db.insert(user).values({ id: "u-old", name: "Old", email: "old@acme.example" });
    await db.insert(session).values({
      id: "s-old",
      token: "token-for-a-session-from-before-0013",
      userId: "u-old",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      updatedAt: new Date(),
    });
    expect(await methodsOf("u-old")).toEqual(["unknown"]);
    await expect(
      db
        .update(session)
        .set({ signInMethod: "password" as "unknown" })
        .where(eq(session.id, "s-old")),
    ).rejects.toThrow();
  });
});
