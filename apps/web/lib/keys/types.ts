// The JSON the key routes answer with, shared by the route handlers and the Settings → Keys page.
// Pure types: no server or browser imports.
import type { ProviderId, ValidateKeyReason, ValidationFailure } from "@earshot/keys";

/** A key in the server vault, as the routes describe it: metadata only, never the key. */
export type VaultCredential = {
  /** A provider id. Usually one of PROVIDER_IDS, unless a provider was dropped after storing. */
  provider: string;
  label: string;
  /** The key's last four characters, the only part of it ever shown. */
  last4: string;
  /** When the key last passed validation, as an ISO timestamp. */
  validatedAt: string | null;
  createdAt: string;
};

/** `GET /api/vault/credentials`. */
export type VaultListResponse = {
  /** True when this deployment has a vault master key, so keys can be stored. */
  vaultAvailable: boolean;
  credentials: VaultCredential[];
};

/** `PUT /api/vault/credentials`, 200: the key passed validation and is stored. */
export type VaultStoredResponse = { ok: true; credential: VaultCredential };

/** `PUT /api/vault/credentials`, 422: the provider didn't accept the key, so nothing was stored. */
export type VaultNotAcceptedResponse = {
  ok: false;
  provider: ProviderId;
  last4: string;
  reason: ValidationFailure;
};

/** `DELETE /api/vault/credentials`. `deleted` is false when the slot was already empty. */
export type VaultDeletedResponse = { ok: true; deleted: boolean };

/**
 * Why a key route refused a request. A fixed code, so nothing from the request (a key pasted into
 * the wrong field, say) is ever echoed back.
 */
export type KeyRouteError =
  | "unauthorized"
  | "forbidden"
  | "too_many_requests"
  | "reauth_required"
  | "vault_off"
  | "invalid_request"
  | "unknown_provider"
  | "invalid_label"
  | "missing_key"
  | "server_error";

/** The body of every refusal: a code, a fixed sentence, and for 429 how long to wait. */
export type KeyRouteErrorBody = {
  error: KeyRouteError;
  message: string;
  retryAfterSeconds?: number;
};

/**
 * Every reason a key check or store can fail, for the copy the page shows: the routes' codes,
 * plus `network` (Earshot didn't answer) and `storage` (this browser couldn't save the key).
 */
export type KeyProblem = ValidateKeyReason | KeyRouteError | "network" | "storage";
