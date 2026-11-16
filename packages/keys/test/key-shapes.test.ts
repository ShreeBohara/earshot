import { containsKeyShape, KEY_SHAPES } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { redact, SECRET_PATTERNS } from "../src";

// @earshot/core keeps a dependency-free copy of SECRET_PATTERNS, so the session protocol can
// refuse a key that turns up outside `turn_end.key`. Add a key shape in both places.
describe("core's KEY_SHAPES", () => {
  it("are SECRET_PATTERNS, shape for shape", () => {
    expect(KEY_SHAPES.map((shape) => shape.source)).toEqual(
      SECRET_PATTERNS.map((pattern) => pattern.source),
    );
  });

  it("refuse only what redaction would mask", () => {
    const keys = [
      `sk-ant-api03-${"x".repeat(40)}`,
      `sk-proj-${"y".repeat(40)}`,
      `gsk_${"Z".repeat(40)}`,
      `AIza${"0".repeat(35)}`,
    ];
    for (const key of keys) {
      expect(containsKeyShape(`key: ${key}`)).toBe(true);
      expect(redact(`key: ${key}`)).toBe("key: [REDACTED]");
    }
  });
});
