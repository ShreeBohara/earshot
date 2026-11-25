// The demo CRM's schema and mapping (Phase 6 spec WP2): its stages are the demo dataset's, HubSpot's
// defaults, in pipeline order, with the labels the inbox shows; it has no owners. There's no
// connection, so no `crm_mappings` row: its mapping is made here, each stage known by its label and
// by the id the demo rows hold (which "Keep the CRM's" can put back in a card's stage).
import type { CrmMapping } from "@earshot/core";
import type { Capabilities, CrmSchema, CrmStage } from "../adapter";
import { defaultMapping } from "../plan/mapping";

/** The demo CRM's one pipeline. */
export const DEMO_PIPELINE = "default";

/**
 * The demo dataset's deal stages (`DEAL_STAGES` in `@earshot/demo-crm`, restated here so the edge
 * Worker doesn't import the dataset; `@earshot/db`'s tests hold the two lists together), with the
 * inbox's labels for them.
 */
export const DEMO_STAGES: readonly CrmStage[] = [
  { stageId: "appointmentscheduled", pipelineId: DEMO_PIPELINE, label: "Appointment scheduled" },
  { stageId: "qualifiedtobuy", pipelineId: DEMO_PIPELINE, label: "Qualified to buy" },
  { stageId: "presentationscheduled", pipelineId: DEMO_PIPELINE, label: "Presentation scheduled" },
  {
    stageId: "decisionmakerboughtin",
    pipelineId: DEMO_PIPELINE,
    label: "Decision maker bought in",
  },
  { stageId: "contractsent", pipelineId: DEMO_PIPELINE, label: "Contract sent" },
  { stageId: "closedwon", pipelineId: DEMO_PIPELINE, label: "Closed won" },
  { stageId: "closedlost", pipelineId: DEMO_PIPELINE, label: "Closed lost" },
];

/** What the demo CRM can do: everything but owners, each write upserted by its marker. */
export const DEMO_CAPABILITIES: Capabilities = {
  objects: { company: true, contact: true, deal: true, note: true, task: true, meeting: true },
  idempotency: { records: "upsert", activities: "upsert" },
  associations: "inline",
  changes: "modified_since",
  webhooks: false,
  owners: false,
  attribution: "key",
};

/** The demo CRM's schema: its stages, no owners, and its association types. */
export const DEMO_SCHEMA: CrmSchema = {
  stages: DEMO_STAGES,
  owners: [],
  associations: [
    { from: "contact", to: "company", type: "companyId" },
    { from: "deal", to: "company", type: "companyId" },
    ...(["note", "task", "meeting"] as const).flatMap((from) =>
      (["company", "contact", "deal"] as const).map((to) => ({ from, to, type: "record" })),
    ),
  ],
  properties: (["company", "contact", "deal"] as const).map((object) => ({
    object,
    name: "writeId",
    unique: true,
  })),
};

/** The demo CRM's mapping: each stage by its label and its id, new deals in its one pipeline. */
export const DEMO_MAPPING: CrmMapping = defaultMapping(DEMO_SCHEMA, DEMO_CAPABILITIES, {
  words: Object.fromEntries(DEMO_STAGES.map((stage) => [stage.stageId, [stage.stageId]])),
});
