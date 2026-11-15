import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readDbHealth, stampBranch } from "../src/health";
import { migratedDb, seededDb } from "./db";

const journal: { entries: unknown[] } = JSON.parse(
  readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
);

describe("migrations", () => {
  it("apply cleanly and enable pgvector and pg_trgm", async () => {
    const { client } = await migratedDb();
    const { rows } = await client.query<{ extname: string }>(
      "SELECT extname FROM pg_extension ORDER BY extname",
    );
    expect(rows.map((r) => r.extname)).toEqual(expect.arrayContaining(["pg_trgm", "vector"]));
  });

  it("report the stamped branch and the applied migration count", async () => {
    const { db } = await migratedDb();
    await stampBranch(db, "preview/pr-1");
    await stampBranch(db, "preview/pr-1"); // stamping twice is safe
    expect(await readDbHealth(db)).toEqual({
      status: "ok",
      branch: "preview/pr-1",
      migrations: journal.entries.length,
    });
  });

  it("report no branch before one is stamped", async () => {
    const { db } = await migratedDb();
    expect(await readDbHealth(db)).toEqual({ status: "ok", migrations: journal.entries.length });
  });

  it("index entity names for trigram search and embeddings for HNSW search", async () => {
    const { client } = await seededDb();
    await client.exec("SET enable_seqscan = off");
    const plan = async (query: string) => {
      const { rows } = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${query}`);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    };

    expect(await plan("SELECT id FROM crm_entities WHERE name % 'Acme'")).toContain(
      "crm_entities_name_trgm_idx",
    );
    expect(
      await plan(
        "SELECT id FROM crm_entities ORDER BY embedding <=> array_fill(0.3::real, ARRAY[512])::halfvec LIMIT 5",
      ),
    ).toContain("crm_entities_embedding_hnsw_idx");
  });
});
