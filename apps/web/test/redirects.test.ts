import { describe, expect, it } from "vitest";
import { HOME_PATH, safeNextPath, signInPath } from "@/lib/auth/redirects";

const APP_ORIGIN = "https://app.example";

/** Where a browser on the app ends up after `redirect(path)` or `location.assign(path)`. */
function resolvedOrigin(path: string): string {
  return new URL(path, APP_ORIGIN).origin;
}

describe("safeNextPath", () => {
  it("keeps paths on this site, with their query and hash", () => {
    expect(safeNextPath("/settings/account")).toBe("/settings/account");
    expect(safeNextPath("/settings/keys?provider=deepgram#add")).toBe(
      "/settings/keys?provider=deepgram#add",
    );
    expect(safeNextPath("/a/../settings")).toBe("/settings");
  });

  it("falls back for paths that only become another host once normalized", () => {
    // Each passes a "starts with exactly one slash" check on the raw input, then normalizes to
    // //evil.example, which a browser treats as protocol-relative.
    for (const value of [
      "/.//evil.example",
      "/%2e//evil.example",
      "/%2E//evil.example",
      "/%2e%2e//evil.example",
      "/a/..//evil.example",
      "/a/.././/evil.example?x=1#y",
      "/ok/%2e%2e/%2e%2e//evil.example",
    ]) {
      expect(safeNextPath(value), value).toBe(HOME_PATH);
    }
  });

  it("keeps encoded slashes as a path on this site", () => {
    const result = safeNextPath("/%2F%2Fevil.example");
    expect(result.startsWith("//")).toBe(false);
    expect(resolvedOrigin(result)).toBe(APP_ORIGIN);
  });

  it("falls back for backslashes, control characters, and absolute or scheme URLs", () => {
    for (const value of [
      "/\\evil.example",
      "\\/evil.example",
      "\\\\evil.example",
      "/./\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/ok\nLocation: https://evil.example",
      "https://evil.example",
      "//evil.example",
      "///evil.example",
      "javascript:alert(1)",
      "data:text/html,hi",
      "settings",
      "",
      `/${"a".repeat(600)}`,
      undefined,
      ["/settings"],
    ]) {
      expect(safeNextPath(value), JSON.stringify(value)).toBe(HOME_PATH);
    }
  });

  it("falls back for API routes and the sign-in page", () => {
    for (const value of ["/api/auth/sign-out", "/api", "/sign-in", "/a/../sign-in"]) {
      expect(safeNextPath(value), value).toBe(HOME_PATH);
    }
  });

  it("only ever returns a path that keeps the app's origin", () => {
    const prefixes = [
      "/",
      "/.",
      "/..",
      "/%2e",
      "/%2E",
      "/%2e%2e",
      "/a/..",
      "/a/%2e%2e",
      "/./",
      "/a/../",
    ];
    const joints = ["/", "//", "\\", "/\\", "%2f", "%5c", "%2F%2F", "\t", "\n", " ", "@"];
    const targets = [
      "evil.example",
      "evil.example/path?x=1#y",
      "@evil.example",
      "javascript:alert(1)",
    ];
    const inputs = [
      "/.//evil.example",
      "/%2e//evil.example",
      "/a/..//evil.example",
      "/%2F%2Fevil.example",
      "/\\evil.example",
      "\\/evil.example",
      "/\t/evil.example",
      "https://evil.example",
      "//evil.example",
      "javascript:alert(1)",
      ...prefixes.flatMap((prefix) =>
        joints.flatMap((joint) => targets.map((target) => `${prefix}${joint}${target}`)),
      ),
    ];

    for (const input of inputs) {
      const result = safeNextPath(input);
      const label = `${JSON.stringify(input)} -> ${JSON.stringify(result)}`;
      expect(result.startsWith("/"), label).toBe(true);
      expect(result.startsWith("//"), label).toBe(false);
      expect(result.includes("\\"), label).toBe(false);
      expect(resolvedOrigin(result), label).toBe(APP_ORIGIN);
    }
  });
});

describe("signInPath", () => {
  it("carries a safe destination and drops the default one", () => {
    expect(signInPath("/settings/account")).toBe("/sign-in?next=%2Fsettings%2Faccount");
    expect(signInPath(HOME_PATH)).toBe("/sign-in");
    expect(signInPath("https://evil.example")).toBe("/sign-in");
    expect(signInPath("/.//evil.example")).toBe("/sign-in");
  });
});
