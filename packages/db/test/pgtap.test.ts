import { readdirSync, readFileSync } from "node:fs";
import type { PGliteInterface, Results } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seededDb } from "./db";

// Runs every test/pgtap/*.sql file against the migrated schema and the two-workspace seed,
// each in a fresh copy of the database. A file passes when its TAP output has a plan, no
// "not ok" line, and as many results as it planned.
const dir = new URL("./pgtap/", import.meta.url);
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const TAP_LINE = /^(ok \d|not ok \d|1\.\.\d|#)/;

/** pgTAP's functions return their TAP lines as text values; other result sets are noise. */
function tapLines(results: Results[]): string[] {
  return results.flatMap((result) =>
    result.rows.flatMap((row) => {
      const values = Object.values(row as Record<string, unknown>);
      const [value] = values;
      return values.length === 1 && typeof value === "string" && TAP_LINE.test(value)
        ? value.split("\n")
        : [];
    }),
  );
}

/** What's wrong with a TAP stream, if anything. */
function problems(tap: string[]): string[] {
  const plan = tap.find((line) => /^1\.\.\d+$/.test(line));
  const ran = tap.filter((line) => /^(not )?ok \d+/.test(line)).length;
  return [
    ...(plan ? [] : ["no plan"]),
    ...(plan && Number(plan.slice(3)) !== ran ? [`planned ${plan.slice(3)}, ran ${ran}`] : []),
    ...tap.filter((line) => line.startsWith("not ok") || line.startsWith("# Looks like")),
  ];
}

let template: PGliteInterface;

beforeAll(async () => {
  const { client } = await seededDb({ pgtap: true });
  await client.exec("create extension pgtap");
  template = client;
});

afterAll(async () => {
  await template?.close();
});

describe("pgTAP", () => {
  it.each(files)("%s", async (file) => {
    // A clone is a fresh session: no setting left over from another file.
    const db = await template.clone();
    try {
      const tap = tapLines(await db.exec(readFileSync(new URL(file, dir), "utf8")));
      expect(problems(tap), `TAP output of ${file}:\n${tap.join("\n")}`).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
