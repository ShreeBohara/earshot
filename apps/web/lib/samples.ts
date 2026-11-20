// Sample debriefs (Phase 5 spec decision 17, WP3, WP7): sealed session logs that Settings → Data
// loads into the workspace with `importSessionLog`, so the inbox has proposals to review without a
// debrief. Bundled as strings (the *.jsonl rule in next.config.ts).
//
// "Load sample debriefs" loads pilot.v1's ten sessions (WP7): the review pilot's 40 cards, its four
// flagged and four silent wrong accounts included, so the inbox can be tried, and checked with a
// screen reader (WP16), on exactly what the pilot shows. WP3's two small debriefs stay for the
// inbox's end-to-end tests, development only: they hold a card in every tier in seven cards.

import s01 from "@earshot/evals/pilot/pilot.v1/s01.jsonl";
import s02 from "@earshot/evals/pilot/pilot.v1/s02.jsonl";
import s03 from "@earshot/evals/pilot/pilot.v1/s03.jsonl";
import s04 from "@earshot/evals/pilot/pilot.v1/s04.jsonl";
import s05 from "@earshot/evals/pilot/pilot.v1/s05.jsonl";
import s06 from "@earshot/evals/pilot/pilot.v1/s06.jsonl";
import s07 from "@earshot/evals/pilot/pilot.v1/s07.jsonl";
import s08 from "@earshot/evals/pilot/pilot.v1/s08.jsonl";
import s09 from "@earshot/evals/pilot/pilot.v1/s09.jsonl";
import s10 from "@earshot/evals/pilot/pilot.v1/s10.jsonl";
import acmeDynamics from "@earshot/events/fixtures/samples/acme-dynamics.jsonl";
import pierLogistics from "@earshot/events/fixtures/samples/pier-logistics.jsonl";
import zenythFinishing from "@earshot/events/fixtures/samples/zenyth-finishing.jsonl";

export interface SampleDebrief {
  readonly name: string;
  readonly jsonl: string;
}

/** pilot.v1's ten sessions, s01 to s10 (packages/evals/pilot/pilot.v1). */
export const SAMPLE_DEBRIEFS: readonly SampleDebrief[] = [
  { name: "pilot.v1 s01", jsonl: s01 },
  { name: "pilot.v1 s02", jsonl: s02 },
  { name: "pilot.v1 s03", jsonl: s03 },
  { name: "pilot.v1 s04", jsonl: s04 },
  { name: "pilot.v1 s05", jsonl: s05 },
  { name: "pilot.v1 s06", jsonl: s06 },
  { name: "pilot.v1 s07", jsonl: s07 },
  { name: "pilot.v1 s08", jsonl: s08 },
  { name: "pilot.v1 s09", jsonl: s09 },
  { name: "pilot.v1 s10", jsonl: s10 },
];

/**
 * Development only: WP3's two debriefs (packages/events/fixtures/samples), seven cards with one in
 * every tier, which the inbox's end-to-end tests review by name.
 */
export const TEST_DEBRIEFS: readonly SampleDebrief[] = [
  { name: "Acme Dynamics", jsonl: acmeDynamics },
  { name: "Pier Logistics", jsonl: pierLogistics },
];

/**
 * Development only (WP5): a debrief that ended but never sealed, loaded unsealed, so the inbox
 * shows "Finishing" without a flush, which zero-setup development doesn't run. The repair path
 * seals it once it's been finishing for 10 minutes and its Durable Object holds nothing.
 */
export const FINISHING_SAMPLE: SampleDebrief = {
  name: "Zenyth Packaging",
  jsonl: zenythFinishing,
};
