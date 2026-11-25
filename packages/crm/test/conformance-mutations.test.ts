// The conformance suite fails adapters it should (Phase 6 WP2's mutation tests): one that lands a
// write twice on a retry, one that leaks the credential in an error, one that ignores a page
// boundary in `changes`, and one whose `requests()` isn't what `execute` sends. Each is MemoryCrm's
// own adapter with one thing broken; the unbroken adapter passes the same checks, as the control.
import { describe, expect, it } from "vitest";
import {
  type CrmAdapter,
  CrmError,
  type CrmValue,
  outcomeRef,
  previewOf,
  previewRef,
  requestOf,
} from "../src";
import { CASES, type Check, conformanceSuite, type SentRequest } from "../src/conformance";
import { MemoryCrm, type MemoryCrmOptions, memoryCrmAdapter, memorySpecs } from "../src/testing";

const limits = (request: SentRequest) =>
  Number(new URL(request.url).searchParams.get("limit") ?? 0) > 100 ? "over 100" : null;

/** A suite on a fresh MemoryCrm, with an adapter made from MemoryCrm's own by `breaking` it. */
async function suiteWith(
  options: MemoryCrmOptions,
  breaking: (adapter: CrmAdapter, crm: MemoryCrm) => CrmAdapter,
) {
  const crm = new MemoryCrm({ ...options, pageSize: 3 });
  const adapter = breaking(
    memoryCrmAdapter({ provider: crm.provider, capabilities: crm.capabilities }),
    crm,
  );
  const suite = conformanceSuite(() => adapter, crm.harness(), {
    changesPageSize: 3,
    limits,
    cannot: { golden: "not under test here" },
  });
  await suite.setup();
  const checks = (group: string, starts = ""): Check[] =>
    suite.groups
      .filter((candidate) => candidate.id === group)
      .flatMap((candidate) => candidate.checks)
      .filter((candidate) => candidate.name.startsWith(starts));
  return { crm, checks };
}

/** Each check's failure, or null where it passed. */
async function outcomes(checks: readonly Check[]): Promise<(string | null)[]> {
  const results: (string | null)[] = [];
  for (const check of checks) {
    try {
      await check.run();
      results.push(null);
    } catch (error) {
      results.push(error instanceof Error ? error.message : String(error));
    }
  }
  return results;
}

const unbroken = (adapter: CrmAdapter) => adapter;

/** The cases that only update a record, which a repeat can't double. */
const UPDATES = ["contact.linked", "deal_update.linked"];

describe("the suite fails an adapter that lands a write twice on a retry", () => {
  // It looks its first try up through search, which lags (decision 7: never through search), and
  // creates when search sees nothing.
  const searching = (adapter: CrmAdapter): CrmAdapter => ({
    ...adapter,
    async execute(write, done, ctx) {
      if (write.op !== "create") return adapter.execute(write, done, ctx);
      const query = `/v1/search?object=${write.object}&q=${encodeURIComponent(write.marker)}`;
      const search = await ctx.fetch(new Request(`${ctx.connection.apiBase}${query}`), {
        kind: "search",
      });
      const { results } = (await search.json()) as { results: { id: string }[] };
      const ref = (id: string) => ({ object: write.object, id, url: null });
      if (results[0]) return { index: write.index, op: "found", ref: ref(results[0].id) };
      const [spec] = memorySpecs(write, (link) => outcomeRef(link, done), adapter.capabilities);
      if (spec === undefined) throw new Error("a create has a request");
      const response = await ctx.fetch(requestOf(spec, ctx), { kind: "write" });
      const { id } = (await response.json()) as { id: string };
      return { index: write.index, op: "created", ref: ref(id) };
    },
  });
  const readback: MemoryCrmOptions = {
    idempotency: { records: "readback", activities: "readback" },
  };

  it("fails twice and lost responses for every case that creates a record", async () => {
    const broken = await suiteWith(readback, searching);
    // Every case that creates a record fails; the two linked updates repeat harmlessly.
    const creates = CASES.map((caseItem) => !UPDATES.includes(caseItem.id));
    for (const group of ["twice", "lost"]) {
      const failures = await outcomes(broken.checks(group));
      expect(
        failures.map((failure) => failure !== null),
        group,
      ).toEqual(creates);
    }
  });

  it("passes them unbroken", async () => {
    const control = await suiteWith(readback, unbroken);
    expect(await outcomes(control.checks("twice"))).toEqual(Array(12).fill(null));
    expect(await outcomes(control.checks("lost"))).toEqual(Array(12).fill(null));
  });
});

