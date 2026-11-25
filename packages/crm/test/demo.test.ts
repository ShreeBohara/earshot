// The demo CRM as a CRM (Phase 6 WP2), beyond the conformance suite: the history its writes leave
// (each changed field, `source: "sync"`, and a new record's arrival), what its API refuses, and its
// mapping reading a stage by its label or by the id the demo rows hold.
import { describe, expect, it } from "vitest";
import { type PlannedWrite, readStage } from "../src";
import { DEMO_MAPPING, DEMO_SCHEMA, demoAdapter, demoContext, demoFetch } from "../src/demo";
import { MemoryDemoStore } from "../src/testing";

const MARKER = "es_oxmttwqjbgqfzongy4te";

function setup() {
  const store = new MemoryDemoStore();
  const acme = store.seed("company", "Acme", {});
  const deal = store.seed("deal", "Acme renewal", {
    stage: "appointmentscheduled",
    amount: 30_000,
    companyId: acme.id,
  });
  return { store, acme, deal, ctx: demoContext(store) };
}

describe("the demo adapter's writes", () => {
  it("make a demo record, its arrival in the history as its name from none, and find it again", async () => {
    const { store, acme, ctx } = setup();
    const write: PlannedWrite = {
      index: 0,
      op: "create",
      object: "contact",
      marker: MARKER,
      ref: null,
      properties: { name: "Priya Raman", firstName: "Priya", lastName: "Raman", writeId: MARKER },
      associate: [{ to: { object: "company", id: acme.id, url: null }, type: "companyId" }],
    };
    const made = await demoAdapter.execute(write, [], ctx);
    expect(made).toMatchObject({ op: "created", ref: { object: "contact" } });
    expect(made.ref.id).toMatch(/^added:/);
    expect(await store.record("contact", made.ref.id)).toMatchObject({
      name: "Priya Raman",
      properties: { firstName: "Priya", lastName: "Raman", companyId: acme.id, writeId: MARKER },
    });
    expect(store.history).toEqual([
      expect.objectContaining({
        id: made.ref.id,
        field: "name",
        old: null,
        new: "Priya Raman",
        source: "sync",
      }),
    ]);
    expect(await demoAdapter.execute(write, [], ctx)).toEqual({ ...made, op: "found" });
    expect(await demoAdapter.reconcile(write, [], ctx)).toEqual({ ...made, op: "found" });
    expect(store.history).toHaveLength(1);
  });

  it("record each field an update changes, and nothing for one that stays", async () => {
    const { store, deal, ctx } = setup();
    const update: PlannedWrite = {
      index: 0,
      op: "update",
      object: "deal",
      marker: MARKER,
      ref: { object: "deal", id: deal.id, url: null },
      properties: { stage: "contractsent", amount: 30_000 },
      associate: [],
    };
    expect(await demoAdapter.execute(update, [], ctx)).toMatchObject({
      op: "updated",
      ref: { id: deal.id },
    });
    expect(store.history).toEqual([
      expect.objectContaining({
        field: "stage",
        old: "appointmentscheduled",
        new: "contractsent",
        source: "sync",
      }),
    ]);
    expect(
      await demoAdapter.get(update.ref as never, ["stage", "amount", "name"], ctx),
    ).toMatchObject({
      values: { stage: "contractsent", amount: 30_000, name: "Acme renewal" },
    });
  });

  it("put an activity on a record, or fail not_found when the record is gone", async () => {
    const { store, deal, ctx } = setup();
    const note: PlannedWrite = {
      index: 0,
      op: "create",
      object: "note",
      marker: MARKER,
      ref: null,
      properties: { body: `Met the CFO.\n\nvia Earshot · ref ${MARKER}` },
      associate: [{ to: { object: "deal", id: deal.id, url: null }, type: "record" }],
    };
    store.remove("deal", deal.id);
    await expect(demoAdapter.execute(note, [], ctx)).rejects.toMatchObject({ kind: "not_found" });
    expect(store.activities()).toEqual([]);
  });
});

describe("the demo API", () => {
  const put = async (path: string, body: unknown) => {
    const { store } = setup();
    return demoFetch(store)(
      new Request(`demo:${path}`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const property = async (response: Response) =>
    ((await response.json()) as { error: { property?: string } }).error.property;

  it("refuses a property it doesn't know, a stage outside its pipeline, and a name shaped like a key", async () => {
    const unknown = await put(`/companies?writeId=${MARKER}`, {
      properties: { name: "Acme", industry: "x" },
    });
    expect([unknown.status, await property(unknown)]).toEqual([400, "industry"]);
    const stage = await put(`/deals?writeId=${MARKER}`, {
      properties: { name: "Deal", stage: "won" },
    });
    expect([stage.status, await property(stage)]).toEqual([400, "stage"]);
    const key = await put(`/companies?writeId=${MARKER}`, {
      properties: { name: "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    expect([key.status, await property(key)]).toEqual([400, "name"]);
  });

  it("refuses a write without a marker, and an activity on no record", async () => {
    const unmarked = await put("/companies", { properties: { name: "Acme" } });
    expect([unmarked.status, await property(unmarked)]).toEqual([400, "writeId"]);
    const loose = await put(`/notes?writeId=${MARKER}`, { properties: { body: "x" } });
    expect([loose.status, await property(loose)]).toEqual([400, "associations"]);
  });
});

describe("the demo CRM's schema and mapping", () => {
  it("reads a stage by its label or by the id its rows hold", () => {
    expect(readStage("contract sent", DEMO_MAPPING.stages)).toMatchObject({
      ok: true,
      stage: { stageId: "contractsent" },
    });
    expect(readStage("contractsent", DEMO_MAPPING.stages)).toMatchObject({
      ok: true,
      how: "exact",
    });
    expect(DEMO_MAPPING.newDeals.pipelineId).toBe("default");
    expect(DEMO_MAPPING.owners).toEqual([]);
  });

  it("answers verify and schema from what it is, with no connection", async () => {
    const ctx = demoContext(new MemoryDemoStore(), { accountId: "workspace-1" });
    expect(ctx.connection).toEqual({ id: null, accountId: "workspace-1", apiBase: "demo:" });
    expect(await demoAdapter.verify(ctx)).toEqual({
      accountId: "workspace-1",
      accountName: "The demo CRM",
      actor: null,
      scopes: [],
    });
    expect(await demoAdapter.schema(ctx)).toBe(DEMO_SCHEMA);
    expect(demoAdapter.capabilities.owners).toBe(false);
  });
});
