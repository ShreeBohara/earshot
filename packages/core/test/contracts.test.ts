import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ContractName, contracts } from "../src";

// The same fixtures run through Pydantic in lab/tests/test_contracts.py.
// If one language accepts what the other rejects, one of the two suites fails.
const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

type Fixture = { file: string; name: string; data: unknown };

function load(kind: "valid" | "invalid"): Fixture[] {
  return readdirSync(join(fixturesDir, kind))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      name: file.split(".")[0] ?? "",
      data: JSON.parse(readFileSync(join(fixturesDir, kind, file), "utf8")) as unknown,
    }));
}

function schemaFor(name: string) {
  const schema = contracts[name as ContractName];
  if (!schema) throw new Error(`no contract named ${name}`);
  return schema;
}

describe("valid fixtures", () => {
  it.each(load("valid"))("$file parses", ({ name, data }) => {
    const result = schemaFor(name).safeParse(data);
    expect(result.error?.issues ?? []).toEqual([]);
  });
});

describe("invalid fixtures", () => {
  it.each(load("invalid"))("$file is rejected", ({ name, data }) => {
    expect(schemaFor(name).safeParse(data).success).toBe(false);
  });
});

describe("coverage", () => {
  it("every contract has at least one valid fixture", () => {
    const covered = new Set(load("valid").map((f) => f.name));
    for (const name of Object.keys(contracts)) expect(covered).toContain(name);
  });
});
