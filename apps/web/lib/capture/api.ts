// The browser's side of WP3's session and token routes. A provider key goes out only in the
// x-earshot-provider-key header of the one mint request that needs it, and nothing here keeps it.
import type { SessionProviders } from "@earshot/core";
import { PROVIDER_ID_HEADER, PROVIDER_KEY_HEADER } from "@earshot/keys";
import { type TempCredential, VoiceError } from "@earshot/voice";
import type {
  CreateSessionResponse,
  MintProvider,
  VoiceRouteError,
  VoiceRouteErrorBody,
} from "../voice/types";

export type SessionFailure = {
  readonly ok: false;
  readonly error: VoiceRouteError | "network";
  readonly retryAfterSeconds?: number;
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function refusal(body: unknown): Partial<VoiceRouteErrorBody> {
  return typeof body === "object" && body !== null ? (body as Partial<VoiceRouteErrorBody>) : {};
}

/** `POST /api/sessions`: creates the session row and its first ticket. */
export async function createSession(
  fetchImpl: typeof fetch,
  providers: SessionProviders,
): Promise<({ readonly ok: true } & CreateSessionResponse) | SessionFailure> {
  let response: Response;
  try {
    response = await fetchImpl("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "debrief", engine: "cascaded", providers }),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "network" };
  }
  const body = await readJson(response);
  if (response.status === 201 && body && typeof body === "object") {
    return { ok: true, ...(body as CreateSessionResponse) };
  }
  const { error, retryAfterSeconds } = refusal(body);
  return {
    ok: false,
    error: typeof error === "string" ? error : "server_error",
    ...(typeof retryAfterSeconds === "number" ? { retryAfterSeconds } : {}),
  };
}

/**
 * `POST /api/voice/token`: one temporary credential for one speech socket, minted from the
 * device's key. Failures throw a `VoiceError` whose code tells the engine whether to retry.
 */
export async function mintCredential(
  fetchImpl: typeof fetch,
  input: {
    readonly sessionId: string;
    readonly provider: MintProvider;
    readonly key: string;
    readonly signal: AbortSignal;
  },
): Promise<TempCredential> {
  let response: Response;
  try {
    response = await fetchImpl("/api/voice/token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PROVIDER_ID_HEADER]: input.provider,
        [PROVIDER_KEY_HEADER]: input.key,
      },
      body: JSON.stringify({ sessionId: input.sessionId }),
      credentials: "same-origin",
      cache: "no-store",
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    throw new VoiceError("credential_failed", "the token route couldn't be reached", {
      retryable: true,
    });
  }
  const body = await readJson(response);
  if (response.ok && body && typeof body === "object") return body as TempCredential;
  const { error } = refusal(body);
  if (error === "rejected" || error === "missing_key") {
    throw new VoiceError("provider_rejected", "the provider refused the key");
  }
  if (response.status === 429 || error === "rate_limited") {
    throw new VoiceError("rate_limited", "minting is rate limited", { retryable: true });
  }
  const retryable = response.status >= 500 || response.status === 408;
  throw new VoiceError("credential_failed", `the token route answered ${response.status}`, {
    retryable,
  });
}