describe("the suite fails an adapter that leaks the credential in an error", () => {
  // Careless: an error quotes the CRM's answer, which can hold the credential.
  const quoting = (adapter: CrmAdapter, crm: MemoryCrm): CrmAdapter => ({
    ...adapter,
    async verify(ctx) {
      const response = await ctx.fetch(new Request(`${ctx.connection.apiBase}/v1/account`), {
        kind: "read",
      });
      if (!response.ok)
        throw new CrmError("unknown", `${crm.provider} said ${await response.text()}`);
      return adapter.verify(ctx);
    },
  });

  it("fails the secrets check", async () => {
    const broken = await suiteWith({}, quoting);
    const [failure] = await outcomes(broken.checks("limits", "nothing thrown"));
    expect(failure).toMatch(/expected true to be false/);
  });

  it("passes it unbroken, though the CRM quotes the credential back", async () => {
    const control = await suiteWith({}, unbroken);
    expect(await outcomes(control.checks("limits", "nothing thrown"))).toEqual([null]);
  });
});

describe("the suite fails an adapter that ignores a page boundary in changes", () => {
  // It reads one page and says there's no more.
  const onePage = (adapter: CrmAdapter): CrmAdapter => ({
    ...adapter,
    async changes(cursor, ctx) {
      const page = await adapter.changes(cursor, ctx);
      return { ...page, more: false };
    },
  });

  it("fails the changes check: records past the first page are lost", async () => {
    const broken = await suiteWith({}, onePage);
    const [failure] = await outcomes(broken.checks("changes"));
    expect(failure).toMatch(/expected undefined to be 'changed'|deleted/);
  });

  it("passes it unbroken", async () => {
    const control = await suiteWith({}, unbroken);
    expect(await outcomes(control.checks("changes"))).toEqual([null]);
  });
});

describe("the suite fails an adapter whose requests() isn't what execute sends", () => {
  // Its preview leaves the associations out of a create's body.
  const misreporting = (adapter: CrmAdapter): CrmAdapter => ({
    ...adapter,
    requests(plan, ctx) {
      return plan.writes.flatMap((write) =>
        memorySpecs(write, (ref) => previewRef(ref, plan), adapter.capabilities).map((spec) => {
          const body = spec.body as { readonly properties?: CrmValue } | null | undefined;
          const shown: CrmValue | null =
            write.op === "create" ? { properties: body?.properties ?? {} } : (spec.body ?? null);
          return previewOf({ ...spec, body: shown }, ctx, { credential: true });
        }),
      );
    },
  });

  it("fails the writes check for every case whose create carries an association", async () => {
    const broken = await suiteWith({}, misreporting);
    const writes = await outcomes(broken.checks("writes"));
    const failed = writes.filter((failure) => failure !== null);
    // Every activity links to its record, so ten of the twelve cases fail; the linked updates don't.
    expect(failed).toHaveLength(10);
    expect(
      failed.every((failure) =>
        /what execute sent, against what requests\(\) previewed/.test(failure as string),
      ),
    ).toBe(true);
  });

  it("passes it unbroken", async () => {
    const control = await suiteWith({}, unbroken);
    expect(await outcomes(control.checks("writes"))).toEqual(Array(12).fill(null));
  });
});
