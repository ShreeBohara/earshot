// The demo CRM's conformance options (Phase 6 WP2), one set for both of its runs: on a store in
// memory (`@earshot/crm`'s tests) and on Postgres through PGlite (`@earshot/db`'s), against the same
// golden plans and requests, with the same reasons for what the demo CRM can't do.
import { DEMO_API_BASE, DEMO_MAX_PAGE, DEMO_SCHEMA } from "../demo";
import type { ConformanceOptions, SentRequest } from "./suite";

/** The demo API's documented page size: no request may ask for more. */
export function demoLimits(request: SentRequest): string | null {
  const limit = new URL(request.url).searchParams.get("limit");
  return limit !== null && Number(limit) > DEMO_MAX_PAGE
    ? `asks for ${limit}, over ${DEMO_MAX_PAGE}`
    : null;
}

/**
 * The demo CRM's options: golden files in `goldenDir` (`packages/crm/test/golden/demo`), planned
 * against the demo schema and the dataset's first company, contact, and deal, and what it can't do.
 */
export function demoConformanceOptions(
  goldenDir: string,
  overrides: Partial<ConformanceOptions> = {},
): ConformanceOptions {
  return {
    name: "the demo CRM",
    golden: {
      dir: goldenDir,
      schema: DEMO_SCHEMA,
      render: { connection: { id: null, accountId: "demo", apiBase: DEMO_API_BASE } },
      refs: {
        company: { object: "company", id: "co_001", url: null },
        contact: { object: "contact", id: "ct_001", url: null },
        deal: { object: "deal", id: "deal_001", url: null },
      },
    },
    changesPageSize: 3,
    limits: demoLimits,
    cannot: {
      actor: "the demo CRM has no users, so its writes carry no one's name",
      auth: "the demo CRM takes no credential",
      rateLimit: "the demo CRM never leaves Postgres, so nothing limits it",
      deletes: "the demo CRM keeps nothing of a deleted row",
    },
    ...overrides,
  };
}
