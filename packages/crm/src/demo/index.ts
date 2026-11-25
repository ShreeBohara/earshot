// @earshot/crm/demo (Phase 6 spec WP2; docs/adr/0041): the demo CRM as a CRM. Its adapter, its
// schema and mapping, the store it writes through (which `@earshot/db` implements over a workspace's
// demo rows), and the API that serves the store to the adapter. Worker-safe: the outbox runs it.
export { DEMO_COLUMN, demoAdapter, demoSpecs } from "./adapter";
export {
  DEMO_API_BASE,
  DEMO_MAX_BODY_CHARS,
  DEMO_MAX_PAGE,
  type DemoApiOptions,
  demoContext,
  demoFetch,
  demoPath,
} from "./api";
export {
  DEMO_CAPABILITIES,
  DEMO_MAPPING,
  DEMO_PIPELINE,
  DEMO_SCHEMA,
  DEMO_STAGES,
} from "./schema";
export type {
  DemoActivity,
  DemoActivityKind,
  DemoCursor,
  DemoRecord,
  DemoRecordKind,
  DemoStore,
  DemoValue,
} from "./store";
