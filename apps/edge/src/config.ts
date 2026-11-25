// The edge Worker's configuration, read from its environment (env.d.ts). Pure: no Cloudflare
// imports, so tests pass whatever environment they need. As in the web app (docs/adr/0023), a
// development deploy has a default for everything, and anywhere else a missing or unsafe value
// fails closed: the socket route answers 500 and the log names the variable, never the value.
//
// The audit signing key (Phase 5 WP3, docs/adr/0033) fails closed more narrowly: without a usable
// EARSHOT_AUDIT_SIGNING_KEY the socket still works, but SessionDO refuses `review` with `internal`
// and the flush consumer won't store review events, since their audit rows need a signed
// checkpoint. Development signs with the committed development key, as `loadAuditSigningKey`
// allows only there.
import {
  DEV_SESSION_TICKET_SECRET,
  importTicketKey,
  isDevTicketSecret,
  MIN_TICKET_SECRET_BYTES,
} from "@earshot/core";
import {
  type AuditSigner,
  type AuditSigningState,
  auditKeySecretValues,
  loadAuditSigningKey,
} from "@earshot/keys/server";

/** The variables this module reads. All optional here; `readEdgeConfig` decides what's required. */
export type EdgeEnv = {
  readonly DEPLOY_ENV?: string | undefined;
  readonly WEB_ORIGIN?: string | undefined;
  readonly EARSHOT_SESSION_TICKET_SECRET?: string | undefined;
  readonly EARSHOT_AUDIT_SIGNING_KEY?: string | undefined;
};

/** A configuration problem. The message names the variable and the fix, never a value. */
export class EdgeConfigError extends Error {
  override readonly name = "EdgeConfigError";
}

export type EdgeConfig = {
  /** True only for `DEPLOY_ENV=development`: the template's value, used by `wrangler dev` and tests. */
  readonly development: boolean;
  /** Verifies session tickets: the same value the web app signs with. */
  readonly ticketKey: CryptoKey;
  /** The trimmed secret itself, so the logger can redact it exactly. */
  readonly ticketSecret: string;
  /** Browser origins allowed to open a session socket, normalized (`https://host[:port]`). */
  readonly webOrigins: ReadonlySet<string>;
};

/** True when the Worker runs as the development template (`wrangler dev`, tests). */
export function isDevelopment(env: EdgeEnv): boolean {
  return env.DEPLOY_ENV?.trim() === "development";
}

/**
 * The ticket secret: `EARSHOT_SESSION_TICKET_SECRET`, trimmed as the web app trims it, or in
 * development only the shared development secret from `@earshot/core`, so a fresh clone works
 * with no `.dev.vars`. Outside development it's required, must be at least 32 bytes, and must not
 * be the development secret.
 */
export function readTicketSecret(env: EdgeEnv): string {
  const development = isDevelopment(env);
  const raw = env.EARSHOT_SESSION_TICKET_SECRET?.trim() || undefined;
  if (!raw && !development) {
    throw new EdgeConfigError(
      "EARSHOT_SESSION_TICKET_SECRET is not set. It is required outside development: set the same secret on both Workers (openssl rand -base64 32).",
    );
  }
  const secret = raw ?? DEV_SESSION_TICKET_SECRET;
  if (!development && isDevTicketSecret(secret)) {
    throw new EdgeConfigError(
      "EARSHOT_SESSION_TICKET_SECRET is the development-only value, which anyone can sign tickets with; generate a new one (openssl rand -base64 32).",
    );
  }
  if (new TextEncoder().encode(secret).byteLength < MIN_TICKET_SECRET_BYTES) {
    throw new EdgeConfigError(
      `EARSHOT_SESSION_TICKET_SECRET must be at least ${MIN_TICKET_SECRET_BYTES} bytes (openssl rand -base64 32).`,
    );
  }
  return secret;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The `Origin` allow-list: `WEB_ORIGIN`, one origin or several separated by commas. Each must be
 * a bare origin (no path, query, or credentials). Outside development each must use https,
 * unless it's localhost. Required everywhere: the template sets `http://localhost:3000`.
 */
export function readWebOrigins(env: EdgeEnv): ReadonlySet<string> {
  const development = isDevelopment(env);
  const entries = (env.WEB_ORIGIN ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) {
    throw new EdgeConfigError(
      "WEB_ORIGIN is not set: set it to the web app's origin, such as https://earshot-web.example.workers.dev.",
    );
  }
  const origins = new Set<string>();
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new EdgeConfigError(
        "WEB_ORIGIN must list absolute origins, such as https://app.example",
      );
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new EdgeConfigError("WEB_ORIGIN must list http(s) origins");
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new EdgeConfigError(
        "WEB_ORIGIN must list origins, with no path, query, or credentials",
      );
    }
    if (!development && url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new EdgeConfigError("WEB_ORIGIN must use https outside development (or be localhost)");
    }
    origins.add(url.origin);
  }
  return origins;
}

