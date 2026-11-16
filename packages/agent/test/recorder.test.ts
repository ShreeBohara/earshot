// The recorder is never run against a provider here: a fake upstream stands in.
import { describe, expect, it } from "vitest";
import { createRecordingFetch, RecordingLeakError, recordingAllowed } from "../src/testing";

const KEY = "earshot-recorder-test-key-9f8e7d6c5b4a";

describe("recordingAllowed", () => {
  it("is off by default, and needs both the flag and the provider's key", () => {
    expect(recordingAllowed({}, "anthropic")).toBe(false);
    expect(recordingAllowed({ EARSHOT_RECORD_CASSETTES: "1" }, "anthropic")).toBe(false);
    expect(recordingAllowed({ EVAL_ANTHROPIC_KEY: KEY }, "anthropic")).toBe(false);
    expect(
      recordingAllowed({ EARSHOT_RECORD_CASSETTES: "true", EVAL_ANTHROPIC_KEY: KEY }, "anthropic"),
    ).toBe(false);
    expect(
      recordingAllowed({ EARSHOT_RECORD_CASSETTES: "1", EVAL_GROQ_KEY: KEY }, "anthropic"),
    ).toBe(false);
    expect(
      recordingAllowed({ EARSHOT_RECORD_CASSETTES: "1", EVAL_ANTHROPIC_KEY: KEY }, "anthropic"),
    ).toBe(true);
    expect(recordingAllowed({ EARSHOT_RECORD_CASSETTES: "1", EVAL_GROQ_KEY: " " }, "groq")).toBe(
      false,
    );
  });
});

describe("createRecordingFetch", () => {
  const send = (fetch: typeof globalThis.fetch) =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        system: "rules",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

  it("records the request without its headers, and only the response headers that matter", async () => {
    const upstream = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "__cf_bm=abc",
          "request-id": "req_1",
        },
      });
    const recorder = createRecordingFetch(upstream as typeof fetch, [KEY]);
    const response = await send(recorder.fetch);
    expect(await response.json()).toEqual({ ok: true });
    const [interaction] = recorder.interactions();
    expect(interaction?.request).toEqual({
      method: "POST",
      path: "/v1/messages",
      excerpt: { model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] },
    });
    expect(interaction?.response).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    });
    expect(JSON.stringify(recorder.interactions())).not.toContain("earshot-recorder");
  });

  it("refuses to keep an interaction that contains part of a key", async () => {
    const upstream = async () =>
      new Response(JSON.stringify({ error: `bad key ${KEY.slice(4, 16)}` }), { status: 401 });
    const recorder = createRecordingFetch(upstream as typeof fetch, [KEY]);
    await expect(send(recorder.fetch)).rejects.toBeInstanceOf(RecordingLeakError);
    expect(recorder.interactions()).toEqual([]);
  });
});
