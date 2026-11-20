// The audit signing key in the web Worker (docs/adr/0033): EARSHOT_AUDIT_SIGNING_KEY, the
// private JWK that signs checkpoints, and EARSHOT_AUDIT_RETIRED_KEYS, the public keys of keys
// rotated out. Read once per isolate and value. Like the ticket secret (lib/voice/config.ts),
// `next dev` falls back to the committed development key and anywhere else that key is refused;
// unlike it, a missing or bad key doesn't stop the app. It fails closed where a signature is
// needed (the review route answers 503 `audit_unavailable`, WP3) and /api/health says which.
// Nothing here returns or logs the key: log lines name the variable only.
import {
  AUDIT_RETIRED_KEYS_ENV,
  AuditKeyError,
  type AuditPublicKey,
  type AuditSigningState,
  auditPublicKeys,
  loadAuditSigningKey,
  parseRetiredAuditKeys,
} from "@earshot/keys/server";
import { MODE, type Mode } from "../auth/config";
import type { Logger } from "../log";

/** The variables this module reads. Both optional: `next dev` runs with neither. */
export type AuditEnv = {
  readonly EARSHOT_AUDIT_SIGNING_KEY?: string | undefined;
  readonly EARSHOT_AUDIT_RETIRED_KEYS?: string | undefined;
};

export type AuditKeys = {
  /** What signing can do here: `configured` or `development` can sign; the rest fail closed. */
  readonly signing: AuditSigningState;
  /** Every public key a verifier needs, or why the list can't be served (it's never partial). */
  readonly publicKeys:
    | { readonly ok: true; readonly keys: readonly AuditPublicKey[] }
    | { readonly ok: false; readonly message: string };
};

const loaded = new Map<string, Promise<AuditKeys>>();

async function load(env: AuditEnv, mode: Mode, log: Logger): Promise<AuditKeys> {
  const signing = await loadAuditSigningKey(env, { development: mode === "development" });
  if (signing.status === "invalid") {
    log.error(`audit signing unavailable: ${signing.message}`);
  } else if (signing.status === "missing") {
    log.warn(
      "audit signing unavailable: EARSHOT_AUDIT_SIGNING_KEY isn't set, so writes that need a checkpoint fail closed",
    );
  }
  try {
    const keys = auditPublicKeys(signing, parseRetiredAuditKeys(env.EARSHOT_AUDIT_RETIRED_KEYS));
    return { signing, publicKeys: { ok: true, keys } };
  } catch (error) {
    const message =
      error instanceof AuditKeyError ? error.message : `${AUDIT_RETIRED_KEYS_ENV} isn't usable.`;
    log.error(`audit public keys unavailable: ${message}`);
    return { signing, publicKeys: { ok: false, message } };
  }
}

/**
 * This environment's audit keys, loaded once per isolate for each value of the two variables (so
 * a changed secret takes effect on the next request) and logged once if something is wrong.
 */
export function readAuditKeys(
  env: AuditEnv,
  { mode = MODE, log }: { readonly mode?: Mode; readonly log: Logger },
): Promise<AuditKeys> {
  const cacheKey = JSON.stringify([
    mode,
    env.EARSHOT_AUDIT_SIGNING_KEY ?? "",
    env.EARSHOT_AUDIT_RETIRED_KEYS ?? "",
  ]);
  let keys = loaded.get(cacheKey);
  if (!keys) {
    keys = load(env, mode, log);
    loaded.set(cacheKey, keys);
    keys.catch(() => loaded.delete(cacheKey));
  }
  return keys;
}

/** `GET /api/audit/keys`'s answer: `{ keys }`, public and cacheable; or 500 if the list is wrong. */
export function auditKeysResponse(keys: AuditKeys): Response {
  if (!keys.publicKeys.ok) {
    return Response.json(
      { error: "server_error", message: "The audit keys aren't configured correctly." },
      {
        status: 500,
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      },
    );
  }
  return Response.json(
    { keys: keys.publicKeys.keys },
    {
      headers: {
        // Public keys change only when one is rotated, and a verifier that missed the newest key
        // for a few minutes only has to ask again.
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
