// Secrets and dev-only settings that `wrangler types` can't see in wrangler.jsonc.
interface CloudflareEnv {
  /** Neon pooled connection string. Set per Worker at deploy time; locally in .dev.vars. */
  DATABASE_URL?: string;
  /** Dev only: where `next dev` reaches the edge Worker when the service binding is missing. */
  EDGE_DEV_URL?: string;
}
