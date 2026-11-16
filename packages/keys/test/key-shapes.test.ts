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
      `ek_${"68af296e".repeat(4)}`,
      `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.${"Sg9".repeat(14)}x`,
    ];
    for (const key of keys) {
      expect(containsKeyShape(`key: ${key}`)).toBe(true);
      expect(redact(`key: ${key}`)).toBe("key: [REDACTED]");
    }
  });
});

describe("short-lived credential shapes", () => {
  const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZy1ncmFudCJ9.c2lnbmF0dXJlLWJ5dGVz";

  it("mask OpenAI ephemeral keys and JWT-shaped strings wherever they appear", () => {
    const ephemeral = `ek_${"0a1b2c3d".repeat(4)}`;
    expect(redact(`Bearer ${ephemeral}`)).toBe("Bearer [REDACTED]");
    expect(redact(`["bearer", "${JWT}"]`)).toBe('["bearer", "[REDACTED]"]');
    expect(redact(`token=${JWT}&sample_rate=16000`)).toBe("token=[REDACTED]&sample_rate=16000");
  });

  it("leave a JWT's lookalikes alone: two parts, short parts, or an `ek_` too short to be a key", () => {
    // A session ticket is `payload.signature`: two parts, so exact-secret redaction covers it.
    const twoParts = "eyJ2IjoxLCJzaWQiOiIwMWExYzZlMi05MzIwIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU";
    for (const text of [twoParts, "eyJ.CANARY_ID_x", "eyJabc.def.ghi", "ek_short", "week_number"]) {
      expect(redact(text)).toBe(text);
    }
    // In the protocol a shape must also start a word, as for the other keys.
    expect(containsKeyShape(`week_${"a".repeat(30)}`)).toBe(false);
    expect(containsKeyShape(`x${JWT}`)).toBe(false);
    expect(containsKeyShape(`(${JWT})`)).toBe(true);
  });
});
