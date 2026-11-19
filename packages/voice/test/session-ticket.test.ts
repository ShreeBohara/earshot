import { describe, expect, it } from "vitest";
import { RetryDeadlineError, withRetry } from "../src/session/retry";
import { createTicketFetcher, SessionTicketError } from "../src/session/ticket";
import { settle } from "../src/testing/fake-socket";
import { ManualClock } from "./support/manual-clock";

const SESSION = "0000000a-0000-7000-8000-00000000a11c";

/** A fetch that answers from a script, one response per call, recording the requests. */
function scriptedFetch(responses: (() => Response | Promise<Response>)[]) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

const ok = json(200, {
  sessionId: SESSION,
  ticket: "abc.def",
  ticketExpiresAt: "2026-11-19T12:01:00.000Z",
  edgeUrl: "wss://edge.test/v1/sessions/x/ws",
});

describe("createTicketFetcher", () => {
  it("asks the ticket route with a same-origin POST, and returns the ticket", async () => {
    const { fetch, requests } = scriptedFetch([ok]);
    const getTicket = createTicketFetcher({
      sessionId: SESSION,
      fetch,
      baseUrl: "https://app.test",
    });
    await expect(getTicket(new AbortController().signal)).resolves.toEqual({
      ticket: "abc.def",
      ticketExpiresAt: "2026-11-19T12:01:00.000Z",
      edgeUrl: "wss://edge.test/v1/sessions/x/ws",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`https://app.test/api/sessions/${SESSION}/ticket`);
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
  });

  it("turns refusals reconnecting can't fix into final errors, without retrying them", async () => {
    for (const [status, code] of [
      [401, "signed_out"],
      [403, "forbidden"],
      [404, "not_found"],
      [409, "session_ended"],
    ] as const) {
      const { fetch, requests } = scriptedFetch([json(status, { error: "x", message: "y" })]);
      const error = await createTicketFetcher({ sessionId: SESSION, fetch })(
        new AbortController().signal,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionTicketError);
      expect(error).toMatchObject({ code, retryable: false, status, refusal: code });
      expect(requests).toHaveLength(1);
    }
  });

  it("retries a server error within the deadline, then succeeds", async () => {
    const clock = new ManualClock();
    const { fetch, requests } = scriptedFetch([json(503, {}), json(500, {}), ok]);
    const pending = createTicketFetcher({
      sessionId: SESSION,
      fetch,
      retry: { clock, random: () => 0 },
    })(new AbortController().signal);
    await settle();
    await clock.advance(125); // equal jitter at random 0: 125 ms, then 250 ms
    await clock.advance(250);
    await expect(pending).resolves.toMatchObject({ ticket: "abc.def" });
    expect(requests).toHaveLength(3);
  });

  it("reports a long Retry-After at once, so the connection can wait it out", async () => {
    const clock = new ManualClock();
    const { fetch, requests } = scriptedFetch([
      json(429, { error: "too_many_requests", message: "m", retryAfterSeconds: 300 }),
    ]);
    const error = await createTicketFetcher({ sessionId: SESSION, fetch, retry: { clock } })(
      new AbortController().signal,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 300_000 });
    expect(requests).toHaveLength(1);
    // The header serves when the body doesn't say.
    const header = scriptedFetch([
      () => new Response("busy", { status: 429, headers: { "retry-after": "12" } }),
    ]);
    const fromHeader = await createTicketFetcher({
      sessionId: SESSION,
      fetch: header.fetch,
      retry: { clock },
    })(new AbortController().signal).catch((caught: unknown) => caught);
    expect(fromHeader).toMatchObject({ code: "rate_limited", retryAfterMs: 12_000 });
  });

  it("refuses an answer without a ticket, or for another session", async () => {
    const clock = new ManualClock();
    for (const body of [{}, { ticket: "" }, { ticket: "t", sessionId: "someone-else" }]) {
      const { fetch } = scriptedFetch([json(200, body), json(200, body), json(200, body)]);
      const pending = createTicketFetcher({
        sessionId: SESSION,
        fetch,
        retry: { clock, random: () => 0 },
      })(new AbortController().signal).catch((caught: unknown) => caught);
      await settle();
      await clock.advance(1_000);
      expect(await pending).toMatchObject({ code: "bad_response" });
    }
  });
});

describe("withRetry", () => {
  it("gives the last error when attempts run out", async () => {
    const clock = new ManualClock();
    let calls = 0;
    const pending = withRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error(`failure ${calls}`), { retryable: true });
      },
      { clock, random: () => 0 },
    ).catch((caught: unknown) => caught);
    await settle();
    await clock.advance(10_000);
    expect(await pending).toMatchObject({ message: "failure 3" });
    expect(calls).toBe(3);
  });

  it("aborts an attempt that outlives the deadline", async () => {
    const clock = new ManualClock();
    let aborted: unknown;
    const pending = withRetry(
      (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = signal.reason;
            reject(signal.reason);
          });
        }),
      { clock },
    ).catch((caught: unknown) => caught);
    await clock.advance(8_000);
    expect(await pending).toBeInstanceOf(RetryDeadlineError);
    expect((aborted as Error).name).toBe("TimeoutError");
  });

  it("stops at once when the caller cancels, with the caller's reason", async () => {
    const clock = new ManualClock();
    const controller = new AbortController();
    const pending = withRetry(
      (signal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      {
        clock,
        signal: controller.signal,
      },
    ).catch((caught: unknown) => caught);
    const reason = new Error("left the page");
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(clock.pending).toBe(0);
  });
});
