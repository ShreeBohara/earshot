import { getRedirectUrl, unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { PATHNAME_HEADER } from "@/lib/auth/redirects";
import { config, proxy } from "@/proxy";

const ORIGIN = "http://localhost:3000";

function request(path: string, cookies: Record<string, string> = {}) {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return new NextRequest(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {});
}

describe("proxy.ts", () => {
  it("redirects signed-out requests for signed-in pages to /sign-in, keeping the destination", () => {
    for (const path of ["/home", "/onboarding", "/settings/account", "/settings/keys?tab=x"]) {
      const response = proxy(request(path));
      expect(response.status, path).toBe(307);
      const target = new URL(getRedirectUrl(response) ?? "");
      expect(target.pathname).toBe("/sign-in");
      expect(target.searchParams.get("next")).toBe(path);
    }
  });

  it("lets requests with a session cookie through, without vouching for it", () => {
    for (const name of ["earshot.session_token", "__Secure-earshot.session_token"]) {
      const response = proxy(request("/settings/account", { [name]: "anything" }));
      expect(getRedirectUrl(response)).toBeNull();
      expect(response.headers.get("x-middleware-next")).toBe("1");
      // The page learns its own path, for a redirect back after sign-in if the session is invalid.
      expect(response.headers.get(`x-middleware-request-${PATHNAME_HEADER}`)).toBe(
        "/settings/account",
      );
    }
  });

  it("ignores other cookies", () => {
    const response = proxy(request("/home", { "better-auth.session_token": "x", other: "y" }));
    expect(response.status).toBe(307);
  });

  it("runs only on signed-in pages", () => {
    const runsOn = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    for (const url of [
      "/home",
      "/inbox",
      "/onboarding",
      "/settings",
      "/settings/account",
      "/settings/keys",
    ]) {
      expect(runsOn(url), url).toBe(true);
    }
    for (const url of [
      "/",
      "/sign-in",
      "/demo",
      "/design",
      "/api/auth/get-session",
      "/api/health",
    ]) {
      expect(runsOn(url), url).toBe(false);
    }
  });
});
