// The adapter SDK's error taxonomy (Phase 6 spec §4.2): what a `CrmError` carries, and which kinds
// the outbox retries unless an adapter says otherwise.
import type { SyncErrorKind } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { CrmError } from "../src";

describe("CrmError", () => {
  it("carries its kind, the advice to retry, the status, the CRM's code, and the field", () => {
    const error = new CrmError("validation", "HubSpot refused the close date", {
      status: 400,
      code: "VALIDATION_ERROR",
      field: "closeDate",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "CrmError",
      message: "HubSpot refused the close date",
      kind: "validation",
      retryable: false,
      retryAfterMs: null,
      status: 400,
      code: "VALIDATION_ERROR",
      field: "closeDate",
    });
  });

  it.each<[SyncErrorKind, boolean]>([
    ["rate_limited", true],
    ["transient", true],
    ["auth", false],
    ["forbidden", false],
    ["not_found", false],
    ["validation", false],
    ["duplicate", false],
    ["unmapped", false],
    ["unsupported", false],
    ["unknown", false],
  ])("retries %s by default: %s", (kind, retryable) => {
    expect(new CrmError(kind, "a fixed message").retryable).toBe(retryable);
  });

  it("takes an adapter's own advice: a wait from Retry-After, or no retry", () => {
    const limited = new CrmError("rate_limited", "Attio asked to slow down", {
      status: 429,
      retryAfterMs: 2_000,
    });
    expect(limited).toMatchObject({ retryable: true, retryAfterMs: 2_000, status: 429 });
    expect(new CrmError("transient", "timed out", { retryable: false }).retryable).toBe(false);
  });

  it("keeps a cause, and has no fields it wasn't given", () => {
    const cause = new TypeError("fetch failed");
    const error = new CrmError("transient", "the network failed", { cause });
    expect(error.cause).toBe(cause);
    expect(error).toMatchObject({ status: null, code: null, field: null, retryAfterMs: null });
    expect("cause" in new CrmError("unknown", "no cause")).toBe(false);
  });

  it("refuses a wait that isn't one", () => {
    for (const retryAfterMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new CrmError("rate_limited", "slow down", { retryAfterMs })).toThrow(RangeError);
    }
  });
});
