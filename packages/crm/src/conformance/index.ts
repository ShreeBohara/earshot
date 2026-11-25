// @earshot/crm/conformance (Phase 6 spec §4.2; docs/adr/0041): the suite every adapter passes, as a
// Vitest `describe` builder. `runConformance(adapterFactory, harness, options)` adds §4.2's nine
// groups (connection; plans against committed golden plans and requests; writes; twice; lost
// responses; live checks; errors; changes across page boundaries; limits and secrets) to the test
// file that calls it. Node only, under Vitest: no Worker imports it.
import { afterAll, beforeAll, describe, it } from "vitest";
import type { CrmAdapter } from "../adapter";
import type { ConformanceHarness } from "../testing/harness";
import { type ConformanceOptions, conformanceSuite } from "./suite";

export { CASES, type Case, type CaseTarget, type CaseWorld, caseInput } from "./cases";
export {
  type Check,
  type CheckGroup,
  type ConformanceOptions,
  type ConformanceSuite,
  conformanceSuite,
  type GoldenOptions,
  type Inability,
  type SentRequest,
} from "./suite";

/** How long setup and teardown may take: a live CRM's fixtures are slower than memory's. */
const HOOK_TIMEOUT_MS = 120_000;

/**
 * Adds the conformance suite for one adapter to the calling test file: a `describe` per group, an
 * `it` per check, each skipped check's reason in its name. The adapter comes from a factory, and the
 * CRM's fixtures, raw reads, and edits from the harness (`@earshot/crm/testing`).
 */
export function runConformance(
  adapterFactory: () => CrmAdapter,
  harness: ConformanceHarness,
  options: ConformanceOptions,
): void {
  const suite = conformanceSuite(adapterFactory, harness, options);
  describe(suite.title, () => {
    beforeAll(() => suite.setup(), HOOK_TIMEOUT_MS);
    afterAll(() => suite.teardown(), HOOK_TIMEOUT_MS);
    for (const group of suite.groups) {
      describe(group.title, () => {
        for (const check of group.checks) {
          if (check.skip !== null) {
            it.skip(`${check.name} (skipped: ${check.skip})`, () => {});
          } else {
            it(check.name, check.run, options.timeoutMs ?? 30_000);
          }
        }
      });
    }
  });
}
