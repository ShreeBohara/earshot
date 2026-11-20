// `similarity` and `wordSimilarity` against pg_trgm itself: 200 pairs through PGlite (PostgreSQL
// 18.6, the pg_trgm contrib module), within 1e-6. Postgres returns `real`, so the doubles here
// differ from it in the eighth digit at most. The pairs are the measured ones from Appendix A,
// hand-picked edge cases, and seeded mishearings of made-up names.
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { similarity, trigrams, wordSimilarity } from "../src/names";
import { MEASURED_PAIRS } from "../src/testing";
import { mulberry32, mutateName, randomName } from "./support/random";

const TOLERANCE = 1e-6;

const EDGE_CASES: [string, string][] = [
  ["", ""],
  ["", "Acme"],
  ["a", "a"],
  ["x", "xyz"],
  ["!!!", "Acme"],
  ["Acme, Inc.", "acme inc"],
  ["ACME DYNAMICS", "acme dynamics"],
  ["Maple & Vine Grocers", "Maple and Vine"],
  ["O'Brien & Sons, Inc.", "OBrien and Sons"],
  ["abc_def", "abc def"],
  ["abc abc abd", "abd"],
  ["abd", "abc abc abd"],
  ["ab ab ab", "ab"],
  ["northwind northwind", "Northwind Labs"],
  ["Route 66 Logistics", "Route 66"],
  ["3M", "3 M"],
  ["Glow Vex", "Glovex Systems"],
  ["Nite Security Group", "Knight Security"],
  ["Pier Logistics", "Peer Logistics"],
  ["Summit Ridge Capital", "Summit Peak Capital"],
  ["Redwood Robotics", "Redwood Analytics"],
  ["Harborview Health - Multi-year agreement", "Harborview"],
  ["Meridian Supply Co", "MSC"],
  ["Consolidated Parts & Supply", "CPS"],
  ["a b c d e f g", "abcdefg"],
  ["   spaced    out   ", "spaced out"],
  ["Dana", "Dana Lee Dana Li Dana"],
  ["Dana Lee", "Lee Dana"],
  ["café", "cafe"],
  ["CAFÉ", "café"],
  ["Zoë Park", "Zoe Park"],
  ["Ärger", "ärger"],
  ["naïve", "naive"],
  ["José Muñoz", "Jose Munoz"],
  ["Müller", "Mueller"],
];

function buildPairs(): [string, string][] {
  const pairs: [string, string][] = [
    ...MEASURED_PAIRS.map((pair): [string, string] => [pair.left, pair.right]),
    ...EDGE_CASES,
  ];
  const random = mulberry32(20261119);
  while (pairs.length < 200) {
    const name = randomName(random);
    pairs.push([name, random() < 0.8 ? mutateName(random, name) : randomName(random)]);
  }
  return pairs;
}

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec("create extension pg_trgm");
});

afterAll(async () => {
  await pg.close();
});

interface PgScores {
  similarity: number;
  forward: number;
  backward: number;
  trigrams: string[];
}

describe("parity with pg_trgm on PGlite", () => {
  it("agrees on similarity and word_similarity, both ways, for 200 pairs", async () => {
    const pairs = buildPairs();
    expect(pairs).toHaveLength(200);

    const mismatches: string[] = [];
    let worst = 0;
    for (const [a, b] of pairs) {
      const { rows } = await pg.query<PgScores>(
        `select similarity($1, $2) as similarity, word_similarity($1, $2) as forward,
                word_similarity($2, $1) as backward, show_trgm($1) as trigrams`,
        [a, b],
      );
      const pgScores = rows[0];
      if (!pgScores) throw new Error("no row");
      const ours = {
        similarity: similarity(a, b),
        forward: wordSimilarity(a, b),
        backward: wordSimilarity(b, a),
      };
      for (const key of ["similarity", "forward", "backward"] as const) {
        const gap = Math.abs(ours[key] - pgScores[key]);
        worst = Math.max(worst, gap);
        if (gap > TOLERANCE) {
          mismatches.push(
            `${key}(${JSON.stringify(a)}, ${JSON.stringify(b)}): ${ours[key]} vs ${pgScores[key]}`,
          );
        }
      }
      // Postgres shows multibyte trigrams as hashes, so the sets compare for ASCII text only.
      if (/^\p{ASCII}*$/u.test(a)) expect(trigrams(a), a).toEqual([...pgScores.trigrams].sort());
    }
    expect(mismatches).toEqual([]);
    expect(worst).toBeLessThanOrEqual(TOLERANCE);
  });
});
