// Auth configuration read from the Worker's environment (env.d.ts), checked once per isolate.
// Pure: no Cloudflare or Next imports, so tests pass whatever environment they need.
import { auditKeySecretValues } from "@earshot/keys/server";

/** `development` is `next dev` only. Every built bundle, previews included, is `production`. */
export type Mode = "development" | "production";

export const MODE: Mode = process.env.NODE_ENV === "development" ? "development" : "production";

/** The environment variables auth reads. All optional: `next dev` runs with none of them. */
export type AuthEnv = {
  BETTER_AUTH_SECRET?: string | undefined;
  BETTER_AUTH_URL?: string | undefined;
  BETTER_AUTH_TRUSTED_ORIGINS?: string | undefined;
  GITHUB_CLIENT_ID?: string | undefined;
  GITHUB_CLIENT_SECRET?: string | undefined;
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  EMAIL_FROM?: string | undefined;
};

export type SocialProviderId = "github" | "google";

export type AuthConfig = {
  mode: Mode;
  secret: string;
  /** The public origin, without a path. */
  baseURL: string;
  trustedOrigins: string[];
  /** Only the providers whose client id and secret are both set. */
  social: Partial<Record<SocialProviderId, { clientId: string; clientSecret: string }>>;
  /** Resend credentials, or null when magic-link email has no provider. */
  email: { resendApiKey: string; from: string } | null;
};

/** Thrown at startup when the environment can't run auth safely. The message names the fix. */
export class AuthConfigError extends Error {
  override name = "AuthConfigError";
}

/**
 * Used only by `next dev`, so a fresh clone runs with no setup. Never accepted in production:
 * readAuthConfig requires BETTER_AUTH_SECRET there.
 */
export const DEV_SECRET = "earshot-development-only-secret-never-use-this-outside-next-dev";
const DEV_BASE_URL = "http://localhost:3000";
const MIN_SECRET_LENGTH = 32;

function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Whether a URL's hostname is this machine, which may use plain http even outside development. */
export function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseOrigin(raw: string, name: string, mode: Mode): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuthConfigError(`${name} must be an absolute URL, such as https://app.example.com`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AuthConfigError(`${name} must use https`);
  }
  if (mode === "production" && url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw new AuthConfigError(`${name} must use https outside development (or be localhost)`);
  }
  return url.origin;
}

/** Which OAuth providers this environment configures: both the client id and secret are set. */
export function configuredSocialProviders(env: AuthEnv): AuthConfig["social"] {
  const social: AuthConfig["social"] = {};
  const github = { id: value(env.GITHUB_CLIENT_ID), secret: value(env.GITHUB_CLIENT_SECRET) };
  if (github.id && github.secret) {
    social.github = { clientId: github.id, clientSecret: github.secret };
  }
  const google = { id: value(env.GOOGLE_CLIENT_ID), secret: value(env.GOOGLE_CLIENT_SECRET) };
  if (google.id && google.secret) {
    social.google = { clientId: google.id, clientSecret: google.secret };
  }
  return social;
}

/** The provider ids to show on the sign-in page, in display order. */
export function socialProviderIds(env: AuthEnv): SocialProviderId[] {
  const social = configuredSocialProviders(env);
  return (["github", "google"] as const).filter((id) => social[id]);
}

/**
 * Reads and checks the auth environment. In development every value has a default. Outside it,
 * BETTER_AUTH_SECRET (32+ characters) and BETTER_AUTH_URL (https) are required, and a missing one
 * throws instead of falling back: auth fails closed rather than running with a guessable secret.
 */
export function readAuthConfig(env: AuthEnv, mode: Mode = MODE): AuthConfig {
  const rawSecret = value(env.BETTER_AUTH_SECRET);
  if (mode === "production" && !rawSecret) {
    throw new AuthConfigError(
      "BETTER_AUTH_SECRET is not set. It is required outside development: set it as a Worker secret (openssl rand -base64 32).",
    );
  }
  const secret = rawSecret ?? DEV_SECRET;
  if (mode === "production" && secret === DEV_SECRET) {
    throw new AuthConfigError(
      "BETTER_AUTH_SECRET is the development-only value; generate a new one.",
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new AuthConfigError(
      `BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -base64 32).`,
    );
  }

  const rawURL = value(env.BETTER_AUTH_URL);
  if (mode === "production" && !rawURL) {
    throw new AuthConfigError(
      "BETTER_AUTH_URL is not set. It is required outside development: set it to the app's public origin.",
    );
  }
  const baseURL = parseOrigin(rawURL ?? DEV_BASE_URL, "BETTER_AUTH_URL", mode);

  const extraOrigins = (value(env.BETTER_AUTH_TRUSTED_ORIGINS) ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => parseOrigin(origin, "BETTER_AUTH_TRUSTED_ORIGINS", mode));

  const resendApiKey = value(env.RESEND_API_KEY);
  const from = value(env.EMAIL_FROM);

  return {
    mode,
    secret,
    baseURL,
    trustedOrigins: [...new Set([baseURL, ...extraOrigins])],
    social: configuredSocialProviders(env),
    email: resendApiKey && from ? { resendApiKey, from } : null,
  };
}

/** Values the logger must redact if they ever reach a log line. */
export function secretValues(
  env: AuthEnv & {
    DATABASE_URL?: string | undefined;
    EARSHOT_VAULT_MASTER_KEY?: string | undefined;
    EARSHOT_SESSION_TICKET_SECRET?: string | undefined;
    EARSHOT_AUDIT_SIGNING_KEY?: string | undefined;
  },
): string[] {
  return [
    env.BETTER_AUTH_SECRET,
    env.GITHUB_CLIENT_SECRET,
    env.GOOGLE_CLIENT_SECRET,
    env.RESEND_API_KEY,
    env.DATABASE_URL,
    env.EARSHOT_VAULT_MASTER_KEY,
    env.EARSHOT_SESSION_TICKET_SECRET,
    // The whole JWK and its private "d" alone, which survives JSON escaping.
    ...auditKeySecretValues(env.EARSHOT_AUDIT_SIGNING_KEY),
  ].filter((secret): secret is string => Boolean(secret?.trim()));
}
