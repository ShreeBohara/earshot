// The conformance suite on the reference CRM (Phase 6 spec §4.2, WP2): it passes in each idempotency
// mode, with associations inline or separate, owners and meetings on or off, and deletes reported or
// not. Pages of three, so `changes` crosses page boundaries.
import { describe } from "vitest";
import { runConformance, type SentRequest } from "../src/conformance";
import { MemoryCrm, type MemoryCrmOptions } from "../src/testing";

/** MemoryCrm's documented page size: a request for more is a 400, and a conformance failure. */
function memoryLimits(request: SentRequest): string | null {
  const limit = new URL(request.url).searchParams.get("limit");
  return limit !== null && Number(limit) > 100 ? `asks for ${limit}, over MemoryCrm's 100` : null;
}

const NO_GOLDEN = "golden files are the demo CRM's and each real adapter's";

const RUNS: readonly { readonly name: string; readonly options: MemoryCrmOptions }[] = [
  {
    name: "MemoryCrm, upsert",
    options: { idempotency: { records: "upsert", activities: "upsert" } },
  },
  {
    name: "MemoryCrm, client_id",
    options: { idempotency: { records: "client_id", activities: "client_id" } },
  },
  {
    name: "MemoryCrm, readback",
    options: { idempotency: { records: "readback", activities: "readback" } },
  },
  {
    name: "MemoryCrm, HubSpot's shape: upsert records, readback activities, separate associations, no owners or meetings, no deletes",
    options: {
      idempotency: { records: "upsert", activities: "readback" },
      associations: "separate",
      owners: false,
      meetings: false,
      deletes: false,
    },
  },
];

describe("the conformance suite on MemoryCrm", () => {
  for (const { name, options } of RUNS) {
    const crm = new MemoryCrm({ ...options, pageSize: 3 });
    runConformance(() => crm, crm.harness(), {
      name,
      changesPageSize: 3,
      limits: memoryLimits,
      cannot: {
        golden: NO_GOLDEN,
        ...(options.deletes === false
          ? { deletes: "this MemoryCrm doesn't report deleted records" }
          : {}),
      },
    });
  }
});
