// The key routes' logic, with every dependency passed in: app/api/keys/validate and
// app/api/vault/credentials wire it to the request (lib/keys/deps.ts), and tests pass their own
// database, environment, logger, provider fetch, and clock. Callers have already checked the
// session (withViewer), so every function here receives the signed-in viewer.
//
// The rules (docs/adr/0021):
// - A key arrives only in the x-earshot-provider-key header, never in a body or a URL, and no
//   response or log line carries it: responses hold fixed codes and the key's last four
//   characters, and logs hold codes.
// - Checking a key with its provider costs one request against two rate limits, per user and per
//   client IP, so a signed-in account can't become an oracle for testing stolen keys in bulk.
// - The server stores an AI key only when the vault is on and the user stores that key in it,
//   from a sign-in less than an hour old, after the provider accepted it.
import {
  type CredentialMeta,
  deleteCredential,
  listCredentials,
  putCredential,
  type TenantContext,
  VaultOffError,
  withTenant,
} from "@earshot/db";
import {
  type FetchLike,
  handleValidateKey,
  isProviderId,
  last4,
  PROVIDER_KEY_HEADER,
  type ProviderId,
  type ValidationResult,
  validateKey,
} from "@earshot/keys/server";
import { isFreshSession } from "../auth/fresh";
import { consumeRateLimit, type RateLimitRule } from "../auth/throttle";
import type { Viewer } from "../auth/viewer-core";
import type { AppDb } from "../db/types";
import type { Logger } from "../log";
import { clientIp, noStoreJson, readJsonBody, refusal, refuseCrossSite, serverError } from "./http";
import { cleanKeyLabel, DEFAULT_KEY_LABEL, MAX_KEY_LABEL_LENGTH } from "./labels";
import type {
  VaultCredential,
  VaultDeletedResponse,
  VaultListResponse,
  VaultNotAcceptedResponse,
  VaultStoredResponse,
} from "./types";
import { readVault, type VaultEnv, type VaultState } from "./vault";

export type KeyRouteDeps = {
  /** The owner connection: rate-limit counters, and `withTenant` for vault rows. */
  db: AppDb;
  /** Where EARSHOT_VAULT_MASTER_KEY comes from: the Worker's environment. */
  env: VaultEnv;
  /** A redacting logger (lib/log.ts). */
  log: Logger;
  /** Reaches the providers; the global `fetch` in the app. */
  fetch: FetchLike;
  now: () => Date;
  /** On in production, off under `next dev`, like Better Auth's limits (docs/adr/0006). */
  rateLimit: boolean;
};

/**
 * Key checks (validation, and the check before storing in the vault) per 10 minutes. Generous for
 * someone setting up their own keys; useless for testing a list of stolen ones.
 */
