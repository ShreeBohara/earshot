import { APICallError, LoadAPIKeyError } from "ai";
import { describe, expect, it } from "vitest";
import { classifyCallError, retryAfterMs } from "../src/errors";
import { DEFAULT_RETRY_POLICY, nextRetryDelay } from "../src/retry";

const live = new AbortController().signal;

function apiError(statusCode: number | undefined, headers: Record<string, string> = {}) {
  return new APICallError({
    message: "provider said something",
    url: "https://api.example.test/v1/messages",
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
    responseBody: "{}",
  });
}

describe("retryAfterMs", () => {
  const now = Date.UTC(2026, 10, 16, 12, 0, 0);

  it("reads retry-after-ms first, then retry-after in seconds or as an HTTP date", () => {
    expect(retryAfterMs({ "retry-after-ms": "1500", "retry-after": "9" }, now)).toBe(1500);
    expect(retryAfterMs({ "retry-after": "2" }, now)).toBe(2000);
    expect(retryAfterMs({ "retry-after": "0.5" }, now)).toBe(500);
    expect(retryAfterMs({ "retry-after": new Date(now + 3000).toUTCString() }, now)).toBe(3000);
  });

  it("ignores missing and unusable values", () => {
    expect(retryAfterMs(undefined, now)).toBeUndefined();
    expect(retryAfterMs({ "retry-after": "soon" }, now)).toBeUndefined();
    expect(retryAfterMs({ "retry-after": new Date(now - 5000).toUTCString() }, now)).toBe(0);
  });
});

describe("classifyCallError", () => {
  it("maps HTTP statuses to fixed codes", () => {
    expect(classifyCallError(apiError(401), live, 0)).toMatchObject({
      code: "key_rejected",
      retryable: false,
      status: 401,
    });
    expect(classifyCallError(apiError(403), live, 0)).toMatchObject({ code: "key_rejected" });
    expect(classifyCallError(apiError(429, { "retry-after": "1" }), live, 0)).toEqual({
      code: "rate_limited",
      retryable: true,
      detail: "http_429",
      status: 429,
      retryAfterMs: 1000,
    });
    expect(classifyCallError(apiError(529), live, 0)).toMatchObject({
      code: "provider_error",
      retryable: true,
      detail: "http_529",
    });
    expect(classifyCallError(apiError(503), live, 0)).toMatchObject({
      code: "provider_error",
      retryable: true,
    });
    expect(classifyCallError(apiError(400), live, 0)).toMatchObject({
      code: "provider_error",
      retryable: false,
      detail: "http_400",
    });
    expect(classifyCallError(apiError(undefined), live, 0)).toMatchObject({
      code: "provider_error",
      retryable: true,
      detail: "network",
    });
  });

  it("tells the caller cancelling from the turn's deadline", () => {
    const cancelled = new AbortController();
    cancelled.abort();
    expect(classifyCallError(new Error("x"), cancelled.signal, 0)).toMatchObject({
      code: "cancelled",
    });
    const timedOut = new AbortController();
    timedOut.abort(new DOMException("deadline", "TimeoutError"));
    expect(classifyCallError(new Error("x"), timedOut.signal, 0)).toMatchObject({
      code: "provider_error",
      detail: "timeout",
      retryable: false,
    });
  });

  it("names unexpected errors by class only", () => {
    const failure = classifyCallError(new TypeError("secret-ish message"), live, 0);
    expect(failure).toEqual({
      code: "provider_error",
      retryable: false,
      detail: "unexpected:TypeError",
    });
    expect(classifyCallError(new LoadAPIKeyError({ message: "missing" }), live, 0)).toMatchObject({
      code: "key_rejected",
    });
  });
});

describe("nextRetryDelay", () => {
  const rateLimited = { code: "rate_limited" as const, retryable: true, retryAfterMs: 1000 };
  const unavailable = { code: "provider_error" as const, retryable: true };

  it("honors Retry-After as given", () => {
    expect(
      nextRetryDelay(DEFAULT_RETRY_POLICY, {
        attempt: 1,
        failure: rateLimited,
        elapsedMs: 0,
        random: 0.9,
      }),
    ).toBe(1000);
  });

  it("backs off exponentially with equal jitter when there's no Retry-After", () => {
    const at = (attempt: number, random: number) =>
      nextRetryDelay(DEFAULT_RETRY_POLICY, { attempt, failure: unavailable, elapsedMs: 0, random });
    expect([at(1, 0), at(1, 1 - Number.EPSILON)]).toEqual([125, 250]);
    expect([at(2, 0), at(2, 0.5)]).toEqual([250, 375]);
  });

  it("stops after the third attempt, for failures that can't be retried, and at the deadline", () => {
    expect(
      nextRetryDelay(DEFAULT_RETRY_POLICY, {
        attempt: 3,
        failure: rateLimited,
        elapsedMs: 0,
        random: 0,
      }),
    ).toBeNull();
    expect(
      nextRetryDelay(DEFAULT_RETRY_POLICY, {
        attempt: 1,
        failure: { code: "key_rejected", retryable: false },
        elapsedMs: 0,
        random: 0,
      }),
    ).toBeNull();
    expect(
      nextRetryDelay(DEFAULT_RETRY_POLICY, {
        attempt: 1,
        failure: rateLimited,
        elapsedMs: 7_200,
        random: 0,
      }),
    ).toBeNull();
    expect(
      nextRetryDelay(DEFAULT_RETRY_POLICY, {
        attempt: 1,
        failure: { ...rateLimited, retryAfterMs: 30_000 },
        elapsedMs: 0,
        random: 0,
      }),
    ).toBeNull();
  });
});
