import { schema } from "@earshot/db";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { type AuthEnv, type Mode, readAuthConfig } from "@/lib/auth/config";
import type { MagicLinkMessage } from "@/lib/auth/email";
import { type Auth, type AuthDeps, createAuth } from "@/lib/auth/server";
import { openPglite } from "@/lib/db/pglite";
import type { AppDb } from "@/lib/db/types";
import { createLogger, type Logger } from "@/lib/log";

export const ORIGIN = "http://localhost:3000";
/** Generated for these tests only. */
export const TEST_SECRET = "test-secret-for-vitest-only-0123456789abcdefghij";

/** A migrated in-memory database to clone per test: cloning is much faster than migrating. */
export async function migratedTemplate(): Promise<PGlite> {
  const db = await openPglite();
  return db.$client;
}

export async function cloneDb(template: PGlite) {
  const client = (await template.clone()) as PGlite;
  return drizzle({ client, schema });
}

export type TestDb = Awaited<ReturnType<typeof cloneDb>>;

/** Collects log lines instead of printing them. */
export function memoryLogger(secrets: string[] = []): Logger & { lines: string[] } {
  const lines: string[] = [];
  return Object.assign(
    createLogger(
      () => secrets,
      (line) => lines.push(line),
    ),
    { lines },
  );
}

type TestAuthOptions = {
  db: AppDb;
  mode?: Mode;
  env?: AuthEnv;
  /** Capture magic links here; omit `outbox` and pass `sendMagicLink: undefined` to use the real sender. */
  outbox?: MagicLinkMessage[] | null;
  log?: Logger;
  rateLimit?: boolean;
  fetch?: AuthDeps["fetch"];
  /** What account deletion calls to purge session storage; by default it does nothing. */
  purgeSessions?: AuthDeps["purgeSessions"];
};

/** A Better Auth instance wired like the app's, against a test database. */
export function testAuth({
  db,
  mode = "development",
  env = {},
  outbox = [],
  log = memoryLogger(),
  rateLimit = false,
  fetch,
  purgeSessions = async () => {},
}: TestAuthOptions): Auth {
  return createAuth({
    config: readAuthConfig(
      { BETTER_AUTH_SECRET: TEST_SECRET, BETTER_AUTH_URL: ORIGIN, ...env },
      mode,
    ),
    db,
    log,
    rateLimit,
    purgeSessions,
    ...(outbox ? { sendMagicLink: async (message) => void outbox.push(message) } : {}),
    ...(fetch ? { fetch } : {}),
  });
}

/** A request to the auth API, as the browser would send it from the app's own origin. */
export function authRequest(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; ip?: string } = {},
): Request {
  const headers = new Headers({ origin: ORIGIN });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.ip) headers.set("cf-connecting-ip", init.ip);
  return new Request(`${ORIGIN}/api/auth${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/** The `name=value` pairs a response sets, ready for a Cookie header. Deleted cookies are left out. */
export function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .filter((pair) => pair.includes("=") && !pair.endsWith("="))
    .join("; ");
}

/**
 * Signs in by magic link through the real HTTP handler: request the link, then open it.
 * Returns the session cookie and where the verify step redirected.
 */
export async function signInByMagicLink(
  auth: Auth,
  outbox: MagicLinkMessage[],
  email: string,
  callbackURL = "/home",
): Promise<{ cookie: string; location: string | null }> {
  const sent = await auth.handler(
    authRequest("/sign-in/magic-link", {
      body: { email, callbackURL, newUserCallbackURL: "/onboarding" },
    }),
  );
  if (!sent.ok) throw new Error(`sign-in/magic-link answered ${sent.status}: ${await sent.text()}`);
  const message = outbox.findLast((m) => m.email === email);
  if (!message) throw new Error("no magic link was sent");
  const url = new URL(message.url);
  const verified = await auth.handler(new Request(url, { headers: { origin: ORIGIN } }));
  if (verified.status !== 302) {
    throw new Error(`magic-link/verify answered ${verified.status}: ${await verified.text()}`);
  }
  return { cookie: cookiesFrom(verified), location: verified.headers.get("location") };
}

/** Headers carrying a session cookie, for auth.api calls and loadViewer. */
export function withCookie(cookie: string): Headers {
  return new Headers({ cookie, origin: ORIGIN });
}
