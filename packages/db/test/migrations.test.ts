import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { readDbHealth, stampBranch } from "../src/health";
import * as schema from "../src/schema";

// The real SQL migrations run against Postgres compiled to WebAssembly, so CI needs no database.
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

async function freshDb() {
  const client = new PGlite({ extensions: { vector, pg_trgm } });
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  return { client, db };
}

describe("migrations", () => {
  it("apply cleanly and enable pgvector and pg_trgm", async () => {
    const { client } = await freshDb();
    const { rows } = await client.query<{ extname: string }>(
      "SELECT extname FROM pg_extension ORDER BY extname",
    );
    expect(rows.map((r) => r.extname)).toEqual(expect.arrayContaining(["pg_trgm", "vector"]));
  });

  it("report the stamped branch and the applied migration count", async () => {
    const { db } = await freshDb();
    await stampBranch(db, "preview/pr-1");
    await stampBranch(db, "preview/pr-1"); // stamping twice is safe
    expect(await readDbHealth(db)).toEqual({
      status: "ok",
      branch: "preview/pr-1",
      migrations: 2,
    });
  });

  it("report no branch before one is stamped", async () => {
    const { db } = await freshDb();
    expect(await readDbHealth(db)).toEqual({ status: "ok", migrations: 2 });
  });
});
