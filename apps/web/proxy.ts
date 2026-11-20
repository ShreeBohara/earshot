import { type NextRequest, NextResponse } from "next/server";
import { hasSessionCookie } from "@/lib/auth/cookies";
import { PATHNAME_HEADER } from "@/lib/auth/redirects";

/**
 * Optimistic redirects only. A request for a signed-in page without a session cookie goes
 * straight to /sign-in instead of rendering first. The cookie isn't verified here, and nothing is
 * granted: every page, action, and route checks the session itself in the data layer
 * (lib/auth/viewer.ts), so a forged or stale cookie gets no further than that check.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (!hasSessionCookie(request.cookies)) {
    const signIn = new URL("/sign-in", request.url);
    signIn.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(signIn);
  }
  // Tells the signed-in layout where to send the user back to if their session turns out to be
  // invalid. Overwrites anything the client sent; the layout still sanitizes it.
  const headers = new Headers(request.headers);
  headers.set(PATHNAME_HEADER, `${pathname}${search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/home/:path*", "/inbox/:path*", "/onboarding/:path*", "/settings/:path*"],
};
