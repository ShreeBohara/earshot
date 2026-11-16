import { describe, expect, it } from "vitest";
import { HOME_PATH, safeNextPath, signInPath } from "@/lib/auth/redirects";

describe("safeNextPath", () => {
  it("keeps paths on this site, with their query and hash", () => {
    expect(safeNextPath("/settings/account")).toBe("/settings/account");
    expect(safeNextPath("/settings/keys?provider=deepgram#add")).toBe(
      "/settings/keys?provider=deepgram#add",
    );
  });

  it("rejects anything that could leave the site or loop", () => {
    for (const value of [
      undefined,
      "",
      "https://evil.example/",
      "//evil.example/path",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "settings",
      "/api/auth/sign-out",
      "/sign-in",
      "/ok\nLocation: https://evil.example",
      `/${"a".repeat(600)}`,
      ["/settings"],
    ]) {
      expect(safeNextPath(value), String(value)).toBe(HOME_PATH);
    }
  });
});

describe("signInPath", () => {
  it("carries a safe destination and drops the default one", () => {
    expect(signInPath("/settings/account")).toBe("/sign-in?next=%2Fsettings%2Faccount");
    expect(signInPath(HOME_PATH)).toBe("/sign-in");
    expect(signInPath("https://evil.example")).toBe("/sign-in");
  });
});