export const KEY_CHECK_LIMITS = {
  perUser: { max: 10, windowMs: 10 * 60 * 1000 },
  perIp: { max: 30, windowMs: 10 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

/** How long a provider gets to answer before the check reports `unreachable`. */
const PROVIDER_TIMEOUT_MS = 10_000;
/** `{ "provider": …, "label": … }` needs well under this. */
const MAX_BODY_BYTES = 1024;
/** The vault's own limit (packages/db/src/vault.ts). */
const MAX_KEY_LENGTH = 4096;

const tenantOf = (viewer: Viewer): TenantContext => ({
  userId: viewer.user.id,
  workspaceId: viewer.workspaceId,
});

/** `POST /api/keys/validate`: checks a key with its provider, stores nothing. */
export async function validateKeyRoute(
  viewer: Viewer,
  request: Request,
  deps: KeyRouteDeps,
): Promise<Response> {
  try {
    const refused = refuseCrossSite(request) ?? (await checkKeyLimits(viewer, request, deps));
    if (refused) return refused;
    // The handler reads the key from the header only, answers with fixed codes and the last
    // four characters, and scrubs this request's key from anything it logs.
    return await handleValidateKey(request, {
      fetch: deps.fetch,
      logger: deps.log,
      timeoutMs: PROVIDER_TIMEOUT_MS,
    });
  } catch (error) {
    deps.log.error("key check failed", { error });
    return serverError();
  }
}

/**
 * The vault's state and the workspace's stored keys, as metadata, for rendering Settings → Keys.
 * Unlike `GET`, it lists keys even when the master key is malformed, so they can be removed.
 */
export async function vaultSnapshot(
  viewer: Viewer,
  deps: Pick<KeyRouteDeps, "db" | "env" | "log">,
): Promise<{ status: VaultState["status"]; credentials: VaultCredential[] }> {
  const vault = await readVault(deps.env, deps.log);
  // Listing needs no master key, so keys stored before the vault went off can still be removed.
  const rows = await withTenant(deps.db, tenantOf(viewer), (tx) => listCredentials(tx));
  return { status: vault.status, credentials: rows.map(describeCredential) };
}

/** `GET /api/vault/credentials`. */
export async function listVaultRoute(
  viewer: Viewer,
  request: Request,
  deps: KeyRouteDeps,
): Promise<Response> {
  try {
    const refused = refuseCrossSite(request);
    if (refused) return refused;
    const vault = await readVault(deps.env, deps.log);
    if (vault.status === "misconfigured") return serverError();
    const rows = await withTenant(deps.db, tenantOf(viewer), (tx) => listCredentials(tx));
    const body: VaultListResponse = {
      vaultAvailable: vault.status === "on",
      credentials: rows.map(describeCredential),
    };
    return noStoreJson(200, body);
  } catch (error) {
    return vaultFailure(error, deps.log, "list");
  }
}

/**
 * `PUT /api/vault/credentials`: stores a key in the vault, replacing any key in the same slot.
 * The provider and label come from the JSON body and the key from the header. In order: the
 * vault must be on (409 `vault_off` otherwise, before any other work), the sign-in fresh (403
 * `reauth_required`), the request well-formed (400), the rate limits not reached (429), and the
 * provider must accept the key (422 with its reason). Only then is it sealed and stored.
 */
export async function putVaultRoute(
  viewer: Viewer,
  request: Request,
  deps: KeyRouteDeps,
): Promise<Response> {
  try {
    const refused = refuseCrossSite(request);
    if (refused) return refused;
    const vault = await readVault(deps.env, deps.log);
    if (vault.status === "misconfigured") return serverError();
    if (vault.status === "off") return vaultOff();
    if (!isFreshSession(viewer.session, deps.now())) {
      return refusal(
        403,
        "reauth_required",
        "Storing a key on the server needs a sign-in from the last hour. Sign in again, then retry.",
      );
    }

    const secret = request.headers.get(PROVIDER_KEY_HEADER)?.trim() ?? "";
    const slot = await readSlot(request, secret);
    if (slot instanceof Response) return slot;
    if (!secret) {
      return refusal(400, "missing_key", "Send the key in the x-earshot-provider-key header.");
    }
    if (secret.length > MAX_KEY_LENGTH) {
      return refusal(400, "invalid_request", "That key is longer than any provider's.");
    }

    const limited = await checkKeyLimits(viewer, request, deps);
    if (limited) return limited;
    const check = await checkWithProvider(slot.provider, secret, deps);
    if (!check.ok) {
      const body: VaultNotAcceptedResponse = {
        ok: false,
        provider: slot.provider,
        last4: last4(secret),
        reason: check.code,
      };
      return noStoreJson(422, body);
    }

    const stored = await withTenant(deps.db, tenantOf(viewer), (tx) =>
      putCredential(tx, vault.master, { ...slot, secret, validatedAt: deps.now() }),
    );
    deps.log.info("vault key stored", { provider: slot.provider });
    const body: VaultStoredResponse = { ok: true, credential: describeCredential(stored) };
    return noStoreJson(200, body);
  } catch (error) {
    return vaultFailure(error, deps.log, "store");
  }
}

/**
 * `DELETE /api/vault/credentials`: empties a slot, named by the JSON body's provider and label.
 * Works while the vault is off, so keys stored earlier can always be removed.
 */
export async function deleteVaultRoute(
  viewer: Viewer,
  request: Request,
  deps: KeyRouteDeps,
): Promise<Response> {
  try {
    const refused = refuseCrossSite(request);
    if (refused) return refused;
    const slot = await readSlot(request);
    if (slot instanceof Response) return slot;
    const deleted = await withTenant(deps.db, tenantOf(viewer), (tx) => deleteCredential(tx, slot));
    if (deleted) deps.log.info("vault key removed", { provider: slot.provider });
    const body: VaultDeletedResponse = { ok: true, deleted };
    return noStoreJson(200, body);
  } catch (error) {
    return vaultFailure(error, deps.log, "remove");
  }
}

/**
 * Counts this check against the per-user and per-IP limits. Answers 429, with Retry-After, once
 * either is reached. Off under `next dev`.
 */
async function checkKeyLimits(
  viewer: Viewer,
  request: Request,
  deps: KeyRouteDeps,
): Promise<Response | null> {
  if (!deps.rateLimit) return null;
  const now = deps.now().getTime();
  const buckets: Array<{ scope: "user" | "ip"; key: string; rule: RateLimitRule }> = [
    { scope: "user", key: `key-check|user:${viewer.user.id}`, rule: KEY_CHECK_LIMITS.perUser },
  ];
  const ip = clientIp(request);
  if (ip) buckets.push({ scope: "ip", key: `key-check|ip:${ip}`, rule: KEY_CHECK_LIMITS.perIp });

  for (const { scope, key, rule } of buckets) {
    const decision = await consumeRateLimit(deps.db, key, rule, now);
    if (decision.allowed) continue;
    deps.log.warn("key check refused: too many requests", { scope });
    const minutes = Math.ceil(decision.retryAfterSeconds / 60);
    return refusal(
      429,
      "too_many_requests",
      `Too many key checks. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      { retryAfterSeconds: decision.retryAfterSeconds },
      { "retry-after": String(decision.retryAfterSeconds) },
    );
  }
  return null;
}

/** One authenticated GET to the provider, the same check `POST /api/keys/validate` runs. */
async function checkWithProvider(
  provider: ProviderId,
  secret: string,
  deps: KeyRouteDeps,
): Promise<ValidationResult> {
  const result = await validateKey(provider, secret, (url, init) =>
    deps.fetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) }),
  );
  if (result.ok) {
    deps.log.info("provider key accepted", { provider, status: result.status });
  } else {
    deps.log[result.code === "rejected" ? "info" : "warn"]("provider key not accepted", {
      provider,
      reason: result.code,
      status: result.status,
    });
  }
  return result;
}

/**
 * The slot named in the JSON body, `{ provider, label? }`, or the 400 to answer. The label
 * defaults to `default`, and can't hold `secret` or anything shaped like a key. Nothing from the
 * body is ever quoted back, and any other field in it, a key included, is ignored.
 */
async function readSlot(
  request: Request,
  secret?: string,
): Promise<{ provider: ProviderId; label: string } | Response> {
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refusal(400, "invalid_request", "Send a JSON body with the provider and label.");
  }
  const { provider, label = DEFAULT_KEY_LABEL } = body as { provider?: unknown; label?: unknown };
  if (typeof provider !== "string") {
    return refusal(400, "invalid_request", "Send a JSON body with the provider and label.");
  }
  if (!isProviderId(provider)) {
    return refusal(400, "unknown_provider", "Pick one of the providers Earshot supports.");
  }
  const clean = typeof label === "string" ? cleanKeyLabel(label, secret) : null;
  if (!clean) {
    return refusal(
      400,
      "invalid_label",
      `A label must be 1 to ${MAX_KEY_LABEL_LENGTH} printable characters, and can't contain a key.`,
    );
  }
  return { provider, label: clean };
}

function vaultOff(): Response {
  return refusal(
    409,
    "vault_off",
    "The vault is off on this server, so keys can't be stored there. Keep them on your device.",
  );
}

/**
 * The vault's errors, mapped: VaultOffError to 409, TypeError (input the vault refused) to 400,
 * and anything else, VaultOpenError included, to a 500 that says nothing. The log gets the
 * error's name and code only (lib/log.ts), never its message.
 */
function vaultFailure(error: unknown, log: Logger, action: string): Response {
  if (error instanceof VaultOffError) return vaultOff();
  if (error instanceof TypeError) {
    log.warn(`vault ${action} refused`, { error });
    return refusal(400, "invalid_request", "That request isn't valid.");
  }
  log.error(`vault ${action} failed`, { error });
  return serverError();
}

function describeCredential(row: CredentialMeta): VaultCredential {
  return {
    provider: row.provider,
    label: row.label,
    last4: row.last4,
    validatedAt: row.validatedAt ? new Date(row.validatedAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
