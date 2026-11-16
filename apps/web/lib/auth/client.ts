"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { magicLinkClient } from "better-auth/client/plugins";

/** Better Auth's browser client. Same origin, so it calls /api/auth on this site. */
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), passkeyClient()],
});

type ClientError = { code?: string | undefined; message?: string | undefined; status?: number };

/** A sentence for the UI from a Better Auth client error. Never echoes tokens or links. */
export function describeAuthError(
  error: ClientError | null | undefined,
  fallback?: string,
): string {
  if (!error) return fallback ?? "Something went wrong. Try again.";
  if (error.status === 429) return "Too many attempts. Wait a minute, then try again.";
  switch (error.code) {
    case "AUTH_CANCELLED":
    case "REGISTRATION_CANCELLED":
    case "ERROR_CEREMONY_ABORTED":
      return "The passkey prompt was closed before it finished.";
    case "PREVIOUSLY_REGISTERED":
    case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
      return "This device already has a passkey for your account.";
    case "SESSION_EXPIRED":
    case "SESSION_NOT_FRESH":
      return "For your security, sign in again before doing this.";
    case "PASSKEY_NOT_FOUND":
      return "That passkey isn't registered with Earshot. Try email instead.";
    default:
      return error.message || fallback || "Something went wrong. Try again.";
  }
}
