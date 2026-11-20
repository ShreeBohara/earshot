// Writes smoke.json: the live smoke eval's 30 scripts, picked from the 200 debriefs by the seeded
// greedy pick in src/smoke/select.ts, with what they hold (Phase 4 WP11 step 1). A test re-runs
// the pick and compares it with the committed file, so run this after changing the debriefs or
// the pick, review the diff, and record the smoke baseline again (`baseline:smoke`): the baseline
// is tied to the scripts.
//
//   pnpm --filter @earshot/evals smoke:select
import { writeFileSync } from "node:fs";
import { buildSmokeSet, serializeSmokeSet } from "../src/smoke";
import { ALL_DEBRIEFS } from "../src/understanding";
import { run } from "./args";
import { SMOKE_FILE } from "./smoke-io";

run(() => {
  const set = buildSmokeSet(ALL_DEBRIEFS);
  writeFileSync(SMOKE_FILE, serializeSmokeSet(set));
  console.log(
    `Wrote packages/evals/smoke.json: ${set.scripts.length} scripts, ${set.strata.turns} turns, ${set.strata.proposals} proposals.`,
  );
});
