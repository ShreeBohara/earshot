// Minting a speech-to-text provider's temporary credential from the user's own key (spec WP3
// step 3, docs/adr/0023). The browser then opens the provider's socket itself with that
// credential, which lives 30 to 60 seconds; the key goes no further than this one request.
import { type FetchLike, findSecretFragment, type ValidationFailure } from "@earshot/keys/server";
import { readJsonBody } from "../keys/http";
import type { MintProvider } from "./types";

export const MINT_PROVIDERS: readonly MintProvider[] = ["assemblyai", "deepgram"];

export function isMintProvider(value: string): value is MintProvider {
  return (MINT_PROVIDERS as readonly string[]).includes(value);
}

/** How long a provider gets to answer before the mint reports `unreachable`. */
export const MINT_TIMEOUT_MS = 10_000;
/** A mint answer is a few hundred bytes. A longer one is abandoned partway, as a failure. */
const MAX_MINT_RESPONSE_BYTES = 16 * 1024;
/** The longest credential passed on. JWTs and AssemblyAI's tokens are well under it. */
const MAX_CREDENTIAL_LENGTH = 4096;
/** Printable ASCII with no spaces: what fits in a subprotocol entry or a URL parameter. */
const CREDENTIAL = /^[\x21-\x7e]+$/;

type MintRequest = {
  /** The provider's token endpoint. */
  readonly url: string;
  /** How the provider takes the key: AssemblyAI bare, Deepgram as `Token <key>`. */
  readonly headers: (key: string) => Record<string, string>;
  readonly body: Readonly<Record<string, unknown>>;
  /** How long the credential is good for opening a socket, as requested. */
  readonly lifetimeSeconds: number;
  /** The credential, and the lifetime if the provider states one, from a successful answer. */
  readonly read: (answer: Record<string, unknown>) => { credential: unknown; lifetime: unknown };
  /** Where the browser connects with it (`VoiceTokenResponse.url`). */
  readonly socketBase: string;
};

/**
 * Each provider's mint request, in one place. WP1 confirms them against the live APIs.
 * AssemblyAI's API reference marks `product: "streaming"` as required for `POST /v1/token`
 * (another of its pages omits it), so the request always sends it.
 */
export const MINT_REQUESTS: Readonly<Record<MintProvider, MintRequest>> = {
  assemblyai: {
    url: "https://token.assemblyai.com/v1/token",
    headers: (key) => ({ authorization: key }),
    // The token opens sessions for 60 s (AssemblyAI allows 1–600), and each session it opens
    // lasts at most 30 minutes (60–10,800). One token can open several sessions inside its
    // window, so the window stays short.
    body: { product: "streaming", expires_in_seconds: 60, max_session_duration_seconds: 1800 },
    lifetimeSeconds: 60,
    read: (answer) => ({ credential: answer.token, lifetime: answer.expires_in_seconds }),
    socketBase: "wss://streaming.assemblyai.com",
  },
  deepgram: {
    url: "https://api.deepgram.com/v1/auth/grant",
    headers: (key) => ({ authorization: `Token ${key}` }),
    // Deepgram's default, 30 s (at most 3,600): the grant only has to be valid at the handshake.
    body: { ttl_seconds: 30 },
    lifetimeSeconds: 30,
    read: (answer) => ({ credential: answer.access_token, lifetime: answer.expires_in }),
    socketBase: "wss://api.deepgram.com",
  },
};

export type MintResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly credential: string;
      readonly expiresAt: Date;
      readonly url: string;
    }
  | { readonly ok: false; readonly status?: number; readonly code: ValidationFailure };

/**
 * Asks `provider` for a temporary credential with `key`. Failures come back as the key routes'
 * fixed codes: `rejected` (401 or 403), `rate_limited` (429), `upstream_error` (any other status,
 * or an answer without a usable credential), and `unreachable` (no answer within the timeout).
 * The provider's answer goes no further than this function: an error's body is released unread,
 * since some providers quote the key in their errors, and a success yields only the credential,
 * which is refused if it holds any eight characters of the key in a row.
 */
export async function mintCredential(
  provider: MintProvider,
  key: string,
  deps: { fetch: FetchLike; now: () => Date; timeoutMs?: number },
): Promise<MintResult> {
  const spec = MINT_REQUESTS[provider];
  const issuedAt = deps.now();
  let response: Response;
  try {
    response = await deps.fetch(spec.url, {
      method: "POST",
      headers: {
        ...spec.headers(key),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(spec.body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? MINT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "unreachable" };
  }

  const { status } = response;
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    if (status === 401 || status === 403) return { ok: false, status, code: "rejected" };
    if (status === 429) return { ok: false, status, code: "rate_limited" };
    return { ok: false, status, code: "upstream_error" };
  }

  const answer = await readJsonBody(response, MAX_MINT_RESPONSE_BYTES);
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    return { ok: false, status, code: "upstream_error" };
  }
  const { credential, lifetime } = spec.read(answer as Record<string, unknown>);
  if (
    typeof credential !== "string" ||
    credential.length > MAX_CREDENTIAL_LENGTH ||
    !CREDENTIAL.test(credential) ||
    findSecretFragment(credential, key, 8) !== undefined
  ) {
    return { ok: false, status, code: "upstream_error" };
  }
  // A provider that states a shorter life than requested wins; a longer one changes nothing.
  const stated =
    typeof lifetime === "number" && Number.isFinite(lifetime) && lifetime > 0
      ? Math.min(lifetime, spec.lifetimeSeconds)
      : spec.lifetimeSeconds;
  return {
    ok: true,
    status,
    credential,
    expiresAt: new Date(issuedAt.getTime() + stated * 1000),
    url: spec.socketBase,
  };
}
