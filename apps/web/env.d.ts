// Secrets and dev-only settings that `wrangler types` can't see in wrangler.jsonc. Set secrets per
// Worker at deploy time; locally, put them in .dev.vars (see .dev.vars.example). Every one is
// optional here because `next dev` runs with none of them: lib/auth/config.ts and
// lib/voice/config.ts decide which are required outside development and fail closed when they're
// missing.
interface CloudflareEnv {
  /**
   * Neon pooled connection string. Set per Worker at deploy time; locally in .dev.vars. When it's
   * unset under `next dev`, the app uses an in-process PGlite database in apps/web/.data/.
   */
  DATABASE_URL?: string;
  /**
   * Dev only: where `next dev` reaches the edge Worker when the service binding is missing, and
   * where the browser opens session sockets when EDGE_PUBLIC_URL is unset.
   */
  EDGE_DEV_URL?: string;
  /**
   * The edge Worker's public origin, where the browser opens session sockets (docs/adr/0023),
   * for example https://earshot-edge.<subdomain>.workers.dev. CI renders it per target. Required
   * outside development, where it must use https (or be localhost) and carry no path; `next dev`
   * falls back to EDGE_DEV_URL, then to http://localhost:8787.
   */
  EDGE_PUBLIC_URL?: string;
  /**
   * Signs session tickets (docs/adr/0023), which the edge Worker verifies with the same value
   * before a browser may open a session socket: at least 32 random bytes
   * (`openssl rand -base64 32`), set as a secret on both Workers. Required outside development,
   * where @earshot/core's development-only ticket secret is refused; `next dev` falls back to
   * that value, as the edge Worker does under `wrangler dev`.
   */
  EARSHOT_SESSION_TICKET_SECRET?: string;

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

  /**
   * Turns on the optional server vault (docs/adr/0021): 32 random bytes, base64-encoded, which
   * wrap the data key of every AI key stored in `credentials` and every CRM token. Generate one
   * with `generateMasterKey()` from `@earshot/keys/server` or `openssl rand -base64 32`. Unset,
   * the vault is off: the server refuses to store AI keys, and Settings → Keys offers only
   * on-device storage. A value that is set but isn't a usable key fails closed: vault requests
   * answer 500 and the log says why, without quoting it. Changing it needs the rotation runbook
   * (docs/vault-key-rotation.md), or stored keys stop opening.
   */
  EARSHOT_VAULT_MASTER_KEY?: string;

  /**
   * Signs the audit chain's checkpoints (docs/adr/0033): a private Ed25519 JWK,
   * {"kty":"OKP","crv":"Ed25519","d":…,"x":…,"kid":…}, from
   * `pnpm --filter @earshot/keys audit-key:new`, set as a secret on both Workers. Without a usable
   * one outside development, writes that need a checkpoint fail closed and /api/health says so;
   * `next dev` falls back to the committed development key, which is refused anywhere else.
   * Rotating it: add the old public JWK to EARSHOT_AUDIT_RETIRED_KEYS, then set the new secret.
   */
  EARSHOT_AUDIT_SIGNING_KEY?: string;
  /**
   * Public and optional: the public JWKs of signing keys rotated out, as a JSON array, each with
   * an optional `retiredAt` time, so /api/audit/keys still serves them and old checkpoints still
   * verify. An entry holding a private key ("d") is refused, and the key list isn't served.
   */
  EARSHOT_AUDIT_RETIRED_KEYS?: string;
}
