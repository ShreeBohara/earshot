// Refusals for the session and voice-token routes, on the key routes' helpers (lib/keys/http.ts):
// every response is `cache-control: no-store`, and none quotes anything from the request.
import { isCrossSite, noStoreJson } from "../keys/http";
import type { VoiceRouteError, VoiceRouteErrorBody } from "./types";

export { clientIp, noStoreJson, readJsonBody } from "../keys/http";

/** A refusal: a fixed code and a fixed sentence. */
export function refusal(
  status: number,
  error: VoiceRouteError,
  message: string,
  extra: Pick<VoiceRouteErrorBody, "retryAfterSeconds"> = {},
  headers: Record<string, string> = {},
): Response {
  const body: VoiceRouteErrorBody = { error, message, ...extra };
  return noStoreJson(status, body, headers);
}

/** 500 with nothing about what failed. The log has the error's name and code. */
export function serverError(): Response {
  return refusal(500, "server_error", "Something went wrong on our side. Try again later.");
}

/** 403 for a request another site's page made, by the key routes' rule (`isCrossSite`). */
export function refuseCrossSite(request: Request): Response | null {
  return isCrossSite(request)
    ? refusal(403, "forbidden", "Start and run sessions from Earshot's own pages.")
    : null;
}
