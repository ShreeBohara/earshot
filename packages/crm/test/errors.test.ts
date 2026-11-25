// The adapter SDK's error taxonomy (Phase 6 spec §4.2): what a `CrmError` carries, which kinds the
// outbox retries unless an adapter says otherwise, the HTTP statuses each kind comes from, the
// retry advice a CRM gives, and why no error can carry a credential.
import type { SyncErrorKind } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  CrmError,
  errorFromResponse,
  holdsSecret,
  networkError,
  parseRetryAfter,
  retryAfterMs,
} from "../src";

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

describe("errorFromResponse", () => {
  it.each<[number, SyncErrorKind, boolean]>([
    [429, "rate_limited", true],
    [500, "transient", true],
    [502, "transient", true],
    [503, "transient", true],
    [504, "transient", true],
    [408, "transient", true],
    [401, "auth", false],
    [403, "forbidden", false],
    [404, "not_found", false],
    [410, "not_found", false],
    [409, "duplicate", false],
    [400, "validation", false],
    [422, "validation", false],
    [405, "unknown", false],
    [418, "unknown", false],
    [302, "unknown", false],
  ])("maps %i to %s (retried: %s)", (status, kind, retryable) => {
    const error = errorFromResponse(status);
    expect(error).toBeInstanceOf(CrmError);
    expect(error).toMatchObject({ kind, retryable, status });
  });

  it("reads a revoked grant as auth, whatever the status", () => {
    expect(errorFromResponse(400, { code: "invalid_grant" })).toMatchObject({
      kind: "auth",
      code: "invalid_grant",
      retryable: false,
    });
  });

  it("keeps the field of a refused value, and the record that holds a taken one", () => {
    const existing = { object: "contact", id: "501", url: null } as const;
    expect(
      errorFromResponse(400, { code: "INVALID_DATE", field: "closeDate" }, null, {
        crm: "HubSpot",
      }),
    ).toMatchObject({
      kind: "validation",
      code: "INVALID_DATE",
      field: "closeDate",
      message: "HubSpot refused a value",
    });
    expect(errorFromResponse(409, { code: "CONFLICT", existing })).toMatchObject({
      kind: "duplicate",
      existing,
      field: null,
    });
  });

  it("drops a code that isn't shaped like one, a field that isn't a field, and a field on a kind that names none", () => {
    const quoted = errorFromResponse(400, {
      code: "Property values were not valid: Dana's email",
      field: "close date",
    });
    expect(quoted).toMatchObject({ code: null, field: null });
    expect(errorFromResponse(403, { code: "MISSING_SCOPES", field: "amount" })).toMatchObject({
      kind: "forbidden",
      code: "MISSING_SCOPES",
      field: null,
    });
    expect(errorFromResponse(400, { code: "x".repeat(65) }).code).toBeNull();
    expect(
      errorFromResponse(200, { existing: { object: "deal", id: "1", url: null } }),
    ).toMatchObject({ kind: "unknown", existing: null });
  });

  it("says what happened in fixed words, never the CRM's", () => {
    expect(errorFromResponse(429, {}, null, { crm: "Attio" }).message).toBe(
      "Attio asked to slow down",
    );
    expect(errorFromResponse(418).message).toBe("The CRM answered with status 418");
  });

  it("takes the wait a 429 or a 503 asks for, in seconds or as a date", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    expect(errorFromResponse(429, {}, { "Retry-After": "3" }).retryAfterMs).toBe(3_000);
    expect(
      errorFromResponse(429, {}, new Headers({ "retry-after": "Wed, 25 Nov 2026 12:00:05 GMT" }), {
        now,
      }).retryAfterMs,
    ).toBe(5_000);
    expect(errorFromResponse(503, {}, { "retry-after": "1" }).retryAfterMs).toBe(1_000);
    // HubSpot's 429s send none: the outbox backs off on its own.
    expect(errorFromResponse(429, { code: "RATE_LIMIT" }).retryAfterMs).toBeNull();
    // Only a 429 and a passing failure carry a wait.
    expect(errorFromResponse(401, {}, { "retry-after": "3" }).retryAfterMs).toBeNull();
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");

  it.each<[string | null | undefined, number | null]>([
    ["0", 0],
    ["2", 2_000],
    [" 120 ", 120_000],
    ["Wed, 25 Nov 2026 12:00:30 GMT", 30_000],
    ["Wed, 25 Nov 2026 11:59:00 GMT", 0],
    ["1.5", null],
    ["-1", null],
    ["soon", null],
    ["Wednesday, 25-Nov-26 12:00:30 GMT", null],
    ["Wed Nov 25 12:00:30 2026", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("reads %j as %j ms", (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });

  it("reads a header from Headers or a record, whatever its case", () => {
    expect(retryAfterMs(new Headers({ "Retry-After": "4" }), now)).toBe(4_000);
    expect(retryAfterMs({ "RETRY-AFTER": "4" }, now)).toBe(4_000);
    expect(retryAfterMs({}, now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
  });
});

describe("a CrmError never carries a credential", () => {
  const token = "opaqueFAKEtokenForErrorTests0nly-qRs3";

  it("redacts its message", () => {
    const error = new CrmError("auth", `refused Authorization: Bearer ${token}`);
    expect(error.message).toBe("refused Authorization: [REDACTED]");
    expect(holdsSecret(error, token)).toBe(false);
  });

  it("makes its cause safe, keeping a plain one as it is", () => {
    const leaky = new TypeError(`fetch failed for https://api.example.test/v1?hapikey=${token}`);
    const error = new CrmError("transient", "Couldn't reach the CRM", { cause: leaky });
    expect(error.cause).not.toBe(leaky);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).name).toBe("TypeError");
    expect((error.cause as Error).message).toBe(
      "fetch failed for https://api.example.test/v1?hapikey=[REDACTED]",
    );
    expect(holdsSecret(error, token)).toBe(false);

    const plain = new TypeError("fetch failed");
    expect(new CrmError("transient", "Couldn't reach the CRM", { cause: plain }).cause).toBe(plain);
  });

  it("drops what an Error carries besides its words, and objects that aren't errors", () => {
    const withRequest = Object.assign(new Error("failed"), {
      request: { headers: { authorization: token } },
    });
    const error = new CrmError("unknown", "failed", { cause: withRequest });
    expect(holdsSecret(error, token)).toBe(false);
    expect(Object.keys(error.cause as object)).toEqual([]);

    const object = new CrmError("unknown", "failed", { cause: { token } });
    expect(holdsSecret(object, token)).toBe(false);
    expect((object.cause as Error).message).toBe("a object value was thrown");
  });

  it("follows a chain of causes", () => {
    const deep = new Error("outer", { cause: new Error(`inner Bearer ${token}`) });
    const error = new CrmError("transient", "failed", { cause: deep });
    expect(holdsSecret(error, token)).toBe(false);
    expect(((error.cause as Error).cause as Error).message).toBe("inner Bearer [REDACTED]");
  });

  it("maps a network failure to a retried transient error", () => {
    const error = networkError(new TypeError("network connection lost"), { crm: "Twenty" });
    expect(error).toMatchObject({
      kind: "transient",
      retryable: true,
      status: null,
      message: "Couldn't reach Twenty",
    });
  });
});
