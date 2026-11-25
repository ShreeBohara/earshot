// The reference CRM itself (Phase 6 spec §4.2): faults by seed at three points, a rate limit that
// answers 429 with retry advice, search that lags, and the rules its API keeps. A small chaos run
// shows the adapter's reconcile-then-retry leaves one record per write, whatever the faults.
import { describe, expect, it } from "vitest";
import { CrmError, marker, type PlannedWrite, type WriteOutcome } from "../src";
import { faultSchedule, MEMORY_CRM_API, MemoryCrm, seeded } from "../src/testing";

const NOTE: PlannedWrite = {
  index: 0,
  op: "create",
  object: "note",
  marker: "es_oxmttwqjbgqfzongy4te",
  ref: null,
  properties: {
    body: "A note.\n\nvia Earshot · ref es_oxmttwqjbgqfzongy4te",
    earshot_write_id: "es_oxmttwqjbgqfzongy4te",
  },
  associate: [],
};

/** A create of a company, under the marker of write `index` of one job. */
async function company(index: number): Promise<PlannedWrite> {
  const written = await marker("a".repeat(64), index);
  return {
    index: 0,
    op: "create",
    object: "company",
    marker: written,
    ref: null,
    properties: { name: `Company ${index}`, earshot_write_id: written },
    associate: [],
  };
}

describe("faults by seed", () => {
  it("are the same for the same seed, at about the chances asked", () => {
    const plan = { seed: 42, before: 0.1, afterCommit: 0.1, afterResponse: 0.1 };
    const one = faultSchedule(plan);
    const two = faultSchedule(plan);
    const draws = Array.from({ length: 2_000 }, () => one("POST"));
    expect(Array.from({ length: 2_000 }, () => two("POST"))).toEqual(draws);
    for (const point of ["before", "after_commit", "after_response"] as const) {
      const share = draws.filter((draw) => draw === point).length / draws.length;
      expect(share).toBeGreaterThan(0.07);
      expect(share).toBeLessThan(0.13);
    }
    expect(faultSchedule({ ...plan, writesOnly: true })("GET")).toBeNull();
    expect(() => faultSchedule({ seed: 1, before: 0.6, afterCommit: 0.6 })).toThrow(RangeError);
    expect(seeded(7)()).toBe(seeded(7)());
  });

  it("before the request: nothing lands, and the call fails as transient", async () => {
    const crm = new MemoryCrm();
    crm.inject("before");
    const error = await crm.execute(NOTE, [], crm.context()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "transient", retryable: true });
    expect(crm.records("note")).toHaveLength(0);
  });

  it("after the commit: the record lands, the call fails, and reconcile finds it", async () => {
    const crm = new MemoryCrm();
    crm.inject("after_commit");
    const error = await crm.execute(NOTE, [], crm.context()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CrmError);
    expect(crm.records("note")).toHaveLength(1);
    const found = await crm.reconcile(NOTE, [], crm.context());
    expect(found).toMatchObject({
      op: "found",
      ref: { object: "note", id: crm.records("note")[0]?.id },
    });
  });

  it("after the response: the status arrives, its body doesn't, and the call fails as transient", async () => {
    const crm = new MemoryCrm();
    crm.inject("after_response");
    const error = await crm.execute(NOTE, [], crm.context()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      kind: "transient",
      retryable: true,
      message: "Couldn't reach MemoryCrm",
    });
    expect(crm.records("note")).toHaveLength(1);
    expect(crm.calls.at(-1)).toMatchObject({
      method: "PUT",
      fault: "after_response",
      cost: "write",
    });
  });

  it.each(["upsert", "client_id", "readback"] as const)(
    "leave one record per write in %s mode, when each write is reconciled and retried",
    async (mode) => {
      const crm = new MemoryCrm({
        idempotency: { records: mode, activities: mode },
        faults: { seed: 2026, before: 0.15, afterCommit: 0.15, afterResponse: 0.15 },
      });
      const ctx = crm.context();
      const writes = await Promise.all(
        Array.from({ length: 150 }, async (_, index) => {
          const write = await company(index);
          // In client_id mode the id is the key, and no marker property is sent.
          return mode === "client_id"
            ? { ...write, properties: { name: `Company ${index}` } }
            : write;
        }),
      );
      const outcomes: WriteOutcome[] = [];
      for (const write of writes) {
        for (let attempt = 0; ; attempt += 1) {
          expect(attempt, "attempts").toBeLessThan(50);
          try {
            const found = await crm.reconcile(write, [], ctx);
            outcomes.push(found ?? (await crm.execute(write, [], ctx)));
            break;
          } catch (error) {
            expect(error).toMatchObject({ kind: "transient", retryable: true });
          }
        }
      }
      expect(crm.calls.filter((call) => call.fault !== null).length).toBeGreaterThan(50);
      expect(crm.records("company")).toHaveLength(150);
      expect(new Set(outcomes.map((outcome) => outcome.ref.id)).size).toBe(150);
    },
  );
});

