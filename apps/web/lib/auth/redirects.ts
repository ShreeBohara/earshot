/** Where signed-in visitors land by default. */
export const HOME_PATH = "/home";
/** Where new users land after their first sign-in (Better Auth's `newUserCallbackURL`). */
export const ONBOARDING_PATH = "/onboarding";

/**
 * A post-sign-in destination taken from a query string, accepted only if it's a path on this
 * site. Rejects absolute and protocol-relative URLs (`https://…`, `//…`, `/\…`), control
 * characters, API routes, and the sign-in page itself, so `?next=` can't become an open redirect
 * or a loop.
 */
export function safeNextPath(raw: unknown, fallback: string = HOME_PATH): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point.
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, "https://earshot.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "https://earshot.invalid") return fallback;
  if (url.pathname.startsWith("/api/") || url.pathname === "/sign-in") return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign-in page, returning to `next` afterwards. */
export function signInPath(next?: string): string {
  const target = safeNextPath(next, HOME_PATH);
  return target === HOME_PATH ? "/sign-in" : `/sign-in?next=${encodeURIComponent(target)}`;
}

/** Request header proxy.ts sets to the requested path, for redirects back after sign-in. */
export const PATHNAME_HEADER = "x-earshot-pathname";
