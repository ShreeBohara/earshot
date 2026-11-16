// Session configuration from the Worker's environment (env.d.ts): the secret that signs session
// tickets, and where the browser opens the session socket. Pure: no Cloudflare or Next imports,
// so tests pass whatever environment they need. Like lib/auth/config.ts, development has a
// default for everything, and anywhere else a missing or unsafe value fails closed.
import {
  DEV_SESSION_TICKET_SECRET,
  isDevTicketSecret,
  MIN_TICKET_SECRET_BYTES,
} from "@earshot/core";
import { isLoopback, MODE, type Mode } from "../auth/config";

/** The environment variables the session routes read. All optional: `next dev` runs with none. */
export type SessionEnv = {
  EARSHOT_SESSION_TICKET_SECRET?: string | undefined;
  EDGE_PUBLIC_URL?: string | undefined;
  EDGE_DEV_URL?: string | undefined;
};

export type SessionConfig = {
  /** Signs tickets. The edge Worker verifies them with the same value. */
  ticketSecret: string;
  /** The edge Worker's origin as a WebSocket origin: `wss://…`, or `ws://` for localhost only. */
  edgeOrigin: string;
};

/**
 * The session routes can't run safely with this environment. The message names the variable and
 * the fix, and never quotes a value, so it is safe to log.
 */
export class SessionConfigError extends Error {
  override name = "SessionConfigError";
}

/** Where `wrangler dev` serves the edge Worker, as app/api/health/route.ts assumes too. */
const DEV_EDGE_URL = "http://localhost:8787";

function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Reads and checks the session environment.
 *
 * - `EARSHOT_SESSION_TICKET_SECRET`: at least 32 bytes. Required outside development, where the
 *   development-only secret from `@earshot/core` is refused (`isDevTicketSecret`), as Better
 *   Auth's development secret is. `next dev` falls back to it, and so does the edge Worker, so a
 *   fresh clone signs and verifies tickets with no `.dev.vars`. Surrounding whitespace is
 *   trimmed; the edge Worker must trim the same way, or signatures won't match.
 * - `EDGE_PUBLIC_URL`: the edge Worker's public origin, with no path. Required outside
 *   development, where it must use https (or wss) unless it's localhost. `next dev` falls back to
 *   `EDGE_DEV_URL`, then to `http://localhost:8787`.
 */
export function readSessionConfig(env: SessionEnv, mode: Mode = MODE): SessionConfig {
  const rawSecret = value(env.EARSHOT_SESSION_TICKET_SECRET);
  if (mode === "production" && !rawSecret) {
    throw new SessionConfigError(
      "EARSHOT_SESSION_TICKET_SECRET is not set. It is required outside development: set the same secret on both Workers (openssl rand -base64 32).",
    );
  }
  const ticketSecret = rawSecret ?? DEV_SESSION_TICKET_SECRET;
  if (mode === "production" && isDevTicketSecret(ticketSecret)) {
    throw new SessionConfigError(
      "EARSHOT_SESSION_TICKET_SECRET is the development-only value; generate a new one (openssl rand -base64 32).",
    );
  }
  if (new TextEncoder().encode(ticketSecret).byteLength < MIN_TICKET_SECRET_BYTES) {
    throw new SessionConfigError(
      `EARSHOT_SESSION_TICKET_SECRET must be at least ${MIN_TICKET_SECRET_BYTES} bytes (openssl rand -base64 32).`,
    );
  }

  const rawEdge = value(env.EDGE_PUBLIC_URL);
  if (mode === "production" && !rawEdge) {
    throw new SessionConfigError(
      "EDGE_PUBLIC_URL is not set. It is required outside development: set it to the edge Worker's public origin.",
    );
  }
  const edgeOrigin = rawEdge
    ? parseEdgeOrigin(rawEdge, "EDGE_PUBLIC_URL", mode)
    : parseEdgeOrigin(value(env.EDGE_DEV_URL) ?? DEV_EDGE_URL, "EDGE_DEV_URL", mode);

  return { ticketSecret, edgeOrigin };
}

/**
 * An http(s) or ws(s) origin as a WebSocket origin. Browsers open `ws:` and `wss:` URLs on every
 * version Earshot supports, so the route hands the client one it can use as is.
 */
function parseEdgeOrigin(raw: string, name: string, mode: Mode): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SessionConfigError(
      `${name} must be an absolute URL, such as https://earshot-edge.example.workers.dev`,
    );
  }
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  if (!secure && url.protocol !== "http:" && url.protocol !== "ws:") {
    throw new SessionConfigError(`${name} must use https`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new SessionConfigError(`${name} must be an origin, with no path, query, or credentials`);
  }
  if (mode === "production" && !secure && !isLoopback(url.hostname)) {
    throw new SessionConfigError(`${name} must use https outside development (or be localhost)`);
  }
  return `${secure ? "wss" : "ws"}://${url.host}`;
}
