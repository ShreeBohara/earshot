// Sample debriefs (Phase 5 spec decision 17, WP3): sealed session logs that Settings → Data loads
// into the workspace with `importSessionLog`, so the inbox has proposals to review without a
// debrief. Bundled as strings (the *.jsonl rule in next.config.ts). WP3 ships these two; WP7
// switches the list to the pilot set.
import acmeDynamics from "@earshot/events/fixtures/samples/acme-dynamics.jsonl";
import pierLogistics from "@earshot/events/fixtures/samples/pier-logistics.jsonl";

export const SAMPLE_DEBRIEFS: readonly { readonly name: string; readonly jsonl: string }[] = [
  { name: "Acme Dynamics", jsonl: acmeDynamics },
  { name: "Pier Logistics", jsonl: pierLogistics },
];
