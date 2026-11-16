// The browser's side of the key routes. A key goes out only in the x-earshot-provider-key header
// of the one request that needs it, never in a body or a URL, and these functions never keep it:
// callers pass it in and drop it as soon as the promise settles.
import { PROVIDER_KEY_HEADER, type ProviderId, type ValidateKeyResponse } from "@earshot/keys";
import type {
  KeyProblem,
  KeyRouteErrorBody,
  VaultCredential,
  VaultDeletedResponse,
  VaultNotAcceptedResponse,
  VaultStoredResponse,
} from "./types";

export type Failure = { ok: false; problem: KeyProblem; retryAfterSeconds?: number };
export type CheckResult = { ok: true; last4: string } | Failure;
export type StoreResult = { ok: true; credential: VaultCredential } | Failure;
export type RemoveResult = { ok: true; deleted: boolean } | Failure;

async function send(url: string, init: RequestInit): Promise<Response | Failure> {
  try {
    return await fetch(url, { ...init, credentials: "same-origin", cache: "no-store" });
  } catch {
    return { ok: false, problem: "network" };
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A refusal from the routes (`{ error, message }`), or a generic failure for anything else. */
function failure(body: Record<string, unknown> | null): Failure {
  const refusal = body as Partial<KeyRouteErrorBody> | null;
  if (typeof refusal?.error === "string") {
    return {
      ok: false,
      problem: refusal.error,
      ...(typeof refusal.retryAfterSeconds === "number"
        ? { retryAfterSeconds: refusal.retryAfterSeconds }
        : {}),
    };
  }
  return { ok: false, problem: "server_error" };
}

/** Asks Earshot to check a key with its provider. Nothing is stored anywhere. */
export async function checkKey(provider: ProviderId, key: string): Promise<CheckResult> {
  const response = await send("/api/keys/validate", {
    method: "POST",
    headers: { "content-type": "application/json", [PROVIDER_KEY_HEADER]: key },
    body: JSON.stringify({ provider }),
  });
  if (!(response instanceof Response)) return response;
  const body = await readJson(response);
  // The validation handler answers `{ ok, … }`; the route's own refusals (401, 403, 429) don't.
  const result = body as Partial<ValidateKeyResponse> | null;
  if (typeof result?.ok === "boolean") {
    if (result.ok) return { ok: true, last4: result.last4 ?? "" };
    return { ok: false, problem: result.reason ?? "server_error" };
  }
  return failure(body);
}

/** Stores a key in the server vault after Earshot checks it with the provider. */
export async function storeInVault(
  provider: ProviderId,
  label: string,
  key: string,
): Promise<StoreResult> {
  const response = await send("/api/vault/credentials", {
    method: "PUT",
    headers: { "content-type": "application/json", [PROVIDER_KEY_HEADER]: key },
    body: JSON.stringify({ provider, label }),
  });
  if (!(response instanceof Response)) return response;
  const body = await readJson(response);
  if (response.ok) return body as VaultStoredResponse;
  if (response.status === 422) {
    return { ok: false, problem: (body as VaultNotAcceptedResponse | null)?.reason ?? "rejected" };
  }
  return failure(body);
}

/** Removes a key from the server vault. */
export async function removeFromVault(provider: string, label: string): Promise<RemoveResult> {
  const response = await send("/api/vault/credentials", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, label }),
  });
  if (!(response instanceof Response)) return response;
  const body = await readJson(response);
  if (response.ok) return body as VaultDeletedResponse;
  return failure(body);
}