describe("the rate limit", () => {
  it("answers 429 with the wait until its window ends, then lets calls through again", async () => {
    const crm = new MemoryCrm({ rateLimit: { limit: 2, windowMs: 10_000 } });
    const ctx = crm.context();
    await crm.verify(ctx);
    crm.advance(4_000);
    await crm.verify(ctx);
    const error = await crm.verify(ctx).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      kind: "rate_limited",
      retryable: true,
      retryAfterMs: 6_000,
      status: 429,
    });
    crm.advance(6_000);
    await expect(crm.verify(ctx)).resolves.toMatchObject({ accountId: "memory-1" });
  });
});

describe("search", () => {
  it("lags: a new record shows only once the lag has passed", async () => {
    const crm = new MemoryCrm({ searchLagMs: 30_000 });
    await crm.execute(await company(1), [], crm.context());
    const search = async () => {
      const response = await crm
        .context()
        .fetch(new Request(`${MEMORY_CRM_API}/v1/search?object=company&q=Company`), {
          kind: "search",
        });
      return ((await response.json()) as { results: unknown[] }).results.length;
    };
    expect(await search()).toBe(0);
    crm.advance(29_999);
    expect(await search()).toBe(0);
    crm.advance(1);
    expect(await search()).toBe(1);
  });
});

describe("the API's rules", () => {
  it("refuses a credential it doesn't take", async () => {
    const crm = new MemoryCrm();
    const error = await crm
      .verify(crm.context({ token: "wrong" }))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "auth", status: 401, retryable: false });
  });

  it("refuses a page bigger than its documented size", async () => {
    const crm = new MemoryCrm({ maxPageSize: 100 });
    const response = await crm
      .context()
      .fetch(new Request(`${MEMORY_CRM_API}/v1/changes?limit=101`), { kind: "read" });
    expect(response.status).toBe(400);
  });

  it("has no meetings when they're off, takes a client's id only in client_id mode, and associations inline only when inline", async () => {
    const off = new MemoryCrm({ meetings: false });
    const meeting = { ...NOTE, object: "meeting" as const, properties: { title: "Sync" } };
    await expect(off.execute(meeting, [], off.context())).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(off.capabilities.objects.meeting).toBe(false);

    const upsert = new MemoryCrm();
    const post = (body: unknown) =>
      upsert.context().fetch(
        new Request(`${MEMORY_CRM_API}/v1/objects/company`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { kind: "write" },
      );
    expect((await post({ id: "mine", properties: { name: "Acme" } })).status).toBe(400);

    const separate = new MemoryCrm({ associations: "separate" });
    const linked = {
      ...NOTE,
      associate: [
        { to: { object: "company" as const, id: "co_1", url: null }, type: "note_company" },
      ],
    };
    await expect(separate.execute(linked, [], separate.context())).rejects.toMatchObject({
      kind: "validation",
    });
  });
});
