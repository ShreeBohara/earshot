// Small HTTP helpers for the key routes. Every response they build is `cache-control: no-store`,
// and none quotes anything from the request.
import type { KeyRouteError, KeyRouteErrorBody } from "./types";

/** JSON with `cache-control: no-store`, the only kind of response the key routes send. */
export function noStoreJson(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { ...headers, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

/** A refusal: a fixed code and a fixed sentence. */
export function refusal(
  status: number,
  error: KeyRouteError,
  message: string,
  extra: Pick<KeyRouteErrorBody, "retryAfterSeconds"> = {},
  headers: Record<string, string> = {},
): Response {
  const body: KeyRouteErrorBody = { error, message, ...extra };
  return noStoreJson(status, body, headers);
}

/** 500 with nothing about what failed. The log has the error's name and code. */
export function serverError(): Response {
  return refusal(500, "server_error", "Something went wrong on our side. Try again later.");
}

/**
 * Whether another site's page made the request. Earshot's own pages call its API routes from the
 * same origin; a cross-site page could only make the browser send a request whose answer it can't
 * read, so there's no legitimate cross-site caller. Requests without the header (other clients,
 * older browsers) still need the session cookie, which is SameSite=Lax.
 */
export function isCrossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

/** Refuses requests that another site's page made (`isCrossSite`). */
export function refuseCrossSite(request: Request): Response | null {
  if (isCrossSite(request)) {
    return refusal(403, "forbidden", "Manage your keys from Earshot's settings page.");
  }
  return null;
}

/**
 * The client's IP address, from `cf-connecting-ip`, which Cloudflare sets and clients can't forge
 * (unlike X-Forwarded-For). Null when it's absent, as under `next dev`, or doesn't look like an
 * address.
 */
export function clientIp(request: Request): string | null {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  return ip && /^[0-9A-Fa-f:.]{2,45}$/.test(ip) ? ip : null;
}

/**
 * The body as parsed JSON, or undefined if it's missing, runs past `maxBytes`, isn't UTF-8, or
 * isn't JSON. Nothing oversized is buffered: a Content-Length over the cap is refused unread, and
 * otherwise the stream is read a chunk at a time and abandoned as soon as it passes the cap.
 * Works on a request, or on a provider's response.
 */
export async function readJsonBody(
  request: Pick<Request, "headers" | "body">,
  maxBytes: number,
): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(/^\d+$/.test(declared) && Number(declared) <= maxBytes)) {
    await request.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!request.body) return undefined;

  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    const reader = request.body.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      length += chunk.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(chunk);
    }
  } catch {
    return undefined;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}
