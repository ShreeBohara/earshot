// Secrets and dev-only settings that `wrangler types` can't see in wrangler.jsonc. Set secrets per
// Worker at deploy time; locally, put them in .dev.vars (see .dev.vars.example). Every one is
// optional here because `next dev` runs with none of them: lib/auth/config.ts decides which are
// required outside development and fails closed when they're missing.
interface CloudflareEnv {
  /**
   * Neon pooled connection string. Set per Worker at deploy time; locally in .dev.vars. When it's
   * unset under `next dev`, the app uses an in-process PGlite database in apps/web/.data/.
   */
  DATABASE_URL?: string;
  /** Dev only: where `next dev` reaches the edge Worker when the service binding is missing. */
  EDGE_DEV_URL?: string;

  /**
   * Signs and encrypts Better Auth's cookies and tokens: at least 32 random characters
   * (`openssl rand -base64 32`). Required outside development; `next dev` falls back to a fixed
   * development-only value.
   */
  BETTER_AUTH_SECRET?: string;
  /**
   * The app's public origin, for example https://earshot-web.<subdomain>.workers.dev. Magic links,
   * OAuth callbacks, and passkeys are bound to it. Required outside development, where it must be
   * https (or localhost); `next dev` defaults to http://localhost:3000.
   */
  BETTER_AUTH_URL?: string;
  /** Optional, comma-separated: more origins allowed to call the auth API (CSRF origin check). */
  BETTER_AUTH_TRUSTED_ORIGINS?: string;

  /** GitHub sign-in is on only when both the client id and secret are set. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Google sign-in is on only when both the client id and secret are set. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  /**
   * Magic-link email goes through Resend's HTTP API when both are set. Without them, `next dev`
   * prints the link to the server console (development only) and production refuses to send.
   */
  RESEND_API_KEY?: string;
  /** The sender, for example `Earshot <sign-in@mail.example.com>`, on a domain verified in Resend. */
  EMAIL_FROM?: string;
}
