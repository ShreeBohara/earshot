// The Better Auth server, as a factory with every dependency passed in: the app builds one per
// isolate (lib/auth/index.ts) and tests build their own against PGlite. No Next or Cloudflare
// imports here beyond Better Auth's own Next cookie plugin, which no-ops outside a request.
import { passkey } from "@better-auth/passkey";
import { deleteSoleMemberWorkspaces, ensureWorkspace, schema } from "@earshot/db";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins/magic-link";
import type { AppDb } from "../db/types";
import type { Logger } from "../log";
import type { AuthConfig } from "./config";
import { COOKIE_PREFIX } from "./cookies";
import {
  createMagicLinkSender,
  EmailDeliveryError,
  EmailUnavailableError,
  type SendMagicLink,
} from "./email";
import { allowMagicLinkFor } from "./throttle";

/** Magic links work once and expire after five minutes (Better Auth's default). */
export const MAGIC_LINK_TTL_SECONDS = 5 * 60;

/**
 * How recent a sign-in must be for sensitive actions: deleting the account and adding a passkey.
 * Older sessions must sign in again first.
 */
export const FRESH_SESSION_SECONDS = 60 * 60;

/**
 * Per address, whatever the client IP: at most this many magic links per sliding window. The window
 * matches the longest rule below, because Better Auth prunes `rate_limit` rows older than that.
 */
export const MAGIC_LINKS_PER_ADDRESS = { max: 5, windowMs: 10 * 60 * 1000 };

/**
 * Per client IP and path, stored in Postgres so every Worker isolate shares the counters
 * (rate_limit, migration 0011). Paths are relative to /api/auth.
 */
export const RATE_LIMIT_RULES = {
  // Read-only and frequent; limiting it would cost a database round trip per call for nothing.
  "/get-session": false,
  "/sign-in/magic-link": { window: 600, max: 5 },
  "/magic-link/verify": { window: 60, max: 10 },
  "/sign-in/social": { window: 60, max: 10 },
  "/callback/*": { window: 60, max: 20 },
  "/passkey/generate-authenticate-options": { window: 60, max: 20 },
  "/passkey/verify-authentication": { window: 60, max: 10 },
  "/delete-user": { window: 600, max: 5 },
} as const;

export type AuthDeps = {
  config: AuthConfig;
  /** The owner connection. In the app it resolves to the current request's pool on every use. */
  db: AppDb;
  log: Logger;
  /** Replaces the sender built from `config` (tests). */
  sendMagicLink?: SendMagicLink;
  /** For Resend (tests replace it). */
  fetch?: typeof fetch;
  /** Overrides the default: on in production, off in development. */
  rateLimit?: boolean;
};

export function createAuth({ config, db, log, sendMagicLink, fetch, rateLimit }: AuthDeps) {
  const limited = rateLimit ?? config.mode === "production";
  const send =
    sendMagicLink ??
    createMagicLinkSender({
      mode: config.mode,
      email: config.email,
      log,
      ttlMinutes: MAGIC_LINK_TTL_SECONDS / 60,
      ...(fetch ? { fetch } : {}),
    });

  return betterAuth({
    appName: "Earshot",
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    // Text ids and table shapes from packages/db/src/schema/auth.ts. `transaction: true` makes
    // multi-step writes atomic (an OAuth user and their account; consuming a magic link), which is
    // why Better Auth runs on the WebSocket pool and not neon-http (docs/adr/0018).
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
    emailAndPassword: { enabled: false },
    socialProviders: {
      ...(config.social.github ? { github: config.social.github } : {}),
      ...(config.social.google ? { google: config.social.google } : {}),
    },
    session: { freshAge: FRESH_SESSION_SECONDS },
    user: {
      deleteUser: {
        enabled: true,
        // Delete the workspaces only this user belongs to first (cascading their tenant data);
        // deleting the user then cascades their sessions, accounts, passkeys, and memberships.
        beforeDelete: async (user) => {
          await deleteSoleMemberWorkspaces(db, user.id);
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Runs after the user row commits. If it fails, sign-in still succeeds and the next
          // request repairs it: getViewer calls ensureWorkspace when a user has no workspace.
          after: async (user) => {
            try {
              await ensureWorkspace(db, user);
            } catch (error) {
              log.error("workspace bootstrap failed at sign-up; the next request retries it", {
                userId: user.id,
                error,
              });
            }
          },
        },
      },
    },
    rateLimit: {
      enabled: limited,
      storage: "database",
      window: 60,
      max: 100,
      customRules: { ...RATE_LIMIT_RULES },
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: config.baseURL.startsWith("https:"),
      // Set by Cloudflare's edge and not forgeable by the client, unlike X-Forwarded-For.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    telemetry: { enabled: false },
    logger: {
      level: "warn",
      log: (level, message, ...args) => {
        const detail = args.length > 0 ? args : undefined;
        if (level === "error") log.error(`better-auth: ${message}`, detail);
        else if (level === "warn") log.warn(`better-auth: ${message}`, detail);
        else log.info(`better-auth: ${message}`, detail);
      },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        // Only a hash of each token is stored, so a database leak reveals no working links.
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          const allowed =
            !limited ||
            (await allowMagicLinkFor(db, email, {
              ...MAGIC_LINKS_PER_ADDRESS,
              secret: config.secret,
            }));
          if (!allowed) {
            // Answer as if it was sent, so the response doesn't reveal the address's history.
            log.warn("magic link not sent: too many requests for one address");
            return;
          }
          try {
            await send({ email, url });
          } catch (error) {
            if (error instanceof EmailUnavailableError) {
              throw new APIError("SERVICE_UNAVAILABLE", {
                code: "EMAIL_UNAVAILABLE",
                message: "Email sign-in isn't available on this server. Use a passkey instead.",
              });
            }
            if (error instanceof EmailDeliveryError) {
              log.error("magic link not sent", { error });
              throw new APIError("BAD_GATEWAY", {
                code: "EMAIL_NOT_SENT",
                message: "We couldn't send the email. Try again in a minute.",
              });
            }
            throw error;
          }
        },
      }),
      passkey({
        rpID: new URL(config.baseURL).hostname,
        rpName: "Earshot",
        origin: config.baseURL,
      }),
      // Lets server actions set Better Auth's cookies. Must stay last.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
