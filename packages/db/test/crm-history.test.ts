import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type FieldChange,
  fieldKey,
  readFieldHistory,
  recordCrmChanges,
  valueAt,
  valueFromHistory,
} from "../src/crm-history";
import { crmEntities, crmEntityChanges } from "../src/schema";
import { withTenant } from "../src/tenant";
import { A, B, cloneDb, rowId, seededDb } from "./db";

// The mirror's history (Phase 5 WP12, migration 0017): valueAt's three cases, pure and on PGlite
// behind withTenant, the batch read the inbox's loader makes, and the writer.

type Db = Awaited<ReturnType<typeof seededDb>>["db"];

let template: PGlite;
let client: PGlite;
let db: Db;

beforeAll(async () => {
  ({ client: template } = await seededDb());
});

beforeEach(async () => {
  ({ client, db } = await cloneDb(template));
});

afterEach(async () => {
  await client.close();
});

const at = (iso: string) => new Date(iso);
const change = (id: string, old: FieldChange["old"], next: FieldChange["new"], when: string) => ({
  id,
  old,
  new: next,
  changedAt: at(when),
});

describe("valueFromHistory", () => {
  const history = [
    change("c2", "qualifiedtobuy", "presentationscheduled", "2026-11-20T12:00:00Z"),
    change("c1", "appointmentscheduled", "qualifiedtobuy", "2026-11-18T12:00:00Z"),
  ];

  it("answers the new of the last change at or before the time", () => {
    expect(valueFromHistory(history, at("2026-11-19T00:00:00Z"), "presentationscheduled")).toBe(
      "qualifiedtobuy",
    );
    // At the very instant of a change, the change has happened.
    expect(valueFromHistory(history, at("2026-11-20T12:00:00Z"), "presentationscheduled")).toBe(
      "presentationscheduled",
    );
  });

  it("else the old of the first change after it", () => {
    expect(valueFromHistory(history, at("2026-11-01T00:00:00Z"), "presentationscheduled")).toBe(
      "appointmentscheduled",
    );
    // A record that arrived after the time had no name then.
    const arrived = [change("c3", null, "Acme Robotics", "2026-11-21T09:00:00Z")];
    expect(valueFromHistory(arrived, at("2026-11-20T00:00:00Z"), "Acme Robotics")).toBeNull();
  });

  it("else the value now, for a field with no history", () => {
    expect(valueFromHistory([], at("2026-11-19T00:00:00Z"), 112_000)).toBe(112_000);
    expect(valueFromHistory([], at("2026-11-19T00:00:00Z"), null)).toBeNull();
  });

  it("orders changes at the same instant by id, whatever order they come in", () => {
    const same = [
      change("b", "two", "three", "2026-11-18T12:00:00Z"),
      change("a", "one", "two", "2026-11-18T12:00:00Z"),
    ];
    expect(valueFromHistory(same, at("2026-11-19T00:00:00Z"), "three")).toBe("three");
    expect(valueFromHistory(same, at("2026-11-17T00:00:00Z"), "three")).toBe("one");
  });
});

