// How each sign-in session began (docs/adr/0033, spec decision 16). Better Auth's session row
// gains `sign_in_method` (migration 0013), set once when the session is created, so every review
// can say how its reviewer signed in, whether it comes from the inbox or, through a session
// ticket, from the socket. Better Auth's last-login-method plugin records the user's latest
// method, not each session's, so it doesn't fit.
import type { SignInMethod } from "@earshot/core";

/** Which endpoint is creating the session: Better Auth's endpoint context, or null outside one. */
export type SignInEndpoint = {
  /** The endpoint's route, such as `/callback/:id`, not the request's path. */
  readonly path?: unknown;
  readonly params?: unknown;
  readonly body?: unknown;
};

const SOCIAL: ReadonlySet<string> = new Set(["github", "google"]);

function socialMethod(id: unknown): SignInMethod {
  return typeof id === "string" && SOCIAL.has(id) ? (id as "github" | "google") : "unknown";
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The method for a session that `endpoint` is creating:
 *
 * - `/magic-link/verify`, opening the emailed link: `magic_link`;
 * - `/passkey/verify-authentication`: `passkey`;
 * - `/callback/:id`, the OAuth redirect back from GitHub or Google: the route's `id`;
 * - `/sign-in/social` with an ID token, which signs in without a redirect: the body's `provider`;
 * - anything else (no endpoint at all, or one that rotates a session): `unknown`.
 */
export function signInMethodFor(endpoint: SignInEndpoint | null | undefined): SignInMethod {
  switch (endpoint?.path) {
    case "/magic-link/verify":
      return "magic_link";
    case "/passkey/verify-authentication":
      return "passkey";
    case "/callback/:id":
      return socialMethod(field(endpoint.params, "id"));
    case "/sign-in/social":
      return socialMethod(field(endpoint.body, "provider"));
    default:
      return "unknown";
  }
}
