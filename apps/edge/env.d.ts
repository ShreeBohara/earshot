// Secrets and optional settings that `wrangler types` can't see in wrangler.jsonc. Set secrets
// per Worker at deploy time (CI passes them from the GitHub environment); locally, put them in
// .dev.vars (see .dev.vars.example). All are optional here because `wrangler dev` and the tests
// run with none: src/config.ts decides what's required outside development, and fails closed.
interface EdgeSecrets {
  /**
   * Verifies session tickets: the same value the web Worker signs them with, at least 32 random
   * bytes (`openssl rand -base64 32`). Required outside development, where the development-only
   * value from `@earshot/core` is refused; `wrangler dev` falls back to that value, as `next dev`
   * does, so a fresh clone works with no `.dev.vars`.
   */
  EARSHOT_SESSION_TICKET_SECRET?: string;
  /**
   * Neon's pooled connection string, for the Queue consumer that flushes sessions to Postgres.
   * Without it the consumer acks each batch and logs "flush skipped": the events stay in each
   * session's Durable Object.
   */
  DATABASE_URL?: string;
  /** Route LLM calls through Cloudflare AI Gateway; only when both are set (@earshot/agent). */
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
}

interface Env extends EdgeSecrets {}

declare namespace Cloudflare {
  interface Env extends EdgeSecrets {}
}
