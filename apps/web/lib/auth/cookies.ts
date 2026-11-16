// Cookie names only, with no Better Auth import, so proxy.ts stays tiny.

/** Better Auth's cookies are named `earshot.*` (`advanced.cookiePrefix`). */
export const COOKIE_PREFIX = "earshot";

/** Over https Better Auth adds the `__Secure-` prefix, so a session cookie has one of two names. */
export const SESSION_COOKIE_NAMES = [
  `${COOKIE_PREFIX}.session_token`,
  `__Secure-${COOKIE_PREFIX}.session_token`,
] as const;

/**
 * Whether the request carries a session cookie at all. Presence only: it says nothing about
 * whether the session is valid, so use it for optimistic redirects and to skip work for visitors
 * who are certainly signed out, never to grant access.
 */
export function hasSessionCookie(cookies: { has(name: string): boolean }): boolean {
  return SESSION_COOKIE_NAMES.some((name) => cookies.has(name));
}
