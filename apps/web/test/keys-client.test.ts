import { PROVIDER_KEY_HEADER } from "@earshot/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkKey, removeFromVault, storeInVault } from "@/lib/keys/client";
import { cleanKeyLabel, MAX_KEY_LABEL_LENGTH } from "@/lib/keys/labels";
import { describeProblem } from "@/lib/keys/reasons";
import type { KeyProblem } from "@/lib/keys/types";

const KEY = "sk-proj-CLIENTcanaryQz7Xw2Lp9Rt4Mn8Bv6CxKs5Hg";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stubs fetch with one answer and returns the spy. */
function answer(status: number, body: unknown) {
  const spy = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("the browser client", () => {
  it("sends the key only in the header, and the provider in the body", async () => {
    const spy = answer(200, { ok: true, provider: "openai", last4: "s5Hg" });
    expect(await checkKey("openai", KEY)).toEqual({ ok: true, last4: "s5Hg" });

    const [url, init] = spy.mock.calls[0] ?? [];
    expect(url).toBe("/api/keys/validate");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(new Headers(init?.headers).get(PROVIDER_KEY_HEADER)).toBe(KEY);
    expect(init?.body).toBe(JSON.stringify({ provider: "openai" }));
    expect(url).not.toContain(KEY);
  });

  it("turns every kind of answer into a problem code", async () => {
    const cases: Array<[number, unknown, unknown]> = [
      [200, { ok: false, provider: "openai", last4: "s5Hg", reason: "rejected" }, "rejected"],
      [400, { ok: false, provider: "openai", reason: "missing_key" }, "missing_key"],
      [401, { error: "unauthorized", message: "Sign in to continue." }, "unauthorized"],
      [403, { error: "forbidden", message: "…" }, "forbidden"],
      [500, "not json", "server_error"],
      [502, { unexpected: true }, "server_error"],
    ];
    for (const [status, body, problem] of cases) {
      answer(status, body);
      expect(await checkKey("openai", KEY)).toEqual({ ok: false, problem });
    }

    answer(429, { error: "too_many_requests", message: "…", retryAfterSeconds: 420 });
    expect(await checkKey("openai", KEY)).toEqual({
      ok: false,
      problem: "too_many_requests",
      retryAfterSeconds: 420,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(await checkKey("openai", KEY)).toEqual({ ok: false, problem: "network" });
  });

  it("stores in and removes from the vault, reading each answer", async () => {
    const credential = {
      provider: "openai",
      label: "work",
      last4: "s5Hg",
      validatedAt: "2026-11-15T12:00:00.000Z",
      createdAt: "2026-11-15T12:00:00.000Z",
    };
    const spy = answer(200, { ok: true, credential });
    expect(await storeInVault("openai", "work", KEY)).toEqual({ ok: true, credential });
    const [, init] = spy.mock.calls[0] ?? [];
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get(PROVIDER_KEY_HEADER)).toBe(KEY);
    expect(init?.body).toBe(JSON.stringify({ provider: "openai", label: "work" }));

    answer(422, { ok: false, provider: "openai", last4: "s5Hg", reason: "rate_limited" });
    expect(await storeInVault("openai", "work", KEY)).toEqual({
      ok: false,
      problem: "rate_limited",
    });
    answer(403, { error: "reauth_required", message: "…" });
    expect(await storeInVault("openai", "work", KEY)).toEqual({
      ok: false,
      problem: "reauth_required",
    });
    answer(409, { error: "vault_off", message: "…" });
    expect(await storeInVault("openai", "work", KEY)).toEqual({ ok: false, problem: "vault_off" });

    const removal = answer(200, { ok: true, deleted: true });
    expect(await removeFromVault("openai", "work")).toEqual({ ok: true, deleted: true });
    const [, removeInit] = removal.mock.calls[0] ?? [];
    expect(removeInit?.method).toBe("DELETE");
    expect(new Headers(removeInit?.headers).has(PROVIDER_KEY_HEADER)).toBe(false);
  });
});

describe("copy for every problem", () => {
  // A record, so adding a code to KeyProblem without copy fails to compile.
  const EVERY: Record<KeyProblem, true> = {
    method_not_allowed: true,
    invalid_request: true,
    unknown_provider: true,
    missing_key: true,
    rejected: true,
    rate_limited: true,
    upstream_error: true,
    unreachable: true,
    unauthorized: true,
    forbidden: true,
    too_many_requests: true,
    reauth_required: true,
    vault_off: true,
    invalid_label: true,
    server_error: true,
    network: true,
    storage: true,
  };

  it("gives each a pill, a sentence, and a state", () => {
    for (const problem of Object.keys(EVERY) as KeyProblem[]) {
      const copy = describeProblem(problem, { provider: "OpenAI" });
      expect(copy.pill.length, problem).toBeGreaterThan(0);
      expect(copy.message, problem).toMatch(/^[A-Z].*\.$/);
      expect(["failed", "conflict"]).toContain(copy.state);
    }
  });

  it("names the provider, and says how long to wait", () => {
    expect(describeProblem("rejected", { provider: "Deepgram" }).message).toMatch(/^Deepgram /);
    expect(describeProblem("unreachable", { provider: "Groq" }).message).toContain("reach Groq");
    expect(describeProblem("unreachable").message).toContain("reach the provider");
    expect(describeProblem("too_many_requests", { retryAfterSeconds: 30 }).message).toContain(
      "a minute",
    );
    expect(describeProblem("too_many_requests", { retryAfterSeconds: 421 }).message).toContain(
      "8 minutes",
    );
  });
});

describe("key labels", () => {
  it("accepts 1 to 64 printable characters, trimmed", () => {
    expect(cleanKeyLabel("  work ")).toBe("work");
    expect(cleanKeyLabel("x".repeat(MAX_KEY_LABEL_LENGTH))).toBe("x".repeat(MAX_KEY_LABEL_LENGTH));
    expect(cleanKeyLabel("x".repeat(MAX_KEY_LABEL_LENGTH + 1))).toBeNull();
    expect(cleanKeyLabel("   ")).toBeNull();
    expect(cleanKeyLabel("two\nlines")).toBeNull();
  });

  it("refuses a label that holds the key, or anything shaped like one", () => {
    expect(cleanKeyLabel(KEY, KEY)).toBeNull();
    expect(cleanKeyLabel(`mine: ${KEY}`, KEY)).toBeNull();
    expect(
      cleanKeyLabel(
        "dgcafe5f3e9a7c1b4d8e2f6a0c3b5d7e9f1a2c4b6",
        "dgcafe5f3e9a7c1b4d8e2f6a0c3b5d7e9f1a2c4b6",
      ),
    ).toBeNull();
    expect(cleanKeyLabel("sk-ant-abcdefghijklmnopqrstuvwxyz")).toBeNull();
    expect(cleanKeyLabel("AIzaSyAbcdefghijklmnopqrstuvwxyz012345678")).toBeNull();
    expect(cleanKeyLabel("work", KEY)).toBe("work");
  });
});