// One imported key per secret, per isolate: importing on every handshake would work, but costs a
// WebCrypto call each time.
const keys = new Map<string, Promise<CryptoKey>>();

function ticketKeyFor(ticketSecret: string): Promise<CryptoKey> {
  let key = keys.get(ticketSecret);
  if (!key) {
    key = importTicketKey(ticketSecret);
    keys.set(ticketSecret, key);
    key.catch(() => keys.delete(ticketSecret));
  }
  return key;
}

/** Reads and checks everything the socket route needs. Throws `EdgeConfigError`. */
export async function readEdgeConfig(env: EdgeEnv): Promise<EdgeConfig> {
  const ticketSecret = readTicketSecret(env);
  const webOrigins = readWebOrigins(env);
  const ticketKey = await ticketKeyFor(ticketSecret);
  return { development: isDevelopment(env), ticketKey, ticketSecret, webOrigins };
}

/**
 * The ticket secret as an HMAC key, imported once per isolate: what SessionDO verifies a policy
 * snapshot's signature with (Phase 5 WP11), since the web app signs snapshots with the ticket
 * secret too. Throws `EdgeConfigError` as `readTicketSecret` does.
 */
export function readTicketKey(env: EdgeEnv): Promise<CryptoKey> {
  return ticketKeyFor(readTicketSecret(env));
}

/** True if `origin` (the request's `Origin` header) is on the allow-list. Exact match only. */
export function isAllowedOrigin(origin: string | null, allowed: ReadonlySet<string>): boolean {
  if (!origin) return false;
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }
  // `new URL("null").origin` throws, and an opaque origin normalizes to "null": refuse both.
  return normalized !== "null" && normalized === origin && allowed.has(normalized);
}

// One loaded signing state per isolate and value, like the ticket keys: importing checks the key
// with a signature, which needn't run on every message.
const auditStates = new Map<string, Promise<AuditSigningState>>();

/**
 * The audit signing key's state here (`loadAuditSigningKey`): `configured` or `development` can
 * sign; `missing` and `invalid` fail closed. `development` is `DEPLOY_ENV=development`, as for the
 * ticket secret. Never throws, and never returns or logs the key.
 */
export function readAuditSigning(env: EdgeEnv): Promise<AuditSigningState> {
  const development = isDevelopment(env);
  const cacheKey = JSON.stringify([development, env.EARSHOT_AUDIT_SIGNING_KEY ?? ""]);
  let state = auditStates.get(cacheKey);
  if (!state) {
    state = loadAuditSigningKey(env, { development });
    auditStates.set(cacheKey, state);
    state.catch(() => auditStates.delete(cacheKey));
  }
  return state;
}

/** The signer, when the key is usable; null when reviews must fail closed. */
export async function readAuditSigner(env: EdgeEnv): Promise<AuditSigner | null> {
  const state = await readAuditSigning(env);
  return state.status === "configured" || state.status === "development" ? state.signer : null;
}

/** What a redacting logger must mask for the signing key: the value whole, and its `d`. */
export function auditSecrets(env: EdgeEnv): string[] {
  return auditKeySecretValues(env.EARSHOT_AUDIT_SIGNING_KEY);
}
