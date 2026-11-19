// Text Postgres's jsonb can't store (src/session/jsonb.ts): refused from clients, cleaned from
// model output, so no event in SessionDO's log can make every later flush fail.
import { describe, expect, it } from "vitest";
import { hasUnstorableString, toStorable } from "../src/session/jsonb";

describe("jsonb-safe text", () => {
  it("finds U+0000 and unpaired surrogates in values and keys, at any depth", () => {
    expect(hasUnstorableString({ a: ["fine", { b: "also fine 😀" }] })).toBe(false);
    expect(hasUnstorableString({ a: ["x\u0000y"] })).toBe(true);
    expect(hasUnstorableString({ a: { b: "\ud800" } })).toBe(true);
    expect(hasUnstorableString({ "k\u0000": 1 })).toBe(true);
  });

  it("replaces them with U+FFFD, keeping every string's length", () => {
    const cleaned = toStorable({ value: "a\u0000b\udc00c", ok: "😀" });
    expect(cleaned).toEqual({ value: "a�b�c", ok: "😀" });
    expect(cleaned.value).toHaveLength(5);
    const untouched = { value: "clean" };
    expect(toStorable(untouched)).toBe(untouched);
  });
});
