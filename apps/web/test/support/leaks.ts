// Helpers for proving a key went nowhere: everything a test can observe (responses, log lines,
// console calls, every row of every table), and a check that no eight characters of a key in a
// row appear in it.
import { type FetchLike, findSecretFragment } from "@earshot/keys/server";
import type { PGlite } from "@electric-sql/pglite";
import { expect, type Mock, vi } from "vitest";

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/** Spies on every console method, silencing them. Restore with vi.restoreAllMocks(). */
export function spyOnConsole(): Array<Mock> {
  return CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  ) as Array<Mock>;
}

/** Every argument of every console call, as text. */
export function consoleOutput(spies: ReadonlyArray<Mock>): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
}

/** A response as text: status, headers, and body. Reads a clone, so the response stays usable. */
export async function responseText(response: Response): Promise<string> {
  const headers = JSON.stringify([...response.headers]);
  return `${response.status}\n${headers}\n${await response.clone().text()}`;
}

/** Fails if any `minLength` characters in a row of any secret appear in the haystack. */
export function expectNoTrace(haystack: string, secrets: readonly string[], what = "output") {
  for (const secret of secrets) {
    expect(findSecretFragment(haystack, secret, 8), `a fragment of a key leaked into ${what}`).toBe(
      undefined,
    );
  }
}

/**
 * A provider that answers `status` and quotes the key it was sent, in its body and its headers,
 * the way some providers' error responses do.
 */
export function echoingProvider(status: number): Mock<FetchLike> {
  return vi.fn<FetchLike>(async (_url, init) => {
    const sent = Object.values(init.headers as Record<string, string>).join(" ");
    return new Response(
      JSON.stringify({ error: { message: `Incorrect API key provided: ${sent}`, key: sent } }),
      {
        status,
        headers: {
          "content-type": "application/json",
          "x-request-key": sent,
          "www-authenticate": `Bearer error="invalid_token", error_description="${sent}"`,
        },
      },
    );
  });
}

/**
 * Every value in every column of every table, as text, read as the owner (no RLS): text columns
 * cast to text, and bytea both escaped (printable bytes as themselves) and hex-encoded.
 */
export async function dumpEverything(pg: PGlite): Promise<string> {
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const { rows: tables } = await pg.query<{ schema: string; name: string }>(
    `select table_schema as schema, table_name as name from information_schema.tables
     where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
     order by 1, 2`,
  );
  expect(tables.map((t) => t.name)).toEqual(
    expect.arrayContaining(["credentials", "audit_log", "rate_limit", "session"]),
  );

  const values: string[] = [];
  for (const table of tables) {
    const { rows: columns } = await pg.query<{ name: string; type: string }>(
      `select column_name as name, data_type as type from information_schema.columns
       where table_schema = $1 and table_name = $2 order by ordinal_position`,
      [table.schema, table.name],
    );
    const exprs = columns.map(({ name, type }) =>
      type === "bytea"
        ? `encode(${quote(name)}, 'escape') || ' ' || encode(${quote(name)}, 'hex')`
        : `${quote(name)}::text`,
    );
    const { rows } = await pg.query<Record<string, string | null>>(
      `select ${exprs.map((expr, i) => `${expr} as c${i}`).join(", ")}
       from ${quote(table.schema)}.${quote(table.name)}`,
    );
    for (const row of rows) values.push(...Object.values(row).map((v) => v ?? ""));
  }
  return values.join("\n");
}