describe("valueAt", () => {
  const ACME = rowId("a", 3);

  async function record(changes: { field: string; old: unknown; next: unknown; when: string }[]) {
    await withTenant(db, A, (tx) =>
      recordCrmChanges(
        tx,
        changes.map((c) => ({
          entityId: ACME,
          field: c.field,
          old: c.old as FieldChange["old"],
          new: c.next as FieldChange["new"],
          source: "demo",
          changedAt: at(c.when),
        })),
      ),
    );
  }

  it("reads a property's value at any time, by the three cases", async () => {
    await db
      .update(crmEntities)
      .set({ properties: { stage: "presentationscheduled" } })
      .where(eq(crmEntities.id, ACME));
    await record([
      {
        field: "stage",
        old: "appointmentscheduled",
        next: "qualifiedtobuy",
        when: "2026-11-18T12:00:00Z",
      },
      {
        field: "stage",
        old: "qualifiedtobuy",
        next: "presentationscheduled",
        when: "2026-11-20T12:00:00Z",
      },
    ]);
    const stageAt = (iso: string) => withTenant(db, A, (tx) => valueAt(tx, ACME, "stage", at(iso)));
    expect(await stageAt("2026-11-19T00:00:00Z")).toBe("qualifiedtobuy");
    expect(await stageAt("2026-11-01T00:00:00Z")).toBe("appointmentscheduled");
    expect(await stageAt("2026-11-24T00:00:00Z")).toBe("presentationscheduled");
    // A property with no history is its value now, or null when the record doesn't hold it.
    expect(
      await withTenant(db, A, (tx) => valueAt(tx, ACME, "industry", at("2026-11-19T00:00:00Z"))),
    ).toBeNull();
  });

  it("reads the name, which the seed renamed from Acme Corp", async () => {
    const nameAt = (iso: string) => withTenant(db, A, (tx) => valueAt(tx, ACME, "name", at(iso)));
    expect(await nameAt("2026-11-01T00:00:00Z")).toBe("Acme Corp");
    expect(await nameAt("2026-11-15T00:00:00Z")).toBe("Acme");
  });

  it("knows no record of another workspace's, nor one that isn't there", async () => {
    const when = at("2026-11-19T00:00:00Z");
    expect(
      await withTenant(db, A, (tx) => valueAt(tx, rowId("b", 3), "city", when)),
    ).toBeUndefined();
    expect(await withTenant(db, B, (tx) => valueAt(tx, rowId("b", 3), "city", when))).toBe(
      "Lisbon",
    );
    expect(
      await withTenant(db, A, (tx) =>
        valueAt(tx, "a0000000-0000-4000-8000-0000000000ff", "name", when),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(db, A, (tx) => valueAt(tx, "not-a-uuid", "name", when)),
    ).toBeUndefined();
  });

  it("refuses to run outside withTenant, where RLS wouldn't apply", async () => {
    await expect(
      db.transaction((tx) => valueAt(tx, ACME, "name", at("2026-11-19T00:00:00Z"))),
    ).rejects.toThrow(/withTenant/);
  });
});

describe("readFieldHistory", () => {
  it("reads every field asked for in one query, oldest first, and only the workspace's own", async () => {
    const ACME = rowId("a", 3);
    await withTenant(db, A, (tx) =>
      recordCrmChanges(tx, [
        {
          entityId: ACME,
          field: "stage",
          old: "b",
          new: "c",
          source: "demo",
          changedAt: at("2026-11-20T00:00:00Z"),
        },
        {
          entityId: ACME,
          field: "stage",
          old: "a",
          new: "b",
          source: "demo",
          changedAt: at("2026-11-19T00:00:00Z"),
        },
        {
          entityId: ACME,
          field: "amount",
          old: 10,
          new: 11,
          source: "sync",
          changedAt: at("2026-11-19T00:00:00Z"),
        },
      ]),
    );
    const history = await withTenant(db, A, (tx) =>
      readFieldHistory(tx, [
        { entityId: ACME, field: "stage" },
        { entityId: ACME, field: "name" },
        // B's record: RLS hides its history from A.
        { entityId: rowId("b", 3), field: "city" },
        // Amounts are asked for, but not Acme's: its amount change stays out of the answer.
        { entityId: rowId("b", 3), field: "amount" },
      ]),
    );
    expect(history.get(fieldKey({ entityId: ACME, field: "stage" }))?.map((c) => c.new)).toEqual([
      "b",
      "c",
    ]);
    expect(history.get(fieldKey({ entityId: ACME, field: "name" }))?.map((c) => c.old)).toEqual([
      "Acme Corp",
    ]);
    expect(history.has(fieldKey({ entityId: ACME, field: "amount" }))).toBe(false);
    expect(history.has(fieldKey({ entityId: rowId("b", 3), field: "city" }))).toBe(false);
    expect(await withTenant(db, A, (tx) => readFieldHistory(tx, []))).toEqual(new Map());
  });
});

describe("recordCrmChanges", () => {
  it("appends changes, with no value as SQL NULL, and refuses an unknown source", async () => {
    const [id] = await withTenant(db, A, (tx) =>
      recordCrmChanges(tx, [
        { entityId: rowId("a", 3), field: "industry", old: null, new: "Robotics", source: "demo" },
      ]),
    );
    const [row] = await db
      .select({
        oldIsNull: sql<boolean>`${crmEntityChanges.old} is null`,
        next: crmEntityChanges.new,
      })
      .from(crmEntityChanges)
      .where(eq(crmEntityChanges.id, id as string));
    expect(row).toEqual({ oldIsNull: true, next: "Robotics" });
    await expect(
      withTenant(db, A, (tx) =>
        recordCrmChanges(tx, [
          {
            entityId: rowId("a", 3),
            field: "industry",
            old: null,
            new: "x",
            source: "import" as "demo",
          },
        ]),
      ),
    ).rejects.toThrow(/demo or sync/);
  });

  it("can't write into another workspace's history, even naming its record", async () => {
    const error = await withTenant(db, A, (tx) =>
      recordCrmChanges(tx, [
        { entityId: rowId("b", 3), field: "city", old: "Lisbon", new: "Porto", source: "demo" },
      ]),
    ).catch((e: unknown) => e);
    expect(String((error as { cause?: unknown })?.cause ?? error)).toMatch(/foreign key/);
  });
});
