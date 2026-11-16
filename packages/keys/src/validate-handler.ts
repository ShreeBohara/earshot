// Key validation as a fetch-style handler: a Next route (or any server that speaks Request and
// Response) passes its request through. The key arrives only in the x-earshot-provider-key
// header, is checked with one cheap GET to its provider, and goes nowhere else: no database, no
// storage, no logs. The response carries the provider, the key's last four characters, and a
// fixed reason code, and never anything the provider sent back, because some providers quote
// part of the key in their error text.
import {
  type FetchLike,
  isProviderId,
  last4,
  type ProviderId,
  type ValidationFailure,
  validateKey,
} from "./providers";
import { type Logger, PROVIDER_KEY_HEADER, redact, redactValue } from "./redact";

/** Why a request didn't validate a key. A fixed code, so nothing from the request is echoed. */
export type ValidateKeyReason =
  | "method_not_allowed"
  | "invalid_request"
  | "unknown_provider"
  | "missing_key"
  | ValidationFailure;

/** The JSON body of every response. */
export interface ValidateKeyResponse {
  readonly ok: boolean;
  /** Present when the request named a known provider. */
  readonly provider?: ProviderId;
  /** Present once the provider was asked: the only part of a key ever returned. */
  readonly last4?: string;
  readonly reason?: ValidateKeyReason;
}

export interface ValidateKeyOptions {
  /** The global `fetch` by default; tests pass a fake. */
  readonly fetch?: FetchLike;
  /** Optional. Pass a redacting logger (`createRedactingLogger`); this request's key is scrubbed too. */
  readonly logger?: Logger;
  /** How long to wait for the provider before answering `unreachable`. 10 seconds by default. */
  readonly timeoutMs?: number;
}

/** `{ "provider": … }` needs a few dozen bytes; anything past this cap is refused unread. */
const MAX_BODY_BYTES = 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Validates the provider key in the `x-earshot-provider-key` header against the provider named
 * in the JSON body, `{ "provider": "openai" }`. A key in the body or the URL is never read.
 *
 * - 200 `{ ok: true, provider, last4 }` when the provider accepts the key.
 * - 200 `{ ok: false, provider, last4, reason }` when it doesn't: `rejected`, `rate_limited`,
 *   `upstream_error`, or `unreachable`.
 * - 400 `{ ok: false, reason }` for `invalid_request`, `unknown_provider`, or `missing_key`, and
 *   405 for any method but POST.
 *
 * Every response is `cache-control: no-store`. The caller adds authentication and rate limits.
 */
export async function handleValidateKey(
  request: Request,
  options: ValidateKeyOptions = {},
): Promise<Response> {
  const { fetch: fetchImpl = fetch, logger, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const secret = request.headers.get(PROVIDER_KEY_HEADER)?.trim() ?? "";
  // Log lines carry codes, never request data. Scrubbing this request's key as well is a
  // second line of defense in case a future change slips one in.
  const log = (level: keyof Logger, message: string, detail: Record<string, unknown>) =>
    logger?.[level](redact(message, [secret]), redactValue(detail, [secret]));

  if (request.method !== "POST") {
    log("info", "key validation refused", { reason: "method_not_allowed" });
    return reply(405, { ok: false, reason: "method_not_allowed" }, { allow: "POST" });
  }

  const body = await readProvider(request);
  if ("reason" in body) {
    log("info", "key validation refused", { reason: body.reason });
    return reply(400, { ok: false, reason: body.reason });
  }
  const { provider } = body;
  if (!secret) {
    log("info", "key validation refused", { provider, reason: "missing_key" });
    return reply(400, { ok: false, provider, reason: "missing_key" });
  }

  const result = await validateKey(provider, secret, withTimeout(fetchImpl, timeoutMs));
  if (result.ok) {
    log("info", "provider key accepted", { provider, status: result.status });
    return reply(200, { ok: true, provider, last4: last4(secret) });
  }
  log(result.code === "rejected" ? "info" : "warn", "provider key not accepted", {
    provider,
    reason: result.code,
    status: result.status,
  });
  return reply(200, { ok: false, provider, last4: last4(secret), reason: result.code });
}

/** Reads `{ provider }` from the body. Never returns the raw value: it could be a pasted key. */
async function readProvider(
  request: Request,
): Promise<{ provider: ProviderId } | { reason: "invalid_request" | "unknown_provider" }> {
  const text = await readBody(request, MAX_BODY_BYTES);
  if (text === null) return { reason: "invalid_request" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { reason: "invalid_request" };
  }
  const provider =
    typeof body === "object" && body !== null ? (body as { provider?: unknown }).provider : null;
  if (typeof provider !== "string") return { reason: "invalid_request" };
  return isProviderId(provider) ? { provider } : { reason: "unknown_provider" };
}

/**
 * The body as UTF-8 text, or null if it's missing, isn't UTF-8, or runs past `maxBytes`.
 *
 * Nothing oversized is ever buffered: Workers accept bodies up to 100 MB, and an isolate has
 * 128 MB of memory. A Content-Length that is over the cap, or malformed, is refused before
 * anything is read. Otherwise the stream is read a chunk at a time, counting bytes rather than
 * characters, and cancelled as soon as the count passes the cap.
 */
async function readBody(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(/^\d+$/.test(declared) && Number(declared) <= maxBytes)) {
    await request.body?.cancel().catch(() => {});
    return null;
  }
  if (!request.body) return null;

  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    const reader = request.body.getReader();
    let next = await reader.read();
    while (!next.done) {
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) {
        await reader.cancel().catch(() => {});
        return null;
      }
      length += chunk.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(chunk);
      next = await reader.read();
    }
  } catch {
    // The client went away mid-body, or something already read it.
    return null;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Gives up on the provider after `ms`; `validateKey` reports that as `unreachable`. */
function withTimeout(fetchImpl: FetchLike, ms: number): FetchLike {
  return (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) });
}

function reply(
  status: number,
  body: ValidateKeyResponse,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...headers, "cache-control": "no-store" } });
}
