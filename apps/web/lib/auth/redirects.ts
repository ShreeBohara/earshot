/** Where signed-in visitors land by default. */
export const HOME_PATH = "/home";
/** Where new users land after their first sign-in (Better Auth's `newUserCallbackURL`). */
export const ONBOARDING_PATH = "/onboarding";

/** A stand-in origin for parsing; any origin works, as long as results are compared against it. */
const PARSE_BASE = "https://earshot.invalid";

// Backslashes count as slashes to browsers in http(s) URLs, and the URL parser strips tabs and
// newlines, so any of these can turn a harmless-looking path into another host.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point.
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

/**
 * Whether a browser resolving `path` stays on the current site: exactly one leading slash, no
 * backslash or control character, and the same origin once parsed.
 */
function staysOnSite(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || UNSAFE_CHARACTERS.test(path)) {
    return false;
  }
  try {
    return new URL(path, PARSE_BASE).origin === PARSE_BASE;
  } catch {
    return false;
  }
}

/**
 * A post-sign-in destination taken from a query string, accepted only if it's a path on this
 * site. Rejects absolute and protocol-relative URLs (`https://…`, `//…`, `/\…`), control
 * characters, API routes, and the sign-in page itself, so `?next=` can't become an open redirect
 * or a loop.
 *
 * The input is normalized (dot segments resolved) before it's returned, and normalizing can
 * create what the input checks ruled out: `/.//evil.example` and `/a/..//evil.example` both
 * normalize to `//evil.example`, which a browser reads as another host. So the result is checked
 * again, and anything that wouldn't stay on this site falls back.
 */
export function safeNextPath(raw: unknown, fallback: string = HOME_PATH): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return fallback;
  if (!staysOnSite(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, PARSE_BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== PARSE_BASE) return fallback;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === "/sign-in") {
    return fallback;
  }
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  return staysOnSite(normalized) ? normalized : fallback;
}

/** The sign-in page, returning to `next` afterwards. */
export function signInPath(next?: string): string {
  const target = safeNextPath(next, HOME_PATH);
  return target === HOME_PATH ? "/sign-in" : `/sign-in?next=${encodeURIComponent(target)}`;
}

/** Request header proxy.ts sets to the requested path, for redirects back after sign-in. */
export const PATHNAME_HEADER = "x-earshot-pathname";
