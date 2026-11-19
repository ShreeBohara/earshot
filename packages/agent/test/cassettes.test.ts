import { fromJsonl } from "@earshot/events";
import { readFixture } from "@earshot/events/testing";
import { describe, expect, it } from "vitest";
import {
  CASSETTES,
  CassetteMissError,
  canonicalJson,
  cassetteKey,
  createCassetteFetch,
  DEMO_CALL_TIME,
  DEMO_UTTERANCES,
  generateCassetteFiles,
  requestExcerpt,
} from "../src/testing";

describe("the committed cassettes", () => {
  it("are what scripts/gen-cassettes.ts generates today (run `pnpm --filter @earshot/agent cassettes:gen` after changing a prompt, the schema, or a scenario)", async () => {
    const generated = await generateCassetteFiles();
    expect(JSON.parse(JSON.stringify(generated))).toEqual(CASSETTES);
  });

  it("hold the demo session's turns, as the events fixture has them", () => {
    const events = fromJsonl(readFixture("demo-session.jsonl"));
    const utterances = events
      .filter((event) => event.type === "utterance.final")
      .map((event) => ({ witness: "biased", ...(event.payload as object) }));
    expect(DEMO_UTTERANCES).toEqual(utterances);
    const started = events.find((event) => event.type === "session.started");
    expect(started?.payload).toMatchObject({ startedAt: DEMO_CALL_TIME });
  });
});

describe("cassette keys", () => {
  it("ignore key order and formatting in a JSON body", async () => {
    const a = await cassetteKey(
      "post",
      "/v1/messages",
      '{"b":1,"a":{"y":2,"x":[3,{"q":1,"p":0}]}}',
    );
    const b = await cassetteKey(
      "POST",
      "/v1/messages",
      '{ "a": { "x": [3, { "p": 0, "q": 1 }], "y": 2 }, "b": 1 }',
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: null }] })).toBe(
      '{"a":[2,{"c":null,"d":1}],"b":1}',
    );
  });

  it("change with the method, the path, or any value", async () => {
    const base = await cassetteKey("POST", "/v1/messages", '{"a":1}');
    expect(await cassetteKey("GET", "/v1/messages", '{"a":1}')).not.toBe(base);
    expect(await cassetteKey("POST", "/v1/other", '{"a":1}')).not.toBe(base);
    expect(await cassetteKey("POST", "/v1/messages", '{"a":2}')).not.toBe(base);
  });
});

describe("createCassetteFetch", () => {
  const request = (body: string) =>
    new Request("https://api.example.test/v1/messages", { method: "POST", body });

  async function interaction(body: string, status: number, reply: unknown) {
    return {
      key: await cassetteKey("POST", "/v1/messages", body),
      request: { method: "POST", path: "/v1/messages", excerpt: JSON.parse(body) },
      response: { status, headers: { "retry-after": "1" }, body: reply },
    };
  }

  it("plays interactions with the same key in recorded order", async () => {
    const fetch = createCassetteFetch({
      name: "retry",
      description: "",
      interactions: [
        await interaction('{"a":1}', 429, { error: 1 }),
        await interaction('{"a":1}', 200, { ok: true }),
      ],
    });
    const first = await fetch(request('{"a":1}'));
    expect([first.status, first.headers.get("retry-after")]).toEqual([429, "1"]);
    const second = await fetch(request('{"a":1}'));
    expect([second.status, await second.json()]).toEqual([200, { ok: true }]);
    expect(fetch.played).toBe(2);
    expect(fetch.remaining()).toBe(0);
  });

  it("throws on a request it can't answer, instead of reaching the network", async () => {
    const fetch = createCassetteFetch({
      name: "one",
      description: "",
      interactions: [await interaction('{"a":1}', 200, {})],
    });
    await expect(fetch(request('{"a":2}'))).rejects.toBeInstanceOf(CassetteMissError);
    await fetch(request('{"a":1}'));
    await expect(fetch(request('{"a":1}'))).rejects.toThrow(
      /No cassette interaction for POST \/v1\/messages/,
    );
    expect(fetch.misses).toHaveLength(2);
  });

  it("honors an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = createCassetteFetch({ name: "none", description: "", interactions: [] });
    await expect(
      fetch("https://api.example.test/v1/messages", {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
    expect(fetch.misses).toHaveLength(0);
  });

  it("keeps the transcript and options in the excerpt, and drops the system prompt and tools", () => {
    expect(
      requestExcerpt({
        model: "m",
        system: [{ type: "text", text: "rules" }],
        tools: [{ name: "submit_proposals" }],
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "the transcript" },
        ],
      }),
    ).toEqual({ model: "m", messages: [{ role: "user", content: "the transcript" }] });
  });
});
